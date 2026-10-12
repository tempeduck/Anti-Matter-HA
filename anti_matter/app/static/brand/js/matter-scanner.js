/**
 * Camera / photo QR scanner for Matter codes.
 */
(function (global) {
  let stream = null;
  let scanTimerId = null;
  let html5Instance = null;
  let currentTrack = null;
  let torchIsOn = false;
  let cameraGeneration = 0;
  let libraryPromise = null;

  async function stopCamera() {
    cameraGeneration++;
    if (scanTimerId) {
      clearTimeout(scanTimerId);
      scanTimerId = null;
    }
    // Stopping a track while its torch is still on crashes the camera HAL on some
    // Android phones — the tab's renderer/GPU process dies and Chrome silently
    // reloads it, which looks like the whole page crashed right after a scan
    // (torch off -> stop is the safe order; stop -> torch off is not, on those
    // devices). Always turn it off first and wait for it to actually apply.
    const track = currentTrack;
    const oldStream = stream;
    const oldHtml5 = html5Instance;
    const hadTorch = torchIsOn;
    currentTrack = null;
    stream = null;
    html5Instance = null;
    torchIsOn = false;
    if (track && hadTorch) {
      try {
        await track.applyConstraints({ advanced: [{ torch: false }] });
      } catch {
        /* best effort */
      }
    }
    if (oldStream) {
      oldStream.getTracks().forEach((t) => t.stop());
    }
    if (oldHtml5) {
      try { await oldHtml5.stop(); } catch { /* not started yet */ }
      await safeClear(oldHtml5);
    }
  }

  // Torch (camera flash) — only the native BarcodeDetector path exposes a raw
  // MediaStreamTrack to apply this constraint on; most desktop webcams (and the
  // html5-qrcode fallback path) never report the capability, so this is always
  // feature-detected rather than assumed available.
  function supportsTorch() {
    if (!currentTrack) return false;
    try {
      const caps = currentTrack.getCapabilities ? currentTrack.getCapabilities() : null;
      return !!(caps && caps.torch);
    } catch {
      return false;
    }
  }

  async function setTorch(on) {
    if (!currentTrack) return false;
    try {
      await currentTrack.applyConstraints({ advanced: [{ torch: on }] });
      torchIsOn = on;
      return true;
    } catch {
      return false;
    }
  }

  // Sampling every displayed frame via requestAnimationFrame (up to 60-120Hz on a
  // phone) ran detector.detect() far more often than QR scanning needs, and on
  // devices without a hardware Shape Detection backend (detect() falls back to a
  // software/WASM decoder there) that was enough sustained CPU/memory pressure to
  // crash the tab's renderer mid-scan — Chrome recovers by silently reloading the
  // page, which looked like the whole app had crashed. ~8 detections/sec (matching
  // the html5-qrcode fallback's own fps:10) is still plenty responsive for aiming
  // a phone at a QR code.
  const SCAN_INTERVAL_MS = 120;

  // Feeding detect() the raw video element hands it a full-resolution frame
  // (1080p+ on most phones) every tick, which is both slower to process and no
  // more reliable for reading a small QR code than a modest, fixed-size frame —
  // downscaling onto an offscreen canvas first cuts the per-tick workload a lot
  // (helping both scan speed and the crash risk above) and gives us pixel
  // coordinates to draw the detected-code box against.
  const DETECT_MAX_DIM = 720;

  function mapBoxToDisplay(box, canvas, video) {
    // detector.detect() ran against `canvas` (downscaled copy of the video frame),
    // but the box needs to land on top of the displayed <video>, which crops via
    // CSS `object-fit: cover` — replicate that scale-and-center math to translate
    // canvas-space coordinates into the video element's own displayed box.
    const scaleToVideo = video.videoWidth / canvas.width;
    const vx = box.x * scaleToVideo;
    const vy = box.y * scaleToVideo;
    const vw = box.width * scaleToVideo;
    const vh = box.height * scaleToVideo;
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    const coverScale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
    const offsetX = (cw - video.videoWidth * coverScale) / 2;
    const offsetY = (ch - video.videoHeight * coverScale) / 2;
    return {
      left: vx * coverScale + offsetX,
      top: vy * coverScale + offsetY,
      width: vw * coverScale,
      height: vh * coverScale,
    };
  }

  function showDetectFrame(frameEl, rect) {
    if (!frameEl) return;
    frameEl.style.left = `${rect.left}px`;
    frameEl.style.top = `${rect.top}px`;
    frameEl.style.width = `${rect.width}px`;
    frameEl.style.height = `${rect.height}px`;
    frameEl.classList.remove("hidden");
  }

  async function scanWithBarcodeDetector(video, onScan, frameEl, generation) {
    const detector = new global.BarcodeDetector({ formats: ["qr_code"] });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (!stream || generation !== cameraGeneration) return;
      try {
        if (video.videoWidth > 0) {
          const scale = Math.min(1, DETECT_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const codes = await detector.detect(canvas);
          if (generation !== cameraGeneration) return;
          if (codes.length > 0 && codes[0].rawValue) {
            const rect = mapBoxToDisplay(codes[0].boundingBox, canvas, video);
            showDetectFrame(frameEl, rect);
            const text = codes[0].rawValue;
            // Briefly show the detected-code box (like a phone's native camera
            // scanner) before tearing the camera down, so a successful read is
            // visibly confirmed rather than the view just vanishing.
            scanTimerId = setTimeout(async () => {
              if (generation !== cameraGeneration) return;
              await stopCamera();
              if (cameraGeneration === generation + 1) onScan(text);
            }, 180);
            return;
          }
        }
      } catch {
        /* skip frame */
      }
      if (generation === cameraGeneration) scanTimerId = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    scanTimerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  // Pinch-to-zoom (two fingers) and tap-to-focus. Hardware zoom via the raw
  // MediaStreamTrack's constraints is Chrome-on-Android-only and, even there, most
  // phone cameras don't actually report a zoom capability through getUserMedia —
  // so pinch always does *something*: hardware zoom when the track supports it,
  // otherwise a CSS transform: scale() on the video itself (framing aid only —
  // BarcodeDetector still reads the full, unscaled frame, so decoding is unaffected).
  // Tap-to-focus has no software fallback and stays feature-detected.
  const CSS_ZOOM_MIN = 1;
  const CSS_ZOOM_MAX = 3;

  function wirePinchZoomAndTapFocus(video, track) {
    let caps = null;
    try {
      caps = track.getCapabilities ? track.getCapabilities() : null;
    } catch {
      caps = null;
    }
    const zoomCaps = caps && caps.zoom;
    const supportsFocus = !!(caps && caps.focusMode && caps.focusMode.includes("single-shot"));

    let pinchStartDist = 0;
    let pinchStartZoom = zoomCaps ? zoomCaps.min : 1;
    let cssScale = 1;
    let touchStart = null;
    let moved = false;

    video.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          const [a, b] = e.touches;
          pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          pinchStartZoom = zoomCaps ? track.getSettings?.().zoom || zoomCaps.min : cssScale;
          moved = true;
        } else if (e.touches.length === 1) {
          touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          moved = false;
        }
      },
      { passive: true }
    );

    video.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
          const [a, b] = e.touches;
          const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          const ratio = dist / pinchStartDist;
          if (zoomCaps) {
            const zoom = Math.min(zoomCaps.max, Math.max(zoomCaps.min, pinchStartZoom * ratio));
            track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
          } else {
            cssScale = Math.min(CSS_ZOOM_MAX, Math.max(CSS_ZOOM_MIN, pinchStartZoom * ratio));
            video.style.transform = cssScale > 1 ? `scale(${cssScale})` : "";
          }
        } else if (touchStart) {
          const dx = e.touches[0].clientX - touchStart.x;
          const dy = e.touches[0].clientY - touchStart.y;
          if (Math.hypot(dx, dy) > 10) moved = true;
        }
      },
      { passive: true }
    );

    video.addEventListener("touchend", () => {
      if (!moved && touchStart && supportsFocus) {
        const rect = video.getBoundingClientRect();
        const x = (touchStart.x - rect.left) / rect.width;
        const y = (touchStart.y - rect.top) / rect.height;
        track
          .applyConstraints({ advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x, y }] }] })
          .catch(() => {});
      }
      touchStart = null;
      pinchStartDist = 0;
    });
  }

  async function startNativeCamera(containerId, onScan, onError, onReady, generation) {
    const container = document.getElementById(containerId);
    if (!container) {
      onError(new Error("Scanner container not found"));
      return;
    }
    container.innerHTML = "";
    container.style.position = "relative";
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.className = "scan-video";
    container.appendChild(video);
    const frameEl = document.createElement("div");
    frameEl.className = "scan-detect-frame hidden";
    container.appendChild(frameEl);

    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        // Most phone cameras default to 1080p+ (some go much higher with
        // continuous autofocus engaged) — none of that extra resolution helps
        // reading a QR code, it just means more pixels to push through detect()
        // every tick, so ask for something QR-scanning actually needs.
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (generation !== cameraGeneration) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
    } catch (e) {
      if (generation === cameraGeneration) onError(e);
      return;
    }
    video.srcObject = stream;
    await video.play();
    if (generation !== cameraGeneration) return;
    const track = stream.getVideoTracks()[0];
    currentTrack = track || null;
    if (track) wirePinchZoomAndTapFocus(video, track);
    if (typeof onReady === "function") onReady();
    await scanWithBarcodeDetector(video, onScan, frameEl, generation);
  }

  function loadScript(url) {
    if (global.Html5Qrcode) return Promise.resolve();
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.dataset.antimatterScanner = url;
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove();
        libraryPromise = null;
        reject(new Error("Scanner library failed to load"));
      };
      document.head.appendChild(s);
    });
    return libraryPromise;
  }

  async function startHtml5Camera(containerId, libUrl, onScan, onError, generation) {
    try {
      await loadScript(libUrl);
    } catch (e) {
      if (generation === cameraGeneration) onError(e);
      return;
    }
    if (generation !== cameraGeneration) return;
    const container = document.getElementById(containerId);
    if (!container) {
      onError(new Error("Scanner container not found"));
      return;
    }
    container.innerHTML = "";
    const readerId = "antimatter-qr-reader";
    const div = document.createElement("div");
    div.id = readerId;
    div.className = "scan-reader-mount";
    container.appendChild(div);

    const instance = new global.Html5Qrcode(readerId);
    html5Instance = instance;
    const config = { fps: 10, qrbox: (width, height) => {
      const size = Math.max(1, Math.min(250, Math.floor(Math.min(width, height) * 0.8)));
      return { width: size, height: size };
    } };
    // Request the rear camera directly. Enumerating first can require a second
    // permission prompt and returns unlabelled cameras on mobile WebViews.
    await instance.start(
      { facingMode: "environment" },
      config,
      async (text) => {
        if (generation !== cameraGeneration) return;
        await stopCamera();
        if (cameraGeneration === generation + 1) onScan(text);
      },
      () => {}
    );
    if (generation !== cameraGeneration) {
      try { await instance.stop(); } catch { /* already stopped */ }
      await safeClear(instance);
    }
  }

  // Html5Qrcode.clear() doesn't reliably return a Promise (some code paths return
  // undefined synchronously, e.g. when scanFile() threw before scanning state was
  // ever set up) — calling .catch() on that crashes with a *new*, uncaught
  // "Cannot read properties of undefined (reading 'catch')", which pre-empts the
  // real onError(e) call below it and makes a failed photo scan look like nothing
  // happened at all instead of showing an error.
  async function safeClear(inst) {
    if (!inst) return;
    try {
      await inst.clear();
    } catch (e) {
      /* ignore cleanup failures */
    }
  }

  const MAX_PREPROCESS_DIM = 1800;
  let photoId = 0;

  async function loadPhoto(file) {
    try {
      if (typeof global.createImageBitmap === "function") return await global.createImageBitmap(file);
    } catch { /* Safari may support <img> for formats its bitmap API rejects. */ }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function photoCanvas(image, scale, mode) {
    const factor = Math.min(1, MAX_PREPROCESS_DIM / Math.max(image.width, image.height)) * scale;
    const width = Math.max(1, Math.round(image.width * factor));
    const height = Math.max(1, Math.round(image.height * factor));
    // A QR decoder needs a quiet zone, including when a photo was cropped tightly.
    const border = Math.max(24, Math.round(Math.min(width, height) * 0.08));
    const canvas = document.createElement("canvas");
    canvas.width = width + border * 2;
    canvas.height = height + border * 2;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, border, border, width, height);
    if (mode !== "color") {
      const pixels = ctx.getImageData(border, border, width, height);
      const data = pixels.data;
      const luma = new Uint8ClampedArray(width * height);
      let min = 255;
      let max = 0;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const value = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        luma[j] = value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const range = max - min || 1;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        let value = Math.round(((luma[j] - min) / range) * 255);
        if (mode === "invert") value = 255 - value;
        data[i] = data[i + 1] = data[i + 2] = value;
      }
      ctx.putImageData(pixels, border, border);
    }
    return canvas;
  }

  async function scanImageFile(file, onScan, onError, libUrl) {
    let image = null;
    let mount = null;
    let detector = null;
    let fallbackReady = false;
    try {
      try { image = await loadPhoto(file); } catch { /* Try the original file below. */ }
      try {
        if (typeof global.BarcodeDetector === "function") {
          detector = new global.BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch { /* Some native detectors exist but do not support QR. */ }

      async function decode(source, fileLike) {
        if (detector && source) {
          try {
            const codes = await detector.detect(source);
            const found = codes.find((code) => code.rawValue);
            if (found) return found.rawValue;
          } catch { /* Native decoding must not prevent the bundled fallback. */ }
        }
        if (!libUrl) return null;
        if (!fallbackReady) {
          await loadScript(libUrl);
          mount = document.createElement("div");
          mount.id = `antimatter-file-scan-${++photoId}`;
          mount.style.display = "none";
          document.body.appendChild(mount);
          fallbackReady = true;
        }
        const instance = new global.Html5Qrcode(mount.id);
        try {
          return (await instance.scanFile(fileLike, false)) || null;
        } catch { return null; }
        finally { await safeClear(instance); }
      }

      let text = await decode(image, file);
      // Generate one bounded image at a time. Scale and the white margin matter
      // as well as contrast; forcing the original photo to B&W is not sufficient.
      const variants = [
        [1, "color"], [0.5, "color"], [0.35, "color"],
        [1, "contrast"], [0.5, "contrast"], [0.35, "contrast"],
        [0.5, "invert"], [0.35, "invert"],
      ];
      if (!text && image) {
        for (const [scale, mode] of variants) {
          const canvas = photoCanvas(image, scale, mode);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) continue;
          text = await decode(canvas, new File([blob], "processed.png", { type: "image/png" }));
          if (text) break;
        }
      }
      if (text) await onScan(text);
      else {
        const error = new Error("No QR code found in image");
        error.code = image ? "qr_not_found" : "image_unreadable";
        onError(error);
      }
    } catch {
      const error = new Error("Photo scanner unavailable");
      error.code = "decoder_unavailable";
      onError(error);
    } finally {
      image?.close?.();
      mount?.remove();
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.containerId
   * @param {string} [opts.libUrl] html5-qrcode script URL
   * @param {(text: string) => void} opts.onScan
   * @param {(err: Error) => void} opts.onError
   * @param {() => void} [opts.onReady] fired once the camera track is live —
   *   only reached on the native BarcodeDetector path, where torch support can
   *   actually be feature-detected against the real MediaStreamTrack.
   */
  async function startCamera(opts) {
    const generation = cameraGeneration + 1;
    await stopCamera();
    if (generation !== cameraGeneration) return;
    const { containerId, libUrl, onScan, onError, onReady } = opts;
    try {
      let nativeAvailable = false;
      if (typeof global.BarcodeDetector === "function") {
        try {
          new global.BarcodeDetector({ formats: ["qr_code"] });
          nativeAvailable = true;
        } catch { /* Fall back when QR is unsupported by the native detector. */ }
      }
      if (nativeAvailable) {
        await startNativeCamera(containerId, onScan, onError, onReady, generation);
        return;
      }
      if (libUrl) {
        await startHtml5Camera(containerId, libUrl, onScan, onError, generation);
        return;
      }
      throw new Error("Camera scanning is not supported in this browser");
    } catch (error) {
      if (generation !== cameraGeneration) return;
      await stopCamera();
      onError(error);
    }
  }

  global.AntiMatterScanner = {
    startCamera,
    stopCamera,
    scanImageFile,
    supportsCamera: () =>
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    supportsNativeScan: () => "BarcodeDetector" in global,
    supportsTorch,
    setTorch,
  };
})(typeof window !== "undefined" ? window : globalThis);

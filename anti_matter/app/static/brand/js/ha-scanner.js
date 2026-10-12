/**
 * Optional Companion app scanner for same-origin Home Assistant ingress.
 * The wire protocol is documented at:
 * https://developers.home-assistant.io/docs/frontend/external-bus/
 * Detecting auth.external is an HA frontend internal and always feature-checked.
 * Inspired by kedube's MIT-licensed Anti-Matter PR #10. This bridge only handles
 * replies to its own request; unrelated HA messages retain their original handler.
 */
(function (global) {
  let host = null;
  let external = null;
  let detecting = null;
  let active = null;

  function failure(code) {
    const error = new Error(`Native scanner: ${code}`);
    error.code = code;
    return error;
  }

  function available() {
    try {
      return !!(host && !host.closed && external?.config?.hasBarCodeScanner &&
        typeof external.fireMessage === "function" && typeof host.externalBus === "function");
    } catch { return false; }
  }

  function ready() {
    if (detecting) return detecting;
    detecting = (async () => {
      let current = global;
      for (let i = 0; i < 8; i++) {
        try {
          const parent = current.parent;
          if (!parent || parent === current) break;
          void parent.document; // Never cross an origin boundary.
          if (parent.location.origin !== global.location.origin) break;
          current = parent;
          if (!current.hassConnection) continue;
          let timer;
          let connection;
          try {
            connection = await Promise.race([
              current.hassConnection,
              new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
            ]);
          } finally { clearTimeout(timer); }
          const candidate = connection?.auth?.external;
          if (candidate?.config?.hasBarCodeScanner && typeof candidate.fireMessage === "function") {
            host = current;
            external = candidate;
            return available();
          }
        } catch { break; }
      }
      return false;
    })();
    return detecting;
  }

  function fire(message) {
    // Invoke HA's own parent-realm method so Android's main-frame origin check
    // applies normally. Do not call a WebView's injected interface from the iframe.
    const parentMessage = host.JSON.parse(JSON.stringify(message));
    external.fireMessage(parentMessage);
    return parentMessage;
  }

  async function scan({ title, description, alternativeOptionLabel, timeoutMs = 300000 }) {
    await ready();
    if (!available()) throw failure("unavailable");
    close();
    return new Promise((resolve, reject) => {
      const original = host.externalBus;
      const request = host.JSON.parse(JSON.stringify({
        type: "bar_code/scan",
        payload: { title, description, alternative_option_label: alternativeOptionLabel },
      }));
      let ended = false;
      let timer;

      function finish(code, text, dismiss = true) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        global.removeEventListener("pagehide", onPageHide);
        if (host.externalBus === tap) host.externalBus = original;
        if (active?.finish === finish) active = null;
        if (dismiss) {
          try { fire({ type: "bar_code/close" }); } catch { /* host removed */ }
        }
        if (code === "result") resolve(text);
        else reject(failure(code));
      }

      function tap(message) {
        if (ended || !request.id || message?.id !== request.id || message?.type !== "command" ||
            !["bar_code/scan_result", "bar_code/aborted"].includes(message.command)) {
          return original.apply(this, arguments);
        }
        // ACK our command without replacing HA's registered command handler.
        fire({ id: message.id, type: "result", success: true, result: null });
        if (message.command === "bar_code/aborted") {
          finish(message.payload?.reason === "alternative_options" ? "alternative" : "aborted", null, false);
        } else if (message.payload?.format === "qr_code" && typeof message.payload.rawValue === "string" &&
                   message.payload.rawValue.trim()) {
          finish("result", message.payload.rawValue);
        }
      }

      function onPageHide() { finish("closed"); }
      try {
        host.externalBus = tap;
        active = { finish };
        global.addEventListener("pagehide", onPageHide);
        timer = setTimeout(() => finish("timeout"), timeoutMs);
        // fireMessage assigns request.id before sending it to the app.
        external.fireMessage(request);
        if (!Number.isFinite(request.id)) finish("unavailable", null, false);
      } catch { finish("unavailable", null, false); }
    });
  }

  function close() {
    active?.finish("closed");
  }

  global.AntiMatterHaScanner = { ready, available, scan, close };
  ready();
})(typeof window !== "undefined" ? window : globalThis);

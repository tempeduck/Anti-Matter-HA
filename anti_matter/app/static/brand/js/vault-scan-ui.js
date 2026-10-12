/**
 * Shared scan dialog wiring for AntiMatter vault UIs.
 */
(function (global) {
  /**
   * @param {object} opts
   * @param {() => { codes: object[] }} opts.getVault
   * @param {(code: object|null, prefilled?: object) => void} opts.openCodeDialog
   * @param {(key: string, vars?: object) => string} [opts.t]
   * @param {string} [opts.libUrl] html5-qrcode fallback script
   */
  function bindVaultScanUi(opts) {
    const t =
      opts.t ||
      ((key, vars) => {
        let s = key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, String(v));
          }
        }
        return s;
      });

    const scanDlg = document.getElementById("scan-dialog");
    const readerId = "scan-reader";
    const uiAlert = opts.uiAlert || ((msg) => Promise.resolve(window.alert(msg)));
    const uiConfirm = opts.uiConfirm || ((msg) => Promise.resolve(window.confirm(msg)));
    let scanGeneration = 0;
    let photoGeneration = 0;

    // Consecutive scans without a custom name would all collide on the same
    // "Scanned device" default — number them so each saved scan stays distinct.
    function nextDefaultName() {
      const base = t("scan.default_name");
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped}(?: (\\d+))?$`);
      let maxN = 0;
      let found = false;
      for (const c of opts.getVault().codes || []) {
        const m = re.exec((c.name || "").trim());
        if (!m) continue;
        found = true;
        const n = m[1] ? parseInt(m[1], 10) : 1;
        if (n > maxN) maxN = n;
      }
      return found ? `${base} ${maxN + 1}` : base;
    }

    function applyParsedToForm(parsed) {
      const codeType = parsed.code_type || "matter";
      const typeEl = document.getElementById("code-type");
      if (typeEl) typeEl.value = codeType;
      global.AntiMatterUI?.syncCodeTypeFields?.();

      if (codeType === "homekit") {
        document.getElementById("code-homekit-uri").value =
          parsed.qr_payload || "";
        document.getElementById("code-homekit-pairing").value =
          parsed.manual_code || "";
        if (parsed.setup_id) {
          document.getElementById("code-homekit-setup-id").value =
            parsed.setup_id;
        }
        if (parsed.homekit_category) {
          document.getElementById("code-homekit-category").value =
            parsed.homekit_category;
        }
        global.AntiMatterUI?.syncHomeKitDerived?.();
      } else if (codeType === "zwave") {
        document.getElementById("code-zwave-dsk").value =
          parsed.manual_code || "";
        document.getElementById("code-zwave-qr").value = parsed.qr_payload || "";
        global.AntiMatterUI?.renderZwaveDecode?.();
      } else if (codeType === "other") {
        document.getElementById("code-other-manual").value =
          parsed.manual_code || "";
        document.getElementById("code-other-qr").value = parsed.qr_payload || "";
      } else {
        document.getElementById("code-manual").value = parsed.manual_code || "";
        document.getElementById("code-qr").value = parsed.qr_payload || "";
        // Setting .value directly doesn't fire "input", so the decode (and its
        // vendor/product auto-fill) would otherwise only run once the user opens
        // the "Decode Matter payload" details or edits the field by hand.
        global.AntiMatterUI?.renderMtDecode?.();
      }

      const nameEl = document.getElementById("code-name");
      if (nameEl && !nameEl.value.trim()) {
        nameEl.value = nextDefaultName();
      }
    }

    async function handleParsedText(text) {
      let parsed;
      try { parsed = global.AntiMatterScan.parseScannedText(text); }
      catch { /* Malformed payloads should show a user-facing error. */ }
      if (!parsed) {
        await uiAlert(t("scan.unrecognized"));
        global.logEvent?.("Scan: unrecognized code");
        return;
      }
      global.logEvent?.(`Scan: captured protocol=${parsed.code_type || "matter"}`);
      const excludeId = document.getElementById("code-id")?.value || null;
      const dup = global.AntiMatterScan.findDuplicate(
        opts.getVault().codes,
        parsed,
        excludeId || null
      );
      if (dup) {
        const msg = t("scan.duplicate", {
          name: dup.name || t("scan.unnamed"),
        });
        global.logEvent?.("Scan: duplicate of existing code detected");
        if (await uiConfirm(msg + "\n" + t("scan.duplicate_open"), t("action.ok"))) {
          scanDlg?.close();
          opts.openCodeDialog(dup);
        }
        return;
      }
      scanDlg?.close();
      // The Scan/Upload buttons embedded inside the code dialog itself (New or Edit)
      // fire this same handler — the code dialog is already open there, and calling
      // showModal() on an already-open <dialog> throws, silently swallowing the
      // scanned data. Only (re)open it fresh when it wasn't already open (the
      // standalone header "Scan" button, opened from the separate scan dialog).
      const codeDlg = document.getElementById("code-dialog");
      if (!codeDlg?.open) opts.openCodeDialog(null);
      applyParsedToForm(parsed);
    }

    const torchBtn = document.getElementById("btn-scan-torch");
    let torchOn = false;

    function resetTorchButton() {
      torchOn = false;
      if (!torchBtn) return;
      torchBtn.classList.remove("is-active");
      torchBtn.setAttribute("aria-pressed", "false");
      torchBtn.classList.add("hidden");
    }

    function updateTorchButtonVisibility() {
      if (!torchBtn) return;
      torchBtn.classList.toggle("hidden", !global.AntiMatterScanner.supportsTorch());
    }

    torchBtn?.addEventListener("click", async () => {
      const next = !torchOn;
      const ok = await global.AntiMatterScanner.setTorch(next);
      torchOn = ok && next;
      torchBtn.classList.toggle("is-active", torchOn);
      torchBtn.setAttribute("aria-pressed", String(torchOn));
    });

    async function openScanDialog() {
      if (!scanDlg) return;
      const generation = ++scanGeneration;
      scanDlg.showModal();
      resetTorchButton();
      const hint = document.getElementById("scan-hint");
      if (hint) hint.textContent = t("scan.starting");
      const native = global.AntiMatterHaScanner;
      if (native && await native.ready()) {
        if (!scanDlg.open || generation !== scanGeneration) return;
        if (hint) hint.textContent = t("scan.hint_native");
        try {
          const text = await native.scan({
            title: t("scan.title"), description: t("scan.hint_native"),
            alternativeOptionLabel: t("scan.upload_photo"),
          });
          if (scanDlg.open && generation === scanGeneration) await handleParsedText(text);
          return;
        } catch (error) {
          if (!scanDlg.open || generation !== scanGeneration) return;
          if (error.code === "closed" || error.code === "replaced") return;
          if (error.code === "aborted") { closeScanDialog(); return; }
          if (error.code === "alternative") {
            if (hint) hint.textContent = t("scan.hint_photo");
            return;
          }
        }
      }
      if (!scanDlg.open || generation !== scanGeneration) return;
      if (hint) {
        hint.textContent = !global.isSecureContext
          ? t("scan.https_required")
          : global.AntiMatterScanner.supportsNativeScan()
          ? t("scan.hint_native")
          : global.AntiMatterScanner.supportsCamera()
            ? t("scan.hint_fallback")
            : t("scan.hint_photo");
      }
      if (
        global.AntiMatterScanner.supportsCamera() &&
        (global.AntiMatterScanner.supportsNativeScan() || opts.libUrl)
      ) {
        global.AntiMatterScanner.startCamera({
          containerId: readerId,
          libUrl: opts.libUrl,
          onScan: handleParsedText,
          onError: (err) => {
            if (!scanDlg.open || generation !== scanGeneration) return;
            if (hint) hint.textContent = !global.isSecureContext
              ? t("scan.https_required") : t("scan.camera_denied");
          },
          onReady: updateTorchButtonVisibility,
        });
      }
    }

    function closeScanDialog() {
      scanGeneration++;
      photoGeneration++;
      global.AntiMatterHaScanner?.close();
      global.AntiMatterScanner.stopCamera();
      const el = document.getElementById(readerId);
      if (el) el.innerHTML = "";
      resetTorchButton();
      scanDlg?.close();
    }

    const scanButtons = [
      "btn-scan-code",
      "btn-scan-in-form",
      "btn-scan-homekit",
      "btn-scan-zwave",
      "btn-scan-other",
    ];
    for (const id of scanButtons) {
      document.getElementById(id)?.addEventListener("click", openScanDialog);
    }
    document.getElementById("scan-stop")?.addEventListener("click", closeScanDialog);
    scanDlg?.addEventListener("close", () => {
      if (scanDlg.open) return;
      scanGeneration++;
      photoGeneration++;
      global.AntiMatterHaScanner?.close();
      global.AntiMatterScanner.stopCamera();
    });
    document.getElementById("code-dialog")?.addEventListener("close", (event) => {
      if (!event.target.open) photoGeneration++;
    });
    global.addEventListener("pagehide", () => {
      scanGeneration++;
      photoGeneration++;
      global.AntiMatterHaScanner?.close();
      global.AntiMatterScanner.stopCamera();
    });

    const fileInputIds = [
      "scan-file-input",
      "scan-camera-input",
      "scan-file-in-form",
      "scan-file-homekit",
      "scan-file-zwave",
      "scan-file-other",
    ];
    for (const fid of fileInputIds) {
      const input = document.getElementById(fid);
      if (!input) continue;
      const errorEl = document.getElementById(`${fid === "scan-camera-input" ? "scan-file-input" : fid}-error`);
      input.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (errorEl) {
          errorEl.textContent = "";
          errorEl.classList.add("hidden");
        }
        if (!file) return;
        const generation = ++photoGeneration;
        const originatingDialog = input.closest("dialog");
        const stillActive = () => generation === photoGeneration && originatingDialog?.open;
        const showStatus = (text) => {
          if (!stillActive()) return;
          if (errorEl) {
            errorEl.textContent = text;
            errorEl.classList.toggle("hidden", !text);
          }
        };
        global.AntiMatterHaScanner?.close();
        await global.AntiMatterScanner.stopCamera();
        if (!stillActive()) return;
        showStatus(t("scan.processing"));
        await global.AntiMatterScanner.scanImageFile(
          file,
          async (text) => {
            if (!stillActive()) return;
            showStatus("");
            await handleParsedText(text);
          },
          (err) => {
            if (!stillActive()) return;
            const msg = t(err.code === "image_unreadable" ? "scan.image_unreadable"
              : err.code === "decoder_unavailable" ? "scan.decoder_unavailable" : "scan.photo_fail");
            // The 3 upload buttons embedded in the code form show the error inline
            // right under the button — a modal alert() here was easy to miss (or,
            // before a matter-scanner.js bug fix, never even appeared) while heads-down
            // in a long form. The standalone Scan dialog has no such slot, so it keeps
            // the modal.
            if (errorEl) {
              errorEl.textContent = msg;
              errorEl.classList.remove("hidden");
            } else {
              uiAlert(msg);
            }
          },
          opts.libUrl
        );
      });
    }
  }

  global.AntiMatterVaultScanUi = { bindVaultScanUi };
})(typeof window !== "undefined" ? window : globalThis);

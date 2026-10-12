import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";

let browser, server, root, base, expected;
const python = process.env.PYTHON || resolve(".venv/bin/python");
before(async () => {
  await mkdir(".local", { recursive: true });
  root = await mkdtemp(resolve(".local/browser-"));
  const generated = spawnSync(python, ["tools/tests/make-fixtures.py", join(root, "fixtures")]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  expected = JSON.parse(await readFile(join(root, "fixtures/expected.json"))).payload;
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const env = { ...process.env, STORAGE_DIR: join(root, "vault"), ANTIMATTER_MEDIA: join(root, "media"),
    ANTIMATTER_OPTIONS: join(root, "options.json"), ANTIMATTER_DATA: join(root, "data") };
  delete env.SUPERVISOR_TOKEN;
  server = spawn(python, ["-m", "uvicorn", "main:app", "--app-dir", "anti_matter/app",
    "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], { env, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + "/api/info")).ok; } catch { /* wait for startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Isolated backend started");
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function pageWith(options = {}, init) {
  const page = await browser.newPage(options);
  if (init) await page.addInitScript(init);
  // Keep name lookups and all other external network access out of these tests.
  await page.route("**/*", (route) => route.request().url().startsWith(base)
    ? route.continue() : route.abort());
  await page.route("**/api/matter/**", (route) => route.fulfill({ status: 204 }));
  await page.goto(base);
  await page.waitForFunction(() => window.AntiMatterUI && window.AntiMatterScanner &&
    typeof document.getElementById("btn-add-code").onclick === "function");
  return page;
}

async function decode(page, name) {
  const bytes = Array.from(await readFile(join(root, "fixtures", name)));
  return page.evaluate(({ bytes, name, expected }) => new Promise((resolve) => {
    const file = new File([new Uint8Array(bytes)], name, { type: name.endsWith("jpg") ? "image/jpeg" : "image/png" });
    AntiMatterScanner.scanImageFile(file,
      (text) => resolve({ success: text === expected }),
      (err) => resolve({ success: false, code: err.code }), "./static/vendor/html5-qrcode.min.js");
  }), { bytes, name, expected });
}

for (const name of ["tight-gray.png", "border-gray.png", "tight-large.png", "tight-inverted.png", "rotated.png", "photo.jpg"]) {
  test(`offline photo decoding: ${name}`, async () => {
    const page = await pageWith();
    try {
      assert.deepEqual(await decode(page, name), { success: true });
      assert.equal(await page.locator('[id^="antimatter-file-scan-"]').count(), 0);
    } finally { await page.close(); }
  });
}

test("blank image fails clearly without leaking a temporary reader", async () => {
  const page = await pageWith();
  try {
    assert.deepEqual(await decode(page, "blank.png"), { success: false, code: "qr_not_found" });
    assert.equal(await page.locator('[id^="antimatter-file-scan-"]').count(), 0);
  } finally { await page.close(); }
});

test("photo decoding works when createImageBitmap is missing", async () => {
  const page = await pageWith({}, () => { window.createImageBitmap = undefined; });
  try { assert.deepEqual(await decode(page, "tight-large.png"), { success: true }); }
  finally { await page.close(); }
});

test("throwing native detector falls through to bundled offline decoding", async () => {
  const page = await pageWith({}, () => {
    window.BarcodeDetector = class { async detect() { throw new Error("Synthetic detector failure"); } };
  });
  try { assert.deepEqual(await decode(page, "tight-large.png"), { success: true }); }
  finally { await page.close(); }
});

test("missing camera API offers take-photo and image-picker paths", async () => {
  const page = await pageWith({ viewport: { width: 390, height: 844 } }, () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  });
  try {
    await page.click("#btn-scan-code");
    await page.waitForFunction(() => document.getElementById("scan-hint").textContent.includes("HTTPS"));
    assert.equal(await page.getAttribute("#scan-camera-input", "capture"), "environment");
    assert.equal(await page.getAttribute("#scan-file-input", "capture"), null);
    await page.setInputFiles("#scan-file-input", join(root, "fixtures/tight-large.png"));
    await page.waitForFunction(() => document.getElementById("code-dialog").open);
    assert.equal(await page.inputValue("#code-qr"), expected);
  } finally { await page.close(); }
});

test("camera start failure is caught and leaves the photo path usable", async () => {
  const page = await pageWith({}, () => {
    window.Html5Qrcode = class { async start() { throw new Error("Synthetic permission denied"); }
      async stop() {} clear() {} };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.click("#btn-scan-code");
    await page.waitForFunction(() => document.getElementById("scan-hint").textContent.includes("Live camera unavailable"));
    assert.deepEqual(errors, []);
    await page.click("#scan-stop");
  } finally { await page.close(); }
});

test("closing during native browser permission releases the late stream", async () => {
  const page = await pageWith({}, () => {
    window.BarcodeDetector = class { async detect() { return []; } };
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { window.resolvePermission = resolve; });
  });
  try {
    await page.click("#btn-scan-code");
    await page.waitForFunction(() => typeof window.resolvePermission === "function");
    await page.click("#scan-stop");
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 10;
      const stream = canvas.captureStream();
      window.lateTrack = stream.getTracks()[0];
      window.resolvePermission(stream);
    });
    await page.waitForFunction(() => window.lateTrack.readyState === "ended");
    assert.equal(await page.locator("#scan-dialog").evaluate((el) => el.open), false);
  } finally { await page.close(); }
});

test("closing during fallback camera startup stops the camera once permission resolves", async () => {
  const page = await pageWith({}, () => {
    window.BarcodeDetector = undefined;
    window.cameraStopped = 0;
    window.Html5Qrcode = class {
      start() { return new Promise((resolve) => { window.allowCamera = () => { this.live = true; resolve(); }; }); }
      async stop() { if (!this.live) throw new Error("Not started"); window.cameraStopped++; this.live = false; }
      clear() {}
      static getCameras() { throw new Error("Camera enumeration must not be required"); }
    };
  });
  try {
    await page.click("#btn-scan-code");
    await page.waitForFunction(() => typeof allowCamera === "function");
    await page.click("#scan-stop");
    await page.evaluate(() => allowCamera());
    await page.waitForFunction(() => cameraStopped === 1);
  } finally { await page.close(); }
});

test("rapid close and reopen retains the new camera session", async () => {
  const page = await pageWith({}, () => {
    window.BarcodeDetector = undefined;
    window.cameraStarts = 0;
    window.Html5Qrcode = class {
      async start() { window.cameraStarts++; }
      async stop() {}
      clear() {}
    };
  });
  try {
    await page.click("#btn-scan-code");
    await page.waitForFunction(() => cameraStarts === 1);
    await page.evaluate(() => {
      document.getElementById("scan-dialog").close();
      document.getElementById("btn-scan-code").click();
    });
    await page.waitForFunction(() => cameraStarts === 2);
    assert.equal(await page.locator("#scan-dialog").evaluate((el) => el.open), true);
  } finally { await page.close(); }
});

test("closing during a file decode cannot reopen the editor", async () => {
  const page = await pageWith({}, () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined });
  });
  try {
    await page.evaluate(() => {
      AntiMatterScanner.scanImageFile = (file, onScan) => new Promise((resolve) => {
        window.finishPhoto = async (text) => { await onScan(text); resolve(); };
      });
    });
    await page.click("#btn-scan-code");
    await page.setInputFiles("#scan-file-input", join(root, "fixtures/tight-large.png"));
    await page.waitForFunction(() => typeof finishPhoto === "function");
    await page.click("#scan-stop");
    await page.evaluate((text) => window.finishPhoto(text), expected);
    assert.equal(await page.locator("#code-dialog").evaluate((el) => el.open), false);
  } finally { await page.close(); }
});

test("photo failure shows helpful feedback and the same file can be retried", async () => {
  const page = await pageWith({}, () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined });
  });
  try {
    await page.click("#btn-scan-code");
    await page.setInputFiles("#scan-file-input", join(root, "fixtures/blank.png"));
    await page.waitForFunction(() => document.getElementById("scan-file-input-error").textContent.includes("white space"));
    assert.equal(await page.inputValue("#scan-file-input"), "");
    await page.setInputFiles("#scan-file-input", join(root, "fixtures/tight-large.png"));
    await page.waitForFunction(() => document.getElementById("code-dialog").open);
  } finally { await page.close(); }
});

test("failed import is visible and leaves the displayed vault intact", async () => {
  const page = await pageWith();
  try {
    await page.setInputFiles("#import-file", { name: "wrong.json", mimeType: "application/json", buffer: Buffer.from("{}") });
    await page.waitForFunction(() => [...document.querySelectorAll("dialog")].some((el) => el.open && el.textContent.includes("Replace")));
    const replace = page.locator("dialog[open] button").filter({ hasText: /^Replace$/ });
    await replace.click();
    await page.waitForFunction(() => [...document.querySelectorAll("dialog")].some((el) => el.open && el.textContent.includes("Import failed")));
    const response = await page.request.get(base + "/api/codes");
    assert.deepEqual(await response.json(), []);
  } finally { await page.close(); }
});

test("same-named HA devices show entity IDs and fill only empty facts", async () => {
  const page = await pageWith();
  try {
    await page.route("**/api/ha/devices", (route) => route.fulfill({ json: [
      { id: "a", name: "Same Name", area: "Office", manufacturer: "Example A", model: "Model A", entity_ids: ["switch.example_a"] },
      { id: "b", name: "Same Name", area: "Office", manufacturer: "Example B", model: "Model B", entity_ids: ["switch.example_b"] },
    ] }));
    await page.reload();
    await page.click("#btn-add-code");
    await page.locator("#code-ha-details").evaluate((el) => { el.open = true; });
    await page.fill("#code-ha-device-name", "switch.example_b");
    await page.locator("#ha-device-suggestions li").first().click();
    assert.equal(await page.inputValue("#code-ha-device"), "b");
    assert.equal(await page.inputValue("#code-device-vendor"), "Example B");
    assert.equal(await page.inputValue("#code-device-product"), "Model B");
    assert.equal(await page.inputValue("#code-area"), "Office");
    await page.fill("#code-device-vendor", "My vendor");
    await page.fill("#code-area", "My area");
    await page.fill("#code-ha-device-name", "switch.example_a");
    await page.locator("#ha-device-suggestions li").first().click();
    assert.equal(await page.inputValue("#code-ha-device"), "a");
    assert.equal(await page.inputValue("#code-device-vendor"), "My vendor");
    assert.equal(await page.inputValue("#code-area"), "My area");
  } finally { await page.close(); }
});

async function nativePage() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    if (parent !== window) return;
    window.nativeMessages = [];
    window.delegated = [];
    window.originalBus = (msg) => window.delegated.push(msg.command);
    window.externalBus = window.originalBus;
    const external = { config: { hasBarCodeScanner: 1 }, msgId: 0,
      fireMessage(msg) { if (!msg.id) msg.id = ++this.msgId; window.nativeMessages.push(msg); } };
    window.hassConnection = Promise.resolve({ auth: { external } });
  });
  await page.route(base + "/test-host", (route) => route.fulfill({ contentType: "text/html",
    body: `<iframe src="/" style="width:800px;height:900px"></iframe>` }));
  await page.route("**/api/matter/**", (route) => route.fulfill({ status: 204 }));
  await page.goto(base + "/test-host");
  const frame = page.frames().find((f) => f.parentFrame());
  await frame.waitForFunction(() => window.AntiMatterHaScanner?.available() &&
    typeof document.getElementById("btn-add-code").onclick === "function");
  await frame.click("#btn-scan-code");
  await page.waitForFunction(() => nativeMessages.some((m) => m.type === "bar_code/scan"));
  return { page, frame };
}

test("Companion scanner delivers a QR, ACKs it, and restores HA's handler", async () => {
  const { page, frame } = await nativePage();
  try {
    await page.evaluate((text) => {
      const request = nativeMessages.find((m) => m.type === "bar_code/scan");
      externalBus({ id: request.id, type: "command", command: "bar_code/scan_result", payload: { format: "qr_code", rawValue: text } });
    }, expected);
    await frame.waitForFunction(() => document.getElementById("code-dialog").open);
    assert.equal(await frame.inputValue("#code-qr"), expected);
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
    assert.equal(await page.evaluate(() => nativeMessages.some((m) => m.type === "result" && m.success)), true);
    assert.equal(await page.evaluate(() => nativeMessages.filter((m) => m.type === "bar_code/close").length), 1);
  } finally { await page.close(); }
});

test("Companion scanner passes unrelated messages through and ignores other scan IDs", async () => {
  const { page, frame } = await nativePage();
  try {
    await page.evaluate(() => {
      externalBus({ id: 999, type: "command", command: "navigate", payload: {} });
      externalBus({ id: 999, type: "command", command: "bar_code/scan_result", payload: { format: "qr_code", rawValue: "Synthetic unrelated" } });
    });
    assert.deepEqual(await page.evaluate(() => delegated), ["navigate", "bar_code/scan_result"]);
    assert.equal(await frame.locator("#code-dialog").evaluate((el) => el.open), false);
    await frame.click("#scan-stop");
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
  } finally { await page.close(); }
});

test("Companion cancellation closes the dialog without starting a browser camera", async () => {
  const { page, frame } = await nativePage();
  try {
    await page.evaluate(() => {
      const request = nativeMessages.find((m) => m.type === "bar_code/scan");
      externalBus({ id: request.id, type: "command", command: "bar_code/aborted", payload: { reason: "canceled" } });
    });
    await frame.waitForFunction(() => !document.getElementById("scan-dialog").open);
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
  } finally { await page.close(); }
});

test("Companion alternative offers the image picker without treating cancellation as an error", async () => {
  const { page, frame } = await nativePage();
  try {
    await page.evaluate(() => {
      const request = nativeMessages.find((m) => m.type === "bar_code/scan");
      externalBus({ id: request.id, type: "command", command: "bar_code/aborted", payload: { reason: "alternative_options" } });
    });
    await frame.waitForFunction(() => document.getElementById("scan-hint").textContent === "Upload a photo of the QR code.");
    await frame.setInputFiles("#scan-file-input", join(root, "fixtures/tight-large.png"));
    await frame.waitForFunction(() => document.getElementById("code-dialog").open);
  } finally { await page.close(); }
});

test("removing the scanner iframe closes the Companion scanner and restores HA's bus", async () => {
  const { page, frame } = await nativePage();
  try {
    await frame.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
    assert.equal(await page.evaluate(() => nativeMessages.some((m) => m.type === "bar_code/close")), true);
  } finally { await page.close(); }
});

test("choosing a photo during a Companion scan does not start a competing browser camera", async () => {
  const { page, frame } = await nativePage();
  try {
    await frame.evaluate(() => {
      window.browserCameraStarts = 0;
      AntiMatterScanner.startCamera = () => { window.browserCameraStarts++; };
    });
    await frame.setInputFiles("#scan-file-input", join(root, "fixtures/tight-large.png"));
    await frame.waitForFunction(() => document.getElementById("code-dialog").open);
    assert.equal(await frame.evaluate(() => browserCameraStarts), 0);
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
  } finally { await page.close(); }
});

test("native scanner timeout removes its handler and dismisses its own scanner", async () => {
  const { page, frame } = await nativePage();
  try {
    await frame.evaluate(() => {
      window.scanDialogClosed = new Promise((resolve) => {
        document.getElementById("scan-dialog").addEventListener("close", resolve, { once: true });
      });
    });
    await frame.click("#scan-stop");
    const code = await frame.evaluate(async () => {
      // The dialog's queued close handler must finish before testing a new scan.
      await window.scanDialogClosed;
      try { await AntiMatterHaScanner.scan({ title: "Synthetic", description: "Synthetic", timeoutMs: 25 }); }
      catch (err) { return err.code; }
    });
    assert.equal(code, "timeout");
    assert.equal(await page.evaluate(() => externalBus === originalBus), true);
  } finally { await page.close(); }
});

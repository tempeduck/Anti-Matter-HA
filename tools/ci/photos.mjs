// Test margin retries with a controlled decoder, then decode synthetic photographs
// through the real offline WASM worker. Pairing data here is deliberately fake.
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(ROOT, "anti_matter/app/static/brand/js/scan-worker.js"), "utf8");
class Pixels {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
}
let passed = 0;
for (const [scale, width, height] of [[0.5, 92, 72], [0.35, 74, 60]]) {
  const context = vm.createContext({ URL, Date, Promise, ImageData: Pixels, Uint8ClampedArray,
    self: { location: { href: "http://example.test/static/brand/js/scan-worker.js" }, postMessage() {} },
    importScripts() {}, ZXingWASM: { prepareZXingModule: async () => {}, readBarcodes: async image => {
      if (image.width !== width || image.height !== height) return [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (x < 16 || x >= width - 16 || y < 16 || y >= height - 16) {
          const i = (y * width + x) * 4;
          assert.deepEqual(Array.from(image.data.slice(i, i + 4)), [255, 255, 255, 255]);
        }
      }
      return [{ isValid: true, text: "synthetic", format: "QRCode", position: {
        topLeft: { x: 16, y: 16 }, topRight: { x: width - 16, y: 16 },
        bottomRight: { x: width - 16, y: height - 16 }, bottomLeft: { x: 16, y: height - 16 } } }];
    } } });
  vm.runInContext(source, context);
  const image = new Pixels(120, 80);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  const result = await context.scanImage({ imageData: image, scale: 3 });
  assert.equal(result.results[0].pass, "white-margin-" + scale);
  const expectedCorners = [{ x: 0, y: 0 }, { x: 360, y: 0 }, { x: 360, y: 240 }, { x: 0, y: 240 }];
  result.results[0].corners.forEach((point, index) => {
    assert.ok(Math.abs(point.x - expectedCorners[index].x) < 0.001);
    assert.ok(Math.abs(point.y - expectedCorners[index].y) < 0.001);
  });
  passed++;
  console.log(`PASS white margin ${scale}: opaque padding and original-image coordinates`);
}

const PYTHON = process.env.PYTHON || "python3";
const PORT = Number(process.env.PORT || 18819), BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-photos-"));
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_OPTIONS: path.join(storage, "options.json"),
  ANTIMATTER_MEDIA: path.join(storage, "media"), ANTIMATTER_PORT: String(PORT) };
delete env.SUPERVISOR_TOKEN;
delete env.HASSIO_TOKEN;
const server = spawn(PYTHON, ["main.py"], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
    if (attempt > 100) throw Error("Backend did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE);
  const cases = await page.evaluate(async () => {
    const packed = 11122333n | (10n << 27n) | (4n << 31n);
    const expected = "X-HM://" + packed.toString(36).toUpperCase().padStart(9, "0") + "AB12";
    const response = await fetch("api/qr.svg?border=0", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_type: "homekit", qr_payload: expected }) });
    const svg = await response.text();
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(svg);
    await img.decode();
    const worker = new Worker("static/brand/js/scan-worker.js");
    await new Promise((resolve, reject) => {
      worker.onmessage = e => e.data.type === "ready" ? resolve() : e.data.type === "init-error" ? reject(Error(e.data.code)) : null;
      worker.onerror = reject;
    });
    const output = [];
    try {
      for (const mode of ["tight-gray", "tight-inverted", "phone-jpeg", "blank"]) {
        const canvas = document.createElement("canvas"); canvas.width = 1211; canvas.height = 1090;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (mode !== "blank") {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < data.data.length; i += 4) {
            const dark = data.data[i] < 128;
            const v = mode === "tight-inverted" ? (dark ? 210 : 40) : (dark ? 70 : 190);
            data.data[i] = v; data.data[i + 1] = v + 4; data.data[i + 2] = v + 8;
          }
          ctx.putImageData(data, 0, 0);
          if (mode === "phone-jpeg") {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.65));
            const bitmap = await createImageBitmap(blob); ctx.drawImage(bitmap, 0, 0); bitmap.close();
          }
        }
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Photo decoder timeout")), 20000);
          worker.onmessage = e => { if (e.data.id === mode) { clearTimeout(timer); resolve(e.data); } };
          worker.postMessage({ id: mode, type: "scanImage", imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
            options: { exhaustive: true, multi: true } });
        });
        output.push({ mode, found: result.results.some(r => r.text === expected),
          count: result.results.length, passes: result.passNames });
      }
    } finally { worker.terminate(); }
    return output;
  });
  for (const result of cases) {
    assert.equal(result.found, result.mode !== "blank", result.mode);
    if (result.mode === "blank") assert.equal(result.count, 0);
    assert.ok(result.passes.includes("white-margin-0.5"));
    assert.ok(result.passes.includes("white-margin-0.35"));
    passed++;
    console.log(`PASS ${result.mode}: real WASM photo decoding and both margin retries`);
  }
  console.log(`photos: ${passed} checks passed`);
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  fs.rmSync(storage, { recursive: true, force: true });
}

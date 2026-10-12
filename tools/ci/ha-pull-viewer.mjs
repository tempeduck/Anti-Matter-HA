// Real editor, backend and downloaded file:// viewer, with synthetic values only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3", PORT = Number(process.env.PORT || 18820);
const BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-pull-viewer-"));
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_OPTIONS: path.join(storage, "options.json"),
  ANTIMATTER_MEDIA: path.join(storage, "media"), ANTIMATTER_PORT: String(PORT) };
delete env.SUPERVISOR_TOKEN; delete env.HASSIO_TOKEN;
const server = spawn(PYTHON, ["main.py"], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
const packed = 11122333n | (10n << 27n) | (4n << 31n);
const HK = "X-HM://" + packed.toString(36).toUpperCase().padStart(9, "0") + "AB12";
const MT = "MT:Y.K9042C00KA0648G00";
const ZW = execFileSync(PYTHON, ["-c", "import sys; sys.path.insert(0, 'anti_matter/tests'); from conftest import build_zwave_qr, DSK_A; print(build_zwave_qr(DSK_A))"], { cwd: ROOT, encoding: "utf8" }).trim();
let browser, passed = 0, response = { text: "34970112332" }, release = null, delay = false;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const vault = async () => (await (await fetch(BASE + "api/vault")).json()).codes;
async function add(name) {
  const r = await fetch(BASE + "api/codes", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, device_vendor: "Custom vendor", ha_link: { device_id: "device-a", entity_id: "sensor.fixture_a" } }) });
  assert.equal(r.status, 201); return r.json();
}
async function open(p, id) { await p.evaluate(id => AM.act("openEditor", id), id); await p.locator("#ed-ha-attribute").waitFor(); }
async function close(p) { await p.evaluate(() => AM.sheets.close("sheet-editor", null, "api")); await p.locator("#sheet-editor").waitFor({ state: "hidden" }); }
async function pull(p) { await p.locator("#ed-ha-attribute").fill("setup_code"); await p.locator("#ed-ha-pull").click(); }
async function pendingPull(p) {
  release = null; delay = true; await pull(p);
  for (let i = 0; !release; i++) { if (i > 100) throw Error("Pull request did not start"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function ready(p) { await p.waitForFunction(() => document.getElementById("ed-ha-pull-status").textContent.includes("Review")); }
async function load(p, data, name = "synthetic-export.json") {
  await p.locator("#viewer-file").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)) });
}

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
    if (attempt > 100) throw Error("Backend did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const first = await add("Synthetic pull"), second = await add("Second editor");
  browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; p.on("pageerror", e => { errors.push(String(e)); console.log("PAGE ERROR " + String(e)); });
  await p.route("**/api/matter/**", r => r.fulfill({ status: 204 }));
  await p.route("**/api/info", async r => { const actual = await (await r.fetch()).json(); await r.fulfill({ json: { ...actual, ha_available: true } }); });
  await p.route("**/api/ha/devices*", r => r.fulfill({ json: [{ id: "device-a", name: "Synthetic device", entity_ids: ["sensor.fixture_a", "sensor.fixture_b"] }] }));
  await p.route("**/api/ha/areas", r => r.fulfill({ json: [] }));
  await p.route("**/api/ha/status*", r => r.fulfill({ json: { availability: "available" } }));
  await p.route("**/api/ha/pairing-code*", async r => {
    if (delay) await new Promise(resolve => { release = resolve; });
    await r.fulfill({ status: response.status || 200, json: response.status ? { detail: { error: response.error } } : response });
  });
  await p.goto(BASE);
  await p.waitForFunction(() => AM.store.vault && AM.ha.devices().length && document.documentElement.classList.contains("am-loaded"));
  await check("HA pull previews exact manual code and preserves metadata without saving", async () => {
    await open(p, first.id); await pull(p); await ready(p);
    assert.equal(await p.locator("#ed-mt-man").inputValue(), "3497-011-2332");
    assert.equal(await p.locator("#ed-vendor").inputValue(), "Custom vendor");
    assert.equal((await vault()).find(c => c.id === first.id).manual_code, "");
    await p.locator("#editor-save").click(); await p.locator("#sheet-editor").waitFor({ state: "hidden" });
    assert.equal((await vault()).find(c => c.id === first.id).manual_code.replace(/\D/g, ""), "34970112332");
  });
  await check("replacement requires confirmation and cancellation keeps pairing data", async () => {
    response = { text: HK }; await open(p, first.id); await pull(p);
    await p.locator("#confirm-cancel").click(); await p.locator("#dialog-confirm").waitFor({ state: "hidden" });
    assert.equal(await p.locator("#ed-mt-man").inputValue(), "3497-011-2332");
  });
  await check("full HomeKit URI, setup ID and existing metadata survive preview and explicit Save", async () => {
    await pull(p); await p.locator("#confirm-ok").click(); await ready(p);
    assert.equal(await p.locator("#ed-hk-uri").inputValue(), HK);
    assert.equal(await p.locator("#ed-vendor").inputValue(), "Custom vendor");
    await p.locator("#editor-save").click(); await p.locator("#sheet-editor").waitFor({ state: "hidden" });
    const saved = (await vault()).find(c => c.id === first.id);
    assert.equal(saved.qr_payload, HK); assert.equal(saved.setup_id, "AB12"); assert.equal(saved.homekit_flag, 10);
    assert.deepEqual(saved.ha_link, { device_id: "device-a", entity_id: "sensor.fixture_a" });
  });
  await check("late response keeps pairing edits made while waiting", async () => {
    await open(p, second.id); response = { text: MT }; await pendingPull(p);
    await p.waitForFunction(() => document.getElementById("ed-ha-pull-status").textContent.includes("Reading"));
    await p.locator("#ed-mt-man").fill("3497-011-2332"); release(); delay = false;
    await p.waitForFunction(() => document.getElementById("ed-ha-pull-status").textContent.includes("Your edits"));
    assert.equal(await p.locator("#ed-mt-qr").inputValue(), ""); await close(p);
  });
  await check("late response is discarded after selecting a different entity", async () => {
    await open(p, second.id); await pendingPull(p);
    await p.locator("#ed-ha-entity").selectOption("sensor.fixture_b"); release(); delay = false;
    await p.waitForTimeout(150); assert.equal(await p.locator("#ed-mt-qr").inputValue(), ""); await close(p);
  });
  await check("closed editor response never overwrites a newly opened editor", async () => {
    await open(p, second.id); await pendingPull(p); await close(p);
    await open(p, first.id); release(); delay = false; await p.waitForTimeout(150);
    assert.equal(await p.locator("#ed-hk-uri").inputValue(), HK); await close(p);
  });
  await check("changing the attribute discards an outstanding response", async () => {
    await open(p, second.id); await pendingPull(p);
    await p.locator("#ed-ha-attribute").fill("different_attribute"); release(); delay = false;
    await p.waitForTimeout(150); assert.equal(await p.locator("#ed-mt-qr").inputValue(), ""); await close(p);
  });
  await check("replacement confirmation rechecks pairing edits before applying", async () => {
    await open(p, first.id); response = { text: MT }; await pull(p); await p.locator("#confirm-ok").waitFor();
    await p.evaluate(() => { const input = document.getElementById("ed-hk-sid"); input.value = "CD34"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.locator("#confirm-ok").click();
    await p.waitForFunction(() => document.getElementById("ed-ha-pull-status").textContent.includes("Your edits"));
    assert.equal(await p.locator("#ed-hk-sid").inputValue(), "CD34"); await close(p);
  });
  await check("saving during a pull saves the current form and cancels the response", async () => {
    await open(p, second.id); await pendingPull(p);
    await p.locator("#editor-save").click(); await p.locator("#sheet-editor").waitFor({ state: "hidden" });
    release(); delay = false; await p.waitForTimeout(150);
    assert.equal((await vault()).find(c => c.id === second.id).qr_payload, "");
  });
  await check("pulled duplicate remains blocked by the editor save flow", async () => {
    await open(p, second.id); response = { text: HK }; await pull(p); await ready(p);
    await p.locator("#editor-save").click();
    await p.waitForFunction(() => document.querySelector(".editor__dup") && !document.querySelector(".editor__dup").hidden);
    assert.equal((await vault()).find(c => c.id === second.id).qr_payload, ""); await close(p);
  });
  await check("phone editor keeps HA pull controls within the viewport", async () => {
    await p.setViewportSize({ width: 390, height: 1000 }); await open(p, second.id);
    await p.locator("#ed-ha-attribute").scrollIntoViewIfNeeded();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.ARTIFACT_DIR) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "ha-pull-phone.png") });
    await close(p); await p.setViewportSize({ width: 1440, height: 1000 });
  });
  for (const [label, reply, expected] of [
    ["missing HA attribute", { status: 404, error: "ha_attribute_not_found" }, "not found"],
    ["unreachable HA", { status: 503, error: "ha_unavailable" }, "Could not read"],
    ["unsupported attribute value", { status: 422, error: "ha_code_invalid" }, "supported pairing"],
    ["unrecognized text", { text: "Some unrelated attribute" }, "supported pairing"],
  ]) await check(label + " gives visible feedback and leaves the vault intact", async () => {
    const before = await vault(); response = reply; await open(p, second.id); await pull(p);
    await p.waitForFunction(text => document.getElementById("ed-ha-pull-status").textContent.includes(text), expected);
    assert.deepEqual(await vault(), before); await close(p);
  });
  const offlineFile = path.join(storage, "anti-matter-viewer.html");
  await check("Import & export downloads a generic viewer with no vault data", async () => {
    await p.evaluate(() => AM.act("openImportExport"));
    const download = p.waitForEvent("download"); await p.locator("#io-viewer").click();
    const d = await download; assert.equal(d.suggestedFilename(), "anti-matter-viewer.html"); await d.saveAs(offlineFile);
    assert.ok(!fs.readFileSync(offlineFile, "utf8").includes("Synthetic pull"));
  });
  const context = await browser.newContext({ offline: true, viewport: { width: 390, height: 1000 } });
  const offline = await context.newPage(), requests = [], offlineErrors = [];
  offline.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  offline.on("pageerror", e => offlineErrors.push(String(e)));
  await offline.goto(pathToFileURL(offlineFile).href);
  const data = { categories: [{ id: "room", name: "Kitchen" }], codes: [
    { name: "Matter fixture", code_type: "matter", qr_payload: MT, category_ids: ["room"], area: "Kitchen" },
    { name: "HomeKit fixture", code_type: "homekit", qr_payload: HK, setup_id: "AB12", homekit_flag: 10 },
    { name: "SmartStart fixture", code_type: "zwave", qr_payload: ZW },
    { name: "Unicode fixture", code_type: "other", qr_payload: "Local QR: café ☕ 家" },
    { name: "Manual only fixture", code_type: "homekit", manual_code: "111-22-333" },
    { name: "Deleted fixture", code_type: "other", deleted_at: "2026-01-01" },
  ] };
  await check("downloaded file opens current backups entirely offline and filters by category/protocol/search", async () => {
    await load(offline, data); await offline.locator(".code").first().waitFor();
    assert.equal(await offline.locator(".code").count(), 5);
    await offline.locator("#viewer-category").selectOption("id:room"); assert.equal(await offline.locator(".code").count(), 1);
    await offline.locator("#viewer-category").selectOption(""); await offline.locator("#viewer-protocol").selectOption("homekit");
    assert.equal(await offline.locator(".code").count(), 2);
    await offline.locator("#viewer-search").fill("Manual only"); assert.equal(await offline.locator(".code").count(), 1);
    await offline.locator("summary").click(); await offline.locator(".code-body").waitFor(); assert.equal(await offline.locator("svg.qr").count(), 0);
    await offline.locator("#viewer-search").fill(""); await offline.locator("#viewer-protocol").selectOption("");
    await offline.locator("#viewer-trash").check(); assert.equal(await offline.locator(".code").count(), 6);
  });
  const images = [];
  await check("stored Matter, HomeKit, SmartStart and Unicode QR payloads decode independently without truncation", async () => {
    for (const c of data.codes.slice(0, 4)) {
      const item = offline.locator(".code").filter({ has: offline.locator("strong", { hasText: c.name }) });
      await item.locator("summary").click(); await item.locator("svg.qr").waitFor();
      const svg = await item.locator("svg.qr").evaluate(n => new XMLSerializer().serializeToString(n));
      images.push({ svg, expected: c.qr_payload });
    }
    const decoded = await p.evaluate(async images => {
      const worker = new Worker("static/brand/js/scan-worker.js");
      await new Promise((resolve, reject) => { worker.onmessage = e => e.data.type === "ready" ? resolve() : e.data.type === "init-error" ? reject(Error("decoder init")) : null; worker.onerror = reject; });
      try {
        const result = [];
        for (let i = 0; i < images.length; i++) {
          const img = new Image(); img.src = "data:image/svg+xml;base64," + btoa(images[i].svg); await img.decode();
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 800;
          const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0, 800, 800);
          result.push(await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error("QR decode timeout")), 20000);
            worker.onmessage = e => { if (e.data.id === i) { clearTimeout(timer); resolve(e.data.results.map(r => r.text)); } };
            worker.postMessage({ id: i, type: "scanImage", imageData: ctx.getImageData(0, 0, 800, 800), options: { exhaustive: true } });
          }));
        }
        return result;
      } finally { worker.terminate(); }
    }, images);
    decoded.forEach((texts, i) => assert.ok(texts.includes(images[i].expected), "QR payload round trip " + i));
  });
  await check("legacy export and singular category_id remain readable", async () => {
    await load(offline, fs.readFileSync(path.join(ROOT, "anti_matter/tests/fixtures/export-2.0.5.json"), "utf8"), "legacy.json");
    await offline.waitForFunction(() => document.getElementById("viewer-filename").textContent === "legacy.json");
    assert.ok(await offline.locator(".code").count() > 0);
    await load(offline, { categories: [{ id: "room", name: "Kitchen" }], codes: [{ name: "Legacy category", category_id: "room" }] }, "singular.json");
    await offline.waitForFunction(() => document.getElementById("viewer-filename").textContent === "singular.json");
    await offline.locator("#viewer-category").selectOption("id:room"); assert.equal(await offline.locator(".code").count(), 1);
  });
  await check("invalid JSON and malformed records preserve the previously opened backup", async () => {
    for (const value of ["{", { codes: [null] }, { codes: [{}], categories: [42] }]) {
      await load(offline, value); await offline.locator("#viewer-error").waitFor();
      assert.equal(await offline.locator("#viewer-filename").textContent(), "singular.json"); assert.equal(await offline.locator(".code").count(), 1);
    }
  });
  await check("untrusted names, categories, notes and payloads stay inert text", async () => {
    const attack = '<img src="https://example.invalid/steal" onerror="window.attacked=true"></script><script>window.attacked=true</script>';
    await load(offline, { categories: [{ id: "evil", name: attack }], codes: [{ name: attack, notes: attack, qr_payload: attack, category_ids: ["evil"] }] }, "inert.json");
    await offline.waitForFunction(() => document.getElementById("viewer-filename").textContent === "inert.json");
    await offline.locator("summary").click(); await offline.locator(".code-body").waitFor();
    assert.ok((await offline.locator(".code-body").textContent()).includes(attack));
    assert.equal(await offline.locator("#viewer img, #viewer script").count(), 0); assert.equal(await offline.evaluate(() => window.attacked), undefined);
    assert.equal(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  if (process.env.ARTIFACT_DIR) {
    await load(offline, data, "synthetic-preview.json");
    await offline.waitForFunction(() => document.getElementById("viewer-filename").textContent === "synthetic-preview.json");
    await offline.locator(".code").first().locator("summary").click(); await offline.locator("svg.qr").waitFor();
    await offline.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "viewer-phone.png"), fullPage: true });
    await offline.setViewportSize({ width: 1440, height: 1000 });
    await offline.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "viewer-desktop.png"), fullPage: true });
  }
  await check("pagination bounds DOM size and Clear removes loaded records", async () => {
    await load(offline, { codes: Array.from({ length: 121 }, (_, i) => ({ name: "Record " + i })) }, "pages.json");
    await offline.waitForFunction(() => document.getElementById("viewer-filename").textContent === "pages.json");
    assert.equal(await offline.locator(".code").count(), 50); await offline.locator("#viewer-next").click();
    assert.equal(await offline.locator(".code").count(), 50); await offline.locator("#viewer-next").click(); assert.equal(await offline.locator(".code").count(), 21);
    await offline.locator("#viewer-clear").click(); assert.equal(await offline.locator(".code").count(), 0);
  });
  await check("offline viewer makes no network request, has no console errors or persistent storage", async () => {
    assert.deepEqual(requests, []); assert.deepEqual(offlineErrors, []); assert.deepEqual(errors, []);
    assert.equal(await offline.evaluate(() => localStorage.length), 0);
  });
  console.log(`ha-pull-viewer: ${passed} checks passed`);
} finally {
  if (release) release(); if (browser) await browser.close(); server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve)); fs.rmSync(storage, { recursive: true, force: true });
}

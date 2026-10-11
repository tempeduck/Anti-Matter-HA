// HomeKit display regressions against the real app, using synthetic setup data.
// Existing records must render completely without a background database rewrite.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3";
const PORT = Number(process.env.PORT || 18815);
const BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-homekit-"));
// Independent fixture packing follows the documented 46-bit HomeKit layout.
function fixture(category, flags, setup = "AB12", version = 0, reserved = 0, pin = 11122333) {
  const packed = BigInt(pin) | (BigInt(flags) << 27n) | (BigInt(category) << 31n)
    | (BigInt(reserved) << 39n) | (BigInt(version) << 43n);
  return "X-HM://" + packed.toString(36).toUpperCase().padStart(9, "0") + setup;
}
execFileSync(PYTHON, [path.join(ROOT, "tools/screenshots/seed_demo.py"), storage], { stdio: "ignore" });
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_DATA: storage,
  ANTIMATTER_OPTIONS: path.join(storage, "options.json"), ANTIMATTER_MEDIA: path.join(storage, "media"), ANTIMATTER_PORT: String(PORT) };
delete env.SUPERVISOR_TOKEN;
delete env.HASSIO_TOKEN;
const server = spawn(PYTHON, ["main.py"], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
let browser;
let passed = 0;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const vault = async () => (await (await fetch(BASE + "api/vault")).json()).codes;
async function add(name, qr, extra = {}) {
  const response = await fetch(BASE + "api/codes", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code_type: "homekit", qr_payload: qr, ...extra }) });
  assert.equal(response.status, 201);
  return response.json();
}
async function page(lang = "en", width = 1440) {
  const p = await browser.newPage({ viewport: { width, height: width < 720 ? 844 : 1000 } });
  p.errors = [];
  p.on("pageerror", error => p.errors.push(String(error)));
  p.on("console", message => { if (message.type() === "error") p.errors.push(message.text()); });
  await p.route("**/api/matter/**", route => route.fulfill({ status: 204 }));
  await p.goto(BASE + "?lang=" + lang);
  await p.waitForFunction(() => AM.store.vault && document.documentElement.classList.contains("am-loaded"));
  return p;
}
async function open(p, id) {
  await p.evaluate(id => AM.act("openDetail", id), id);
  await p.locator("#detail-decoded").waitFor();
}
async function close(p, sheet) {
  await p.evaluate(sheet => AM.sheets.close(sheet, null, "api"), sheet);
  await p.waitForFunction(sheet => !AM.sheets.isOpen(sheet), sheet);
}

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
    if (attempt > 100) throw new Error("Backend did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const garageQr = fixture(4, 10);
  const garage = await add("Synthetic HomeKit garage", garageQr);
  const custom = await add("Synthetic custom type", fixture(4, 10, "CD34", 0, 0, 22233444), { device_type: "custom_cover" });
  const ble = await add("Synthetic BLE lock", fixture(6, 4, "EF56", 0, 0, 33344555));
  const advancedQr = fixture(4, 10, "GH78", 2, 9, 44455666);
  const advanced = await add("Synthetic format fields", advancedQr);
  const rawBefore = fs.readFileSync(path.join(storage, "anti_matter.json"));
  browser = await chromium.launch();
  let p = await page();
  await open(p, garage.id);
  await check("existing HomeKit record displays its inferred type and IP/WAC capabilities", async () => {
    assert.match(await p.locator(".facts").textContent(), /garage door/i);
    assert.match(await p.locator("#detail-decoded").textContent(), /Garage door opener/);
    assert.match(await p.locator("#detail-decoded").textContent(), /AB12/);
    assert.match(await p.locator("#detail-decoded").textContent(), /IP \(Wi-Fi\/Ethernet\).*Apple Wi-Fi setup \(WAC\)/);
    assert.equal(await p.locator("#detail-decoded details").getAttribute("open"), null);
  });
  await p.locator("#detail-decoded details summary").click();
  await check("QR details show raw flags, category, format version and reserved bits including zero", async () => {
    const values = await p.locator("#detail-decoded details .readout").evaluateAll(nodes => Object.fromEntries(
      nodes.map(node => [node.querySelector(".key").textContent, node.querySelector(".readout__value").textContent])));
    assert.deepEqual(values, { "Connection flags": "10", "Category ID": "4", "Format version": "0", "Reserved bits": "0" });
    await p.evaluate(() => AM.refresh({ force: true }));
    assert.equal(await p.locator("#detail-decoded details").getAttribute("open"), "");
  });
  await close(p, "sheet-detail");
  await check("inferred types appear in table, type filters and ordinary text search", async () => {
    await p.locator('#view-switch [data-view="table"]').click();
    assert.match(await p.locator(`#view-table tr[data-id="${garage.id}"]`).textContent(), /garage door/i);
    const matches = await p.evaluate(id => {
      AM.filters.set({ type: ["garage_door"] });
      AM.filters.prune();
      const filtered = AM.filters.apply().some(code => code.id === id);
      const hasChoice = AM.filters.values("type").some(choice => choice.value === "garage_door");
      AM.filters.clear({ query: true });
      AM.filters.set({ query: "garage door" });
      const searched = AM.filters.apply().some(code => code.id === id);
      AM.filters.clear({ query: true });
      return { filtered, hasChoice, searched };
    }, garage.id);
    assert.deepEqual(matches, { filtered: true, hasChoice: true, searched: true });
  });
  await open(p, custom.id);
  await check("custom types remain authoritative in details and editor", async () => {
    assert.match(await p.locator(".facts").textContent(), /custom cover/i);
    await p.locator("#detail-edit").click();
    assert.equal(await p.locator("#ed-type").inputValue(), "custom_cover");
    await close(p, "sheet-editor");
  });
  await close(p, "sheet-detail");
  await open(p, ble.id);
  await check("BLE-only QR never advertises IP or WAC", async () => {
    const text = await p.locator("#detail-decoded").textContent();
    assert.match(text, /BLE/);
    assert.doesNotMatch(text, /Wi-Fi\/Ethernet|WAC/);
  });
  await close(p, "sheet-detail");
  await check("displaying and filtering records performs no vault rewrite or connection-toggle changes", async () => {
    assert.deepEqual(fs.readFileSync(path.join(storage, "anti_matter.json")), rawBefore);
    const stored = (await vault()).find(code => code.id === garage.id);
    assert.equal(stored.device_type, "");
    assert.equal(stored.conn_wifi, false);
    assert.equal(stored.conn_bluetooth, false);
    assert.equal(stored.qr_payload, garageQr);
  });
  await p.evaluate(id => AM.act("openEditor", id), garage.id);
  await check("existing blank type is prefilled and only persists on an explicit save", async () => {
    assert.equal(await p.locator("#ed-type").inputValue(), "garage_door");
    await p.locator("#editor-save").click();
    await p.waitForFunction(() => !AM.sheets.isOpen("sheet-editor"));
    const stored = (await vault()).find(code => code.id === garage.id);
    assert.equal(stored.device_type, "garage_door");
    assert.equal(stored.qr_payload, garageQr);
    assert.equal(stored.homekit_flag, 10);
  });
  await open(p, advanced.id);
  await check("nonzero format fields display and survive editing pairing-related fields", async () => {
    await p.locator("#detail-decoded details summary").click();
    const before = await p.locator("#detail-decoded details .readout__value").allTextContents();
    assert.deepEqual(before, ["10", "4", "2", "9"]);
    await p.locator("#detail-edit").click();
    await p.locator("#ed-hk-sid").fill("ZZ99");
    await p.locator("#editor-save").click();
    await p.waitForFunction(() => !AM.sheets.isOpen("sheet-editor"));
    const record = (await vault()).find(code => code.id === advanced.id);
    assert.equal(record.qr_payload, advancedQr.slice(0, -4) + "ZZ99");
  });
  await close(p, "sheet-detail");
  await check("new scanner save reuses HomeKit capabilities and stores the inferred type", async () => {
    const qr = fixture(4, 10, "JK12", 0, 0, 55566777);
    await p.evaluate(qr => AM.act("openScanner", { mode: "vault", source: "paste", text: qr }), qr);
    await p.locator("#scn-paste").waitFor();
    await p.locator("#scn-paste").fill(qr);
    await p.locator("#scn-paste").press("Enter");
    await p.locator(".result:not([hidden])").waitFor();
    assert.match(await p.locator(".result:not([hidden]) .readouts").textContent(), /IP \(Wi-Fi\/Ethernet\).*WAC/);
    const batch = p.locator(".result:not([hidden]) #scn-batch");
    if (await batch.count()) await batch.uncheck();
    await p.locator(".result:not([hidden]) .result__foot .btn--primary").click();
    await p.waitForFunction(() => !AM.sheets.isOpen("scanner"));
    const record = (await vault()).find(code => code.qr_payload === qr);
    assert.equal(record.device_type, "garage_door");
    assert.equal(record.homekit_flag, 10);
    assert.equal(record.conn_wifi, false);
  });
  assert.deepEqual(p.errors, []);
  await p.close();
  for (const [lang, width] of [["en", 390], ["nl", 320], ["ar", 320]]) {
    p = await page(lang, width);
    await open(p, garage.id);
    await p.locator("#detail-decoded details summary").click();
    await check(`${lang} phone: complete details fit and use translated labels`, async () => {
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await p.evaluate(() => {
        const el = document.getElementById("detail-body"); return el.scrollWidth <= el.clientWidth + 1;
      }), true, JSON.stringify(await p.evaluate(() => {
        const body = document.getElementById("detail-body"), edge = body.getBoundingClientRect();
        return Array.from(body.querySelectorAll(".readout, .readouts, .readout__value, .key, summary")).map(el => {
          const r = el.getBoundingClientRect(); return { cls: el.className, width: r.width, left: r.left, right: r.right };
        }).filter(r => r.right > edge.right + 1 || r.left < edge.left - 1);
      })));
      const text = await p.locator("#detail-decoded").textContent();
      assert.doesNotMatch(text, /decode\.hk_/);
      if (lang !== "en") assert.doesNotMatch(text, /Connection capabilities|Reserved bits/);
      assert.deepEqual(p.errors, []);
    });
    await p.close();
  }
  console.log(`homekit: ${passed} checks passed`);
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  fs.rmSync(storage, { recursive: true, force: true });
}

// Real UI/backend with synthetic HA replies; delayed requests and backup faults
// must preserve user edits and the current vault. No access to a live HA instance.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3";
const PORT = Number(process.env.PORT || 18818);
const BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-ha-linking-"));
execFileSync(PYTHON, [path.join(ROOT, "tools/screenshots/seed_demo.py"), storage], { stdio: "ignore" });
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_OPTIONS: path.join(storage, "options.json"),
  ANTIMATTER_MEDIA: path.join(storage, "media"), ANTIMATTER_PORT: String(PORT) };
delete env.SUPERVISOR_TOKEN;
delete env.HASSIO_TOKEN;
const server = spawn(PYTHON, ["main.py"], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
const devices = ["a", "b"].map(letter => ({ id: `device-${letter}`, name: "Outlet", area: "Kitchen",
  manufacturer: "Example vendor", model: `Model ${letter.toUpperCase()}`,
  entity_ids: [`sensor.outlet_${letter}_power`, `switch.outlet_${letter}`] }));
let browser, passed = 0, releaseDevices, status = "available", importCalls = 0;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const currentVault = () => fs.readFileSync(path.join(storage, "anti_matter.json"));
async function add(name, extra = {}) {
  const r = await fetch(BASE + "api/codes", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201);
  return r.json();
}
async function page(lang = "en", width = 1440) {
  const p = await browser.newPage({ viewport: { width, height: 1000 } });
  p.errors = [];
  p.on("pageerror", error => p.errors.push(String(error)));
  await p.route("**/api/matter/**", r => r.fulfill({ status: 204 }));
  await p.route("**/api/info", async r => {
    const response = await r.fetch(); const info = await response.json();
    await r.fulfill({ json: { ...info, ha_available: true } });
  });
  await p.route("**/api/ha/devices*", async r => {
    if (r.request().url().includes("refresh=true")) {
      await new Promise(resolve => { releaseDevices = resolve; });
    }
    await r.fulfill({ json: devices });
  });
  await p.route("**/api/ha/areas", r => r.fulfill({ json: ["Kitchen"] }));
  await p.route("**/api/ha/status*", r => r.fulfill({ json: { entity_id: "switch.outlet_b", availability: status } }));
  await p.goto(BASE + "?lang=" + lang);
  await p.waitForFunction(() => AM.store.vault && AM.ha.devices().length === 2 && document.documentElement.classList.contains("am-loaded"));
  return p;
}
const openEditor = async (p, id) => {
  await p.evaluate(id => AM.act("openEditor", id), id);
  await p.locator("#ed-ha").waitFor();
};
const close = async (p, sheet) => {
  await p.evaluate(sheet => AM.sheets.close(sheet, null, "api"), sheet);
  await p.waitForFunction(sheet => !AM.sheets.isOpen(sheet), sheet);
  await p.locator("#" + sheet).waitFor({ state: "hidden" });
};
const save = async p => {
  await p.locator("#editor-save").click();
  await p.waitForFunction(() => !AM.sheets.isOpen("sheet-editor"));
  await p.locator("#sheet-editor").waitFor({ state: "hidden" });
  await p.waitForFunction(() => !document.getElementById("editor-save").disabled);
};
const saved = async id => (await (await fetch(BASE + "api/vault")).json()).codes.find(c => c.id === id);

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
    if (attempt > 100) throw Error("Backend did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const empty = await add("Synthetic empty metadata");
  const custom = await add("Synthetic custom metadata", { device_vendor: "Custom vendor", area: "Custom area",
    ha_link: { device_id: "device-a" } });
  browser = await chromium.launch();
  let p = await page();
  await check("same-name same-area devices have distinct labels and searchable entities", async () => {
    assert.equal(await p.evaluate(() => new Set(AM.ha.devices().map(d => AM.ha.label(d))).size), 2);
    await openEditor(p, empty.id);
    await p.locator("#ed-ha").fill("switch.outlet_b");
    await p.locator("#ed-ha-list .combobox__opt").waitFor();
    assert.equal(await p.locator("#ed-ha-list .combobox__opt").count(), 1);
    assert.match(await p.locator("#ed-ha-list .combobox__opt").textContent(), /switch.outlet_b/);
    await p.locator("#ed-ha-list .combobox__opt").click();
    assert.equal(await p.locator("#ed-vendor").inputValue(), "Example vendor");
    assert.equal(await p.locator("#ed-product").inputValue(), "Model B");
    assert.equal(await p.locator("#ed-area").inputValue(), "Kitchen");
    await p.locator("#ed-ha-entity").selectOption("switch.outlet_b");
    await save(p);
    assert.deepEqual((await saved(empty.id)).ha_link, { device_id: "device-b", entity_id: "switch.outlet_b" });
  });
  await check("device changes clear the selected entity; saving a device-only link remains valid", async () => {
    await openEditor(p, empty.id);
    assert.equal(await p.locator("#ed-ha-entity").inputValue(), "switch.outlet_b");
    await p.locator("#ed-ha").fill("switch.outlet_a");
    await p.locator("#ed-ha-list .combobox__opt").click();
    assert.equal(await p.locator("#ed-ha-entity").inputValue(), "");
    assert.equal(await p.locator("#ed-product").inputValue(), "Model B", "existing metadata preserved");
    await save(p);
    assert.deepEqual((await saved(empty.id)).ha_link, { device_id: "device-a", entity_id: null });
  });
  await check("delayed refresh preserves typed edits and saved vendor/area", async () => {
    await openEditor(p, custom.id);
    await p.locator("#ed-ha-refresh").click();
    for (let n = 0; !releaseDevices && n < 100; n++) await p.waitForTimeout(10);
    assert.ok(releaseDevices);
    await p.locator("#ed-product").fill("Typed while HA was pending");
    releaseDevices(); releaseDevices = null;
    await p.waitForFunction(() => !document.getElementById("ed-ha-refresh").disabled);
    assert.equal(await p.locator("#ed-product").inputValue(), "Typed while HA was pending");
    assert.equal(await p.locator("#ed-vendor").inputValue(), "Custom vendor");
    assert.equal(await p.locator("#ed-area").inputValue(), "Custom area");
    await save(p);
  });
  await check("late refresh cannot fill another editor", async () => {
    await openEditor(p, custom.id);
    await p.locator("#ed-ha-refresh").click();
    for (let n = 0; !releaseDevices && n < 100; n++) await p.waitForTimeout(10);
    assert.ok(releaseDevices);
    await close(p, "sheet-editor");
    const other = await add("Synthetic unrelated editor");
    await p.evaluate(() => AM.refresh({ force: true }));
    await openEditor(p, other.id);
    const completed = p.waitForResponse(r => r.url().includes("refresh=true"));
    releaseDevices(); releaseDevices = null;
    await completed;
    assert.equal(await p.locator("#ed-vendor").inputValue(), "");
    assert.equal(await p.locator("#ed-product").inputValue(), "");
    await close(p, "sheet-editor");
  });
  for (const state of ["available", "unavailable", "unknown", "missing"]) {
    status = state;
    await fetch(BASE + `api/codes/${empty.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ha_link: { device_id: "device-b", entity_id: "switch.outlet_b" } }) });
    await p.evaluate(() => AM.refresh({ force: true }));
    await p.evaluate(id => AM.act("openDetail", id), empty.id);
    await check(`${state} HA entity status displayed independently of Spare`, async () => {
      await p.locator(`.ha-availability[data-availability="${state}"]`).waitFor();
      assert.match(await p.locator(".ha-row").textContent(), /switch.outlet_b/);
      assert.equal((await saved(empty.id)).in_use, false);
    });
    await close(p, "sheet-detail");
  }
  await p.route("**/api/import", r => { importCalls++; return r.continue(); });
  const before = currentVault();
  for (const backupResponse of [{ status: 500, json: { detail: { error: "backup_failed", message: "Storage unavailable" } } },
                               { status: 200, json: { ok: false, reason: "no_vault" } }]) {
    await p.route("**/api/backup", r => r.fulfill(backupResponse));
    await check(`replace import aborts on backup ${backupResponse.status === 500 ? "request failure" : "negative result"}`, async () => {
      await p.evaluate(() => {
        AM.confirm = async () => true;
        return AM.act("importFile", new File(['{"codes":[]}'], "synthetic.json", { type: "application/json" }));
      });
      await p.locator('#import-body [data-value="replace"]').click();
      await p.locator("#import-confirm").click();
      await p.getByText("Backup failed. Your vault was not replaced. Check storage and try again.", { exact: true }).last().waitFor();
      await p.waitForFunction(() => !document.getElementById("import-confirm").disabled);
      assert.equal(importCalls, 0);
      assert.deepEqual(currentVault(), before);
      await close(p, "dialog-import");
    });
    await p.unroute("**/api/backup");
  }
  await check("closing import during backup prevents a later replacement", async () => {
    let finishBackup;
    await p.route("**/api/backup", async r => {
      await new Promise(resolve => { finishBackup = resolve; });
      await r.fulfill({ json: { ok: true, backup: "synthetic-backup.json" } });
    });
    await p.evaluate(() => AM.act("importFile", new File(['{"codes":[]}'], "synthetic.json")));
    await p.locator('#import-body [data-value="replace"]').click();
    await p.locator("#import-confirm").click();
    for (let n = 0; !finishBackup && n < 100; n++) await p.waitForTimeout(10);
    assert.ok(finishBackup);
    await close(p, "dialog-import");
    const completed = p.waitForResponse(r => r.url().endsWith("/api/backup"));
    finishBackup(); await completed;
    await p.waitForTimeout(100);
    assert.equal(importCalls, 0);
    assert.deepEqual(currentVault(), before);
  });
  assert.deepEqual(p.errors, []);
  await p.close();
  for (const [lang, width] of [["en", 390], ["nl", 320], ["ar", 320]]) {
    p = await page(lang, width);
    await openEditor(p, empty.id);
    await check(`${lang} entity selector fits a narrow phone`, async () => {
      assert.equal(await p.locator("#ed-ha-entity").inputValue(), "switch.outlet_b");
      assert.equal(await p.evaluate(() => {
        const body = document.getElementById("editor-body"); return body.scrollWidth <= body.clientWidth + 1;
      }), true, JSON.stringify(await p.evaluate(() => {
        const body = document.getElementById("editor-body"), edge = body.getBoundingClientRect();
        return Array.from(body.querySelectorAll("*")).map(el => {
          const r = el.getBoundingClientRect(); const style=getComputedStyle(el); return { id: el.id, tag:el.tagName, cls:el.getAttribute("class"), parent:el.parentElement.getAttribute("class"), overflow:style.overflow, left: r.left, right: r.right, wrap:style.flexWrap, cols:style.gridTemplateColumns };
        }).filter(r => r.right > edge.right + 1 || r.left < edge.left - 1);
      })));
      assert.doesNotMatch(await p.locator("#editor-body").textContent(), /ha\.entity|ha\.refresh/);
      assert.equal(await p.evaluate(() => {
        const footer = document.querySelector("#sheet-editor .sheet__foot");
        return footer.scrollWidth <= footer.clientWidth + 1;
      }), true, "translated Save button must fit");
      assert.deepEqual(p.errors, []);
    });
    await p.close();
  }
  console.log(`ha-linking: ${passed} checks passed`);
} finally {
  if (releaseDevices) releaseDevices();
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  fs.rmSync(storage, { recursive: true, force: true });
}

// Real browser -> real Anti-Matter -> local fake HA REST/template server.
// Synthetic vault/QR values only; no live HA credentials or access.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3", PORT = Number(process.env.PORT || 18821), BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-discovery-"));
const MT = "MT:Y.K9042C00KA0648G00";
const packed = 11122333n | (10n << 27n) | (4n << 31n);
const HK = "X-HM://" + packed.toString(36).toUpperCase().padStart(9, "0") + "AB12";
const dev = (id, name, entity) => ({ id, name, entity_ids: [entity], manufacturer: "Example vendor", model: "Model A", area: "Kitchen" });
let devices = [dev("device-a", "Matter plug", "sensor.fixture_a"), dev("device-b", "HomeKit light", "sensor.fixture_b"),
  dev("device-c", "Metadata only", "switch.fixture_c"), dev("device-d", "Conflicting device", "sensor.fixture_d"),
  dev("device-e", "No exposed code", "sensor.energy"),
  { ...dev("device-vacuum", "Vacuum without pairing code", "vacuum.synthetic"), integrations: ["matter"] },
  { ...dev("device-homekit-no-code", "HomeKit without pairing code", "light.synthetic_homekit"), integrations: ["homekit_controller"] }];
let states = [{ entity_id: "sensor.fixture_a", attributes: { setup_code: "34970112332", qr_code: MT } },
  { entity_id: "sensor.fixture_b", attributes: { homekit_setup_uri: HK } },
  { entity_id: "switch.fixture_c", state: "on", attributes: {} },
  { entity_id: "sensor.fixture_d", attributes: { qr_code: MT } },
  { entity_id: "sensor.energy", state: "11122333", attributes: { meter_reading: "34970112332" } },
  { entity_id: "vacuum.synthetic", state: "idle", attributes: { friendly_name: "Vacuum without pairing code" } },
  { entity_id: "light.synthetic_homekit", state: "off", attributes: {} }];
let holdNextStates = false, releaseStates = null, stateReads = 0, templateReads = 0;
const fake = http.createServer(async (request, reply) => {
  if (request.url === "/states") {
    stateReads++;
    if (holdNextStates) { holdNextStates = false; await new Promise(resolve => { releaseStates = resolve; }); }
    reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(states));
  } else if (request.url === "/template") {
    templateReads++; let body = ""; for await (const chunk of request) body += chunk;
    const areas = JSON.parse(body).template.includes("areas()");
    reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(areas ? ["Kitchen"] : devices));
  } else if (request.url.startsWith("/states/")) {
    const state = states.find(s => s.entity_id === request.url.slice(8));
    reply.writeHead(state ? 200 : 404, { "Content-Type": "application/json" }); reply.end(JSON.stringify(state || {}));
  } else { reply.writeHead(404); reply.end(); }
});
await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
const fakeURL = `http://127.0.0.1:${fake.address().port}`;
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_OPTIONS: path.join(storage, "options.json"), ANTIMATTER_MEDIA: path.join(storage, "media") };
delete env.SUPERVISOR_TOKEN; delete env.HASSIO_TOKEN;
const launch = `import ha_client; ha_client.SUPERVISOR_CORE=${JSON.stringify(fakeURL)}; import main; main.ha.enabled=True; main.ha.token='synthetic-fixture-only'; import uvicorn; uvicorn.run(main.app,host='127.0.0.1',port=${PORT},log_level='warning')`;
const server = spawn(PYTHON, ["-c", launch], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
let browser, passed = 0;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const vault = async () => (await (await fetch(BASE + "api/vault")).json()).codes;
async function add(name, extra) {
  const response = await fetch(BASE + "api/codes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...extra }) });
  assert.equal(response.status, 201); return response.json();
}
const close = async p => { await p.locator("#dialog-ha-discovery [data-close]").first().click(); await p.locator("#dialog-ha-discovery").waitFor({ state: "hidden" }); };
const open = async p => { await p.locator("#nav-ha-discovery").click(); await p.locator("#had-list").waitFor(); };
const row = (p, name) => p.locator(".had-row").filter({ has: p.locator(".had-row__name", { hasText: name }) });
const backupCount = () => fs.existsSync(path.join(storage, "backups")) ? fs.readdirSync(path.join(storage, "backups")).length : 0;
async function pending() { for (let i = 0; !releaseStates; i++) { if (i > 200) throw Error("HA read did not start"); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function preparePage(width = 1440, lang = "en") {
  const p = await browser.newPage({ viewport: { width, height: 1000 } }); p.errors = [];
  p.on("pageerror", e => p.errors.push(String(e))); await p.route("**/api/matter/**", r => r.fulfill({ status: 204 }));
  await p.goto(BASE + "?lang=" + lang);
  await p.waitForFunction(() => AM.store.vault && AM.ha.devices().length && document.documentElement.classList.contains("am-loaded"));
  return p;
}

try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + "api/info")).ok) break; } catch {} if (i > 100) throw Error("Backend did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  const saved = await add("My saved plug", { manual_code: "34970112332", device_vendor: "Custom vendor", notes: "Custom notes" });
  const metadata = await add("My existing switch", { ha_link: { device_id: "device-c", entity_id: "switch.fixture_c" }, area: "Custom area" });
  await add("My conflicting record", { ha_link: { device_id: "device-d" } });
  browser = await chromium.launch(); const p = await preparePage();
  await check("Search Home Assistant previews matches without writing and uses one registry/state read", async () => {
    const before = await vault(), reads = stateReads, templates = templateReads;
    await open(p);
    assert.equal(stateReads - reads, 1); assert.equal(templateReads - templates, 1);
    assert.deepEqual(await vault(), before); assert.equal(backupCount(), 0);
    assert.equal(await row(p, "My saved plug").getAttribute("data-status"), "update");
    assert.equal(await row(p, "HomeKit light").getAttribute("data-status"), "new");
    assert.equal(await row(p, "My existing switch").getAttribute("data-status"), "update");
    assert.equal(await row(p, "Conflicting device").getAttribute("data-status"), "conflict");
    assert.equal(await p.locator("#had-apply").isDisabled(), true);
    assert.equal(await row(p, "Conflicting device").locator("input").isDisabled(), true);
  });
  await check("selective apply adds one record, fills blanks in one, preserves custom data and verifies backup", async () => {
    const raw = fs.readFileSync(path.join(storage, "anti_matter.json"));
    await row(p, "My saved plug").locator("input").check(); await row(p, "HomeKit light").locator("input").check();
    await p.locator("#had-apply").click(); await p.locator("#had-success").waitFor();
    assert.ok((await p.locator("#had-success").textContent()).includes("1 added · 1 updated"));
    const codes = await vault(); assert.equal(codes.length, 4);
    const current = codes.find(c => c.id === saved.id);
    assert.equal(current.manual_code, saved.manual_code); assert.equal(current.device_vendor, "Custom vendor"); assert.equal(current.notes, "Custom notes"); assert.equal(current.qr_payload, MT);
    assert.equal(codes.find(c => c.id === metadata.id).device_vendor, "");
    assert.equal(codes.find(c => c.qr_payload === HK).setup_id, "AB12");
    const backups = fs.readdirSync(path.join(storage, "backups")); assert.equal(backups.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(storage, "backups", backups[0])), raw);
  });
  await check("repeat scan never creates duplicate codes and can update linked metadata without a pairing code", async () => {
    await p.locator("#had-search-again").click(); await p.locator("#had-list").waitFor();
    assert.equal(await row(p, "My saved plug").getAttribute("data-status"), "unchanged");
    assert.equal(await row(p, "HomeKit light").getAttribute("data-status"), "unchanged");
    await row(p, "My existing switch").locator("input").check(); await p.locator("#had-apply").click(); await p.locator("#had-success").waitFor();
    const codes = await vault(); assert.equal(codes.length, 4);
    const current = codes.find(c => c.id === metadata.id);
    assert.equal(current.area, "Custom area"); assert.equal(current.device_vendor, "Example vendor"); assert.deepEqual(current.ha_link, metadata.ha_link);
    await close(p);
  });
  devices.push(dev("device-f", "Extra Tuya label", "sensor.fixture_f")); states.push({ entity_id: "sensor.fixture_f", attributes: { pairing_qr: "https://link.tuya.com/synthetic-label" } });
  await check("editing the vault after preview blocks the entire apply and asks for a fresh search", async () => {
    await open(p); await row(p, "Extra Tuya label").locator("input").check(); const backups = backupCount();
    await fetch(BASE + "api/codes/" + saved.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: "Concurrent notes" }) });
    await p.locator("#had-apply").click(); await p.locator("#had-error").waitFor();
    assert.ok((await p.locator("#had-error").textContent()).includes("Search again")); assert.equal(await p.locator("#had-apply").isDisabled(), true);
    assert.equal((await vault()).length, 4); assert.equal(backupCount(), backups); await close(p);
  });
  await check("changing HA source details after preview blocks stale metadata", async () => {
    await open(p); await row(p, "Extra Tuya label").locator("input").check(); devices.find(d => d.id === "device-f").model = "Changed model";
    await p.locator("#had-apply").click(); await p.locator("#had-error").waitFor(); assert.equal((await vault()).length, 4); await close(p);
  });
  await check("backup failure is visible and never shows Saved", async () => {
    await open(p); await row(p, "Extra Tuya label").locator("input").check();
    await p.route("**/api/ha/discover/apply", r => r.fulfill({ status: 500, json: { detail: { error: "backup_failed", message: "Safety backup failed. Nothing saved." } } }));
    await p.locator("#had-apply").click(); await p.locator("#had-error").waitFor(); assert.equal(await p.locator("#had-success").count(), 0);
    assert.equal((await vault()).length, 4); await p.unroute("**/api/ha/discover/apply"); await close(p);
  });
  await check("closing an outstanding search prevents old results appearing in a reopened dialog", async () => {
    holdNextStates = true; releaseStates = null; await p.locator("#nav-ha-discovery").click(); await pending();
    await close(p); await open(p); const result = await p.locator("#had-summary").textContent(); releaseStates();
    await p.waitForTimeout(150); assert.equal(await p.locator("#had-summary").textContent(), result); assert.equal(await p.locator("#had-apply").isDisabled(), true); await close(p);
  });
  await check("apply progress remains visible and Close/Escape cannot interrupt a confirmed batch", async () => {
    await open(p); await row(p, "Extra Tuya label").locator("input").check(); holdNextStates = true; releaseStates = null;
    await p.locator("#had-apply").click(); await pending();
    assert.equal(await p.locator("#dialog-ha-discovery [data-close]").first().isDisabled(), true);
    await p.keyboard.press("Escape"); assert.equal(await p.locator("#dialog-ha-discovery").isVisible(), true);
    releaseStates(); await p.locator("#had-success").waitFor(); assert.equal((await vault()).length, 5); await close(p);
  });
  await check("untrusted HA names stay inert and filter/select-all affect only eligible visible rows", async () => {
    devices.find(d => d.id === "device-c").name = '<img src="https://example.invalid/steal" onerror="window.attacked=true">';
    await open(p); assert.equal(await p.locator("#had-list img, #had-list script").count(), 0); assert.equal(await p.evaluate(() => window.attacked), undefined);
    await p.locator("#had-filter").fill("Conflicting device"); assert.equal(await p.locator(".had-row").count(), 1); assert.equal(await p.locator("#had-select-all").isDisabled(), true); await close(p);
  });
  await check("Import & export entry returns to its parent and Open existing edits the matched record without saving", async () => {
    const before = await vault();
    await p.locator("#nav-io").click(); await p.locator("#io-ha-discovery").click(); await p.locator("#had-list").waitFor();
    await close(p); assert.equal(await p.locator("#dialog-import").isVisible(), true);
    await p.locator("#io-ha-discovery").click(); await p.locator("#had-list").waitFor();
    await row(p, "My saved plug").locator("button").click(); await p.locator("#ed-name").waitFor();
    assert.equal(await p.locator("#ed-name").inputValue(), "My saved plug"); assert.deepEqual(await vault(), before);
    await p.evaluate(() => AM.sheets.close(AM.sheets.top(), null, "api"));
    await p.evaluate(() => AM.sheets.close("dialog-import", null, "api")); await p.locator("#dialog-import").waitFor({ state: "hidden" });
  });
  for (const lang of ["en", "ar"]) await check(lang + " phone More menu exposes discovery with a usable layout", async () => {
    const phone = await preparePage(390, lang); await phone.locator("#dock-more").click(); await phone.locator("#more-ha-discovery").click(); await phone.locator("#had-list").waitFor();
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await phone.locator("#had-title").textContent(), "Search Home Assistant");
    if (process.env.ARTIFACT_DIR) await phone.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "discovery-phone-" + lang + ".png") });
    assert.deepEqual(phone.errors, []); await close(phone); await phone.close();
  });
  await check("inventory lists code-less Matter and HomeKit devices with metadata and protocol filters", async () => {
    const before = await vault(); await open(p);
    const vacuum = row(p, "Vacuum without pairing code"), homekit = row(p, "HomeKit without pairing code");
    assert.equal(await vacuum.getAttribute("data-status"), "new");
    assert.equal(await vacuum.locator("input").isEnabled(), true);
    assert.ok((await vacuum.textContent()).includes("Pairing code unavailable"));
    assert.ok((await vacuum.textContent()).includes("Example vendor"));
    assert.ok((await vacuum.textContent()).includes("vacuum.synthetic"));
    assert.ok((await homekit.textContent()).includes("HomeKit"));
    await p.locator("#had-protocol").selectOption("matter");
    assert.equal(await vacuum.count(), 1); assert.equal(await homekit.count(), 0);
    await p.locator("#had-protocol").selectOption("homekit");
    assert.equal(await vacuum.count(), 0); assert.equal(await homekit.count(), 1);
    await p.locator("#had-protocol").selectOption("unknown");
    assert.equal(await row(p, "No exposed code").count(), 1);
    assert.ok((await row(p, "No exposed code").textContent()).includes("Unknown / other"));
    assert.deepEqual(await vault(), before); await close(p);
  });
  await check("selected code-less vacuum saves once and remains editable with blank pairing fields", async () => {
    const before = await vault(), raw = fs.readFileSync(path.join(storage, "anti_matter.json"));
    await open(p); await p.locator("#had-filter").fill("Vacuum without pairing code");
    await p.locator("#had-select-all").check(); await p.locator("#had-apply").click(); await p.locator("#had-success").waitFor();
    const codes = await vault(), vacuum = codes.find(c => c.ha_link.device_id === "device-vacuum");
    assert.equal(codes.length, before.length + 1); assert.equal(vacuum.code_type, "matter");
    assert.equal(vacuum.device_type, "vacuum"); assert.equal(vacuum.manual_code, ""); assert.equal(vacuum.qr_payload, "");
    assert.equal(vacuum.conn_matter, false); assert.equal(vacuum.ha_link.entity_id, "vacuum.synthetic");
    const backup = (await p.locator("#had-success").textContent()).match(/Safety backup: (\S+\.json)/)[1];
    assert.deepEqual(fs.readFileSync(path.join(storage, "backups", backup)), raw);
    await p.locator("#had-search-again").click(); await p.locator("#had-list").waitFor();
    assert.equal(await row(p, "Vacuum without pairing code").getAttribute("data-status"), "unchanged");
    await row(p, "Vacuum without pairing code").locator("button").click(); await p.locator("#ed-name").waitFor();
    assert.equal(await p.locator("#ed-name").inputValue(), "Vacuum without pairing code");
    assert.ok(await p.locator("#ed-name").isEditable());
    await p.evaluate(() => AM.sheets.close(AM.sheets.top(), null, "api"));
    assert.equal((await vault()).filter(c => c.ha_link.device_id === "device-vacuum").length, 1); assert.deepEqual(p.errors, []);
  });
  await check("phone inventory filters and missing-code guidance fit the screen", async () => {
    const phone = await preparePage(390); await phone.locator("#dock-more").click();
    await phone.locator("#more-ha-discovery").click(); await phone.locator("#had-list").waitFor();
    await phone.locator("#had-protocol").selectOption("homekit");
    assert.equal(await row(phone, "HomeKit without pairing code").locator("input").isEnabled(), true);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.ARTIFACT_DIR) await phone.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "inventory-phone.png") });
    assert.deepEqual(phone.errors, []); await close(phone); await phone.close();
  });
  await check("no HA devices gives an empty usable result", async () => {
    devices = []; states = []; await open(p);
    assert.equal(await p.locator(".had-row").count(), 0); assert.equal(await p.locator("#had-apply").isDisabled(), true);
    assert.ok((await p.locator("#had-list").textContent()).includes("No matching")); assert.deepEqual(p.errors, []);
  });
  console.log(`ha-discovery: ${passed} checks passed`);
} finally {
  if (releaseStates) releaseStates(); if (browser) await browser.close();
  server.kill("SIGTERM"); await new Promise(resolve => server.once("exit", resolve));
  await new Promise(resolve => fake.close(resolve)); fs.rmSync(storage, { recursive: true, force: true });
}

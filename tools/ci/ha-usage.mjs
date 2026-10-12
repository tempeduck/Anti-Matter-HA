// Real browser/backend with synthetic HA activity, outages and removal evidence.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3", PORT = Number(process.env.PORT || 18823), BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-ha-usage-"));
let running = true, state = "off", exists = true;
const dev = { id: "device-a", name: "Synthetic active switch", area: "Kitchen", manufacturer: "Example vendor", model: "Model A", entity_ids: ["switch.fixture"] };
const fake = http.createServer(async (request, reply) => {
  reply.setHeader("Content-Type", "application/json");
  if (request.url === "/config") return reply.end(JSON.stringify({ state: running ? "RUNNING" : "STARTING" }));
  if (request.url === "/template") {
    let body = ""; for await (const chunk of request) body += chunk;
    const template = JSON.parse(body).template;
    if (template.includes("has_value(eid)")) {
      const ids = JSON.parse(template.match(/for did in (\[.*?\]) %}/)[1]);
      return reply.end(JSON.stringify(ids.map(id => ({ id, exists: id === "device-a" && exists,
        entity_ids: id === "device-a" && exists ? dev.entity_ids : [],
        active_entity_ids: id === "device-a" && exists && !["unknown", "unavailable", ""].includes(state) ? dev.entity_ids : [] }))));
    }
    return reply.end(JSON.stringify(template.includes("areas()") ? ["Kitchen"] : exists ? [dev] : []));
  }
  if (request.url === "/states/switch.fixture" && exists) return reply.end(JSON.stringify({ entity_id: "switch.fixture", state, attributes: {} }));
  if (request.url === "/states") return reply.end(JSON.stringify(exists ? [{ entity_id: "switch.fixture", state, attributes: {} }] : []));
  reply.writeHead(404); reply.end("{}");
});
await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_OPTIONS: path.join(storage, "options.json"), ANTIMATTER_MEDIA: path.join(storage, "media") };
delete env.SUPERVISOR_TOKEN; delete env.HASSIO_TOKEN;
const launch = `
import ha_client
ha_client.SUPERVISOR_CORE=${JSON.stringify(`http://127.0.0.1:${fake.address().port}`)}
import main
from fastapi.responses import HTMLResponse
from pathlib import Path
main.ha.enabled=True
main.ha.token='synthetic-fixture-only'
clock=[1000.0]
main._usage_now=lambda:clock[0]
@main.app.post('/fixture/sync')
async def sync_fixture():
 clock[0]+=60
 return {'changed':await main._sync_ha_usage()}
@main.app.get('/fixture-preview')
async def preview_fixture():
 html=(Path(main.STATIC_DIR)/'index.html').read_text()
 opener="<script>const usagePreview=setInterval(()=>{if(window.AM&&AM.store.vault&&AM.store.vault.codes.length&&document.documentElement.classList.contains('am-loaded')){clearInterval(usagePreview);AM.act('openEditor',AM.store.vault.codes[0].id);setTimeout(()=>{document.querySelector('.editor__details').open=true;},100);}},50);</script>"
 return HTMLResponse(html.replace('</body>',opener+'</body>'))
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=${PORT},log_level='warning')
`;
const server = spawn(PYTHON, ["-c", launch], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
let browser, passed = 0;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const sync = async () => (await (await fetch(BASE + "fixture/sync", { method: "POST" })).json()).changed;
const codes = async () => (await (await fetch(BASE + "api/vault")).json()).codes;
const close = async p => { await p.evaluate(() => AM.sheets.close("sheet-editor", null, "api")); await p.locator("#sheet-editor").waitFor({ state: "hidden" }); };
const open = async (p, id) => { await p.evaluate(id => AM.act("openEditor", id), id); await p.locator("#ed-inuse-mode").waitFor({ state: "attached" }); await p.locator(".editor__details").evaluate(el => { el.open = true; }); };
const save = async p => { await p.locator("#editor-save").click(); await p.locator("#sheet-editor").waitFor({ state: "hidden" }); };
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: 1000 } }); p.errors = [];
  p.on("pageerror", e => p.errors.push(String(e)));
  await p.route("**/api/matter/**", r => r.fulfill({ status: 204 }));
  await p.goto(BASE + "?lang=en");
  await p.waitForFunction(() => AM.store.vault && document.documentElement.classList.contains("am-loaded"));
  return p;
}
try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + "api/info")).ok) break; } catch {} if (i > 100) throw Error("Backend did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  const response = await fetch(BASE + "api/codes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Synthetic active switch", ha_link: { device_id: "device-a", entity_id: "switch.fixture" } }) });
  assert.equal(response.status, 201); const record = await response.json();
  browser = await chromium.launch(); const p = await page(1440);
  await check("automatic mode waits for confirmed activity and an OFF switch is deployed", async () => {
    assert.equal((await codes())[0].in_use, false); state = "unknown"; assert.equal(await sync(), 0);
    state = "off"; const before = fs.readFileSync(path.join(storage, "anti_matter.json")); assert.equal(await sync(), 1);
    const backup = fs.readdirSync(path.join(storage, "backups")); assert.equal(backup.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(storage, "backups", backup[0])), before);
    await p.evaluate(() => AM.refresh({ force: true })); await open(p, record.id);
    assert.equal(await p.locator("#ed-inuse").isChecked(), true);
    assert.equal(await p.locator("#ed-inuse-mode").inputValue(), "auto");
    assert.ok((await p.locator("#ed-inuse-hint").textContent()).includes("Stays on during outages")); await close(p);
  });
  await check("temporary unavailability keeps In use and does not create repeated backups", async () => {
    state = "unavailable"; const before = fs.readFileSync(path.join(storage, "anti_matter.json"));
    assert.equal(await sync(), 0); assert.equal((await codes())[0].in_use, true);
    assert.deepEqual(fs.readFileSync(path.join(storage, "anti_matter.json")), before);
    assert.equal(fs.readdirSync(path.join(storage, "backups")).length, 1);
  });
  await check("manual toggle opts out and a fresh active state cannot overwrite it", async () => {
    await open(p, record.id); await p.locator("#ed-inuse").uncheck();
    assert.equal(await p.locator("#ed-inuse-mode").inputValue(), "manual"); await save(p);
    state = "on"; assert.equal(await sync(), 0);
    assert.equal((await codes())[0].in_use, false); assert.equal((await codes())[0].in_use_mode, "manual");
  });
  await check("returning to automatic tracking confirms activity again", async () => {
    await open(p, record.id); await p.locator("#ed-inuse-mode").selectOption("auto"); await save(p);
    assert.equal(await sync(), 1); assert.equal((await codes())[0].in_use, true);
  });
  await check("an editor opened before a background check preserves the newer automatic flag", async () => {
    await fetch(BASE + `api/codes/${record.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ in_use: false, in_use_mode: "manual" }) });
    await p.evaluate(() => AM.refresh({ force: true })); await open(p, record.id);
    await p.locator("#ed-inuse-mode").selectOption("auto");
    // Activate automatic mode while the unchanged editor still has its old flag.
    await fetch(BASE + `api/codes/${record.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ in_use_mode: "auto" }) });
    assert.equal(await sync(), 1); await p.locator("#ed-notes").fill("Notes survive background confirmation"); await save(p);
    assert.equal((await codes())[0].in_use, true); assert.equal((await codes())[0].notes, "Notes survive background confirmation");
  });
  await check("startup is inconclusive; removal needs two running-HA registry observations", async () => {
    exists = false; running = false; assert.equal(await sync(), 0); assert.equal((await codes())[0].in_use, true);
    running = true; assert.equal(await sync(), 0); assert.equal((await codes())[0].in_use, true);
    assert.equal(await sync(), 1); assert.equal((await codes())[0].in_use, false);
    exists = true; state = "idle"; assert.equal(await sync(), 1);
  });
  await check("phone automatic/manual controls fit and manual choices survive save", async () => {
    const phone = await page(390); await open(phone, record.id);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await phone.locator("#ed-inuse-mode").inputValue(), "auto");
    await phone.locator("#ed-inuse-mode").scrollIntoViewIfNeeded();
    if (process.env.ARTIFACT_DIR) await phone.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "usage-phone.png") });
    await phone.locator("#ed-inuse-mode").selectOption("manual"); await save(phone);
    assert.equal((await codes())[0].in_use_mode, "manual"); assert.equal(await sync(), 0);
    assert.deepEqual(phone.errors, []); await phone.close();
  });
  await check("explicit unlink clears an automatic flag and shows the link-needed hint", async () => {
    await p.evaluate(() => AM.refresh({ force: true })); await open(p, record.id);
    await p.locator("#ed-inuse-mode").selectOption("auto"); await p.locator("#ed-ha").locator("..").locator("button.search__end").click();
    assert.ok((await p.locator("#ed-inuse-hint").textContent()).includes("Link a Home Assistant device"));
    await save(p); assert.equal((await codes())[0].in_use, false); assert.equal((await codes())[0].ha_link.device_id, null);
    assert.deepEqual(p.errors, []);
  });
  console.log(`ha-usage: ${passed} checks passed`);
} finally {
  if (browser) await browser.close();
  const cleanup = () => { server.kill(); fake.close(); fs.rmSync(storage, { recursive: true, force: true }); };
  if (process.env.SCREENSHOT_HOLD && passed === 8) {
    await fetch(BASE + "api/codes/" + (await codes())[0].id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ha_link: { device_id: "device-a", entity_id: "switch.fixture" }, in_use_mode: "auto" }) });
    await sync();
    console.log("Synthetic usage preview ready on localhost");
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } else cleanup();
}

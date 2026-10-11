// Native-scanner UI regressions with the real backend and synthetic pairing data.
// The parent models a Companion camera that covers its ingress iframe; only a
// bar_code/close request dismisses it. No Home Assistant credentials are used.
// Run: PYTHON=/path/to/python node scanner.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3";
const PORT = Number(process.env.PORT || 18812);
const BASE = `http://127.0.0.1:${PORT}/`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "am-scanner-"));
const MATTER = "MT:Y.K9042C00KA0648G00"; // Public CHIP specification example.
const HOMEKIT = execFileSync(PYTHON, ["-c", "from homekit_payload import compose_setup_uri; print(compose_setup_uri(category_id=7,password='11122333',setup_id='AB12'))"],
  { cwd: path.join(ROOT, "anti_matter/app"), encoding: "utf8" }).trim();
execFileSync(PYTHON, [path.join(ROOT, "tools/screenshots/seed_demo.py"), storage], { stdio: "ignore" });
const resetBytes = fs.readFileSync(path.join(storage, "anti_matter.json"));
const initialCount = JSON.parse(resetBytes).codes.length;
const env = { ...process.env, STORAGE_DIR: storage, ANTIMATTER_DATA: storage,
  ANTIMATTER_OPTIONS: path.join(storage, "options.json"), ANTIMATTER_MEDIA: path.join(storage, "media"), ANTIMATTER_PORT: String(PORT) };
delete env.SUPERVISOR_TOKEN;
const server = spawn(PYTHON, ["main.py"], { cwd: path.join(ROOT, "anti_matter/app"), env, stdio: "ignore" });
let browser;
let passed = 0;
const check = async (label, fn) => { await fn(); passed++; console.log("PASS " + label); };
const vault = async () => (await (await fetch(BASE + "api/vault")).json()).codes;

async function companion({ batch, viewport = { width: 390, height: 844 }, lang = "en" } = {}) {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.on("pageerror", error => page.errors.push(String(error)));
  await page.addInitScript(({ batch }) => {
    if (parent !== window) return;
    if (batch !== undefined) localStorage.setItem("antimatter-scan-batch", batch ? "1" : "0");
    else localStorage.removeItem("antimatter-scan-batch");
    window.nativeMessages = [];
    const external = { config: { hasBarCodeScanner: 1 }, msgId: 0,
      fireMessage(message) {
        if (!message.id) message.id = ++this.msgId;
        nativeMessages.push(message);
        if (message.type === "bar_code/scan") document.getElementById("camera-cover").hidden = false;
        if (message.type === "bar_code/close") document.getElementById("camera-cover").hidden = true;
      } };
    window.externalBus = message => {
      if (message.type === "command") external.fireMessage({ type: "result", id: message.id, success: true });
    };
    window.hassConnection = Promise.resolve({ auth: { external } });
  }, { batch });
  await page.route(BASE + "test-companion", route => route.fulfill({ contentType: "text/html", body:
    `<style>body{margin:0}iframe{border:0;width:100vw;height:100vh}#camera-cover{position:fixed;inset:0;background:#222;color:white;z-index:10;padding:40px}#camera-cover[hidden]{display:none}</style><iframe src="/?lang=${lang}"></iframe><div id="camera-cover" hidden>Companion camera</div>` }));
  await page.route("**/api/matter/**", route => route.fulfill({ status: 204 }));
  await page.goto(BASE + "test-companion");
  const frame = page.frames().find(frame => frame.parentFrame());
  await frame.waitForFunction(() => AM.store.vault && AntiMatterHaBridge.available() && document.documentElement.classList.contains("am-loaded"));
  await frame.locator(viewport.width <= 720 ? "#dock-scan" : "#btn-scan").click();
  await frame.locator("#scn-native-batch").waitFor({ state: "visible" });
  return { page, frame };
}

async function openCamera({ page, frame }) {
  const before = await page.evaluate(() => nativeMessages.filter(message => message.type === "bar_code/scan").length);
  await frame.locator(".native-wait__actions .btn--primary").click();
  await page.waitForFunction(before => nativeMessages.filter(message => message.type === "bar_code/scan").length === before + 1, before);
}
async function result({ page }, text) {
  await page.evaluate(text => {
    const request = nativeMessages.filter(message => message.type === "bar_code/scan").at(-1);
    externalBus({ id: request.id, type: "command", command: "bar_code/scan_result", payload: { rawValue: text, format: "qr_code" } });
  }, text);
  await page.waitForFunction(() => document.getElementById("camera-cover").hidden);
}
async function saved({ frame }, count) {
  await frame.waitForFunction(count => AM.store.vault.codes.length === count, count);
  await frame.locator(".result:not([hidden]) [role=status]").waitFor({ state: "visible" });
}

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
    if (attempt > 100) throw new Error("Backend did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  let ctx = await companion();
  await check("batch choice is visible before any native camera request", async () => {
    assert.equal(await ctx.frame.locator("#scn-native-batch").isChecked(), false);
    assert.equal(await ctx.page.evaluate(() => nativeMessages.some(message => message.type === "bar_code/scan")), false);
    assert.match(await ctx.frame.locator("#scn-native-batch-help").textContent(), /Review each code/);
  });
  await openCamera(ctx);
  await result(ctx, MATTER);
  await check("single mode previews a code without saving it", async () => {
    assert.equal((await vault()).length, initialCount);
    assert.match(await ctx.frame.locator(".result:not([hidden]) .result__title").textContent(), /Code found|New to vault/);
  });
  await ctx.frame.locator(".result:not([hidden]) .result__foot .btn--primary").click();
  await check("single save shows confirmation and updates the vault", async () => {
    await ctx.frame.waitForFunction(() => !AM.sheets.isOpen("scanner"));
    assert.equal((await vault()).length, initialCount + 1);
    assert.match(await ctx.frame.locator(".toast").first().textContent(), /Saved/);
  });
  assert.deepEqual(ctx.page.errors, []);
  await ctx.page.close();
  fs.writeFileSync(path.join(storage, "anti_matter.json"), resetBytes);

  ctx = await companion();
  await ctx.frame.locator("#scn-native-batch").check();
  await openCamera(ctx);
  await result(ctx, HOMEKIT);
  await saved(ctx, initialCount + 1);
  await check("batch save dismisses the native cover and visibly confirms HomeKit storage", async () => {
    assert.match(await ctx.frame.locator(".result:not([hidden]) [role=status]").textContent(), /Saved/);
    const record = (await vault()).find(code => code.qr_payload === HOMEKIT);
    assert.equal(record.code_type, "homekit");
    assert.equal(record.manual_code, "11122333");
    assert.match(await ctx.frame.locator(".result:not([hidden]) [role=status]").textContent(), new RegExp(record.name));
    assert.equal(await ctx.frame.locator(".result:not([hidden]) input[type=text]").count(), 0);
    assert.match(await ctx.frame.locator(".result:not([hidden]) .btn--primary").textContent(), /Scan next/);
  });
  const beforeNext = await ctx.page.evaluate(() => nativeMessages.filter(message => message.type === "bar_code/scan").length);
  await ctx.frame.locator(".result:not([hidden]) .btn--primary").click();
  await ctx.page.waitForFunction(before => nativeMessages.filter(message => message.type === "bar_code/scan").length > before, beforeNext);
  await result(ctx, MATTER);
  await saved(ctx, initialCount + 2);
  await check("Scan next saves a second record once and retains batch selection", async () => {
    assert.equal((await vault()).length, initialCount + 2);
    assert.equal(await ctx.frame.locator(".result:not([hidden]) #scn-batch").isChecked(), true);
    assert.equal(await ctx.frame.evaluate(() => document.querySelectorAll("#scn-batch").length), 1);
  });
  await check("batch can be turned off from the saved confirmation", async () => {
    await ctx.frame.locator(".result:not([hidden]) #scn-batch").uncheck();
    assert.match(await ctx.frame.locator(".result:not([hidden]) .btn--primary").textContent(), /Done/);
    await ctx.frame.locator(".result:not([hidden]) #scn-batch").check();
  });
  await ctx.frame.locator(".result:not([hidden]) .btn--primary").click();
  await ctx.page.waitForFunction(() => !document.getElementById("camera-cover").hidden);
  await result(ctx, MATTER);
  await check("duplicate scan returns visible feedback and does not add a record", async () => {
    await ctx.frame.locator(".result--dup:not([hidden])").waitFor();
    assert.equal((await vault()).length, initialCount + 2);
    assert.match(await ctx.frame.locator(".result--dup .result__title").textContent(), /Already in (your )?vault/);
  });
  await ctx.frame.evaluate(() => AM.sheets.close("scanner", "test", "api"));
  await ctx.frame.evaluate(() => AM.act("openScanner", { mode: "vault" }));
  await check("chosen batch preference persists when the scanner reopens", async () => {
    await ctx.frame.locator("#scn-native-batch").waitFor();
    assert.equal(await ctx.frame.locator("#scn-native-batch").isChecked(), true);
  });
  assert.deepEqual(ctx.page.errors, []);
  await ctx.page.close();

  fs.writeFileSync(path.join(storage, "anti_matter.json"), resetBytes);
  ctx = await companion({ batch: true });
  let attemptedSave = false;
  await ctx.page.route("**/api/codes", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attemptedSave = true;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: { code: "internal_error", message: "Synthetic save failure" } }) });
  });
  await openCamera(ctx);
  await result(ctx, MATTER);
  await check("failed storage shows an error and never a Saved confirmation", async () => {
    assert.equal(attemptedSave, true);
    assert.equal((await vault()).length, initialCount);
    assert.equal(await ctx.frame.locator(".result:not([hidden]) [role=status]").count(), 0);
    assert.ok(await ctx.frame.locator(".toast").first().isVisible());
  });
  await ctx.page.close();

  ctx = await companion({ batch: true });
  let releaseLookup;
  let lookupStarted;
  const lookup = new Promise(resolve => { lookupStarted = resolve; });
  const waiting = new Promise(resolve => { releaseLookup = resolve; });
  let saveRequests = 0;
  await ctx.page.route("**/api/codes/check-duplicate", async route => {
    lookupStarted();
    await waiting;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ duplicate: false }) });
  });
  ctx.page.on("request", request => { if (request.url() === BASE + "api/codes" && request.method() === "POST") saveRequests++; });
  await openCamera(ctx);
  await ctx.page.evaluate(text => {
    const request = nativeMessages.filter(message => message.type === "bar_code/scan").at(-1);
    externalBus({ id: request.id, type: "command", command: "bar_code/scan_result", payload: { rawValue: text, format: "qr_code" } });
  }, MATTER);
  await lookup;
  await ctx.page.evaluate(() => {
    const request = nativeMessages.filter(message => message.type === "bar_code/scan").at(-1);
    document.getElementById("camera-cover").hidden = true;
    externalBus({ id: request.id, type: "command", command: "bar_code/aborted", payload: { reason: "canceled" } });
  });
  await ctx.frame.waitForFunction(() => !AM.sheets.isOpen("scanner"));
  releaseLookup();
  await ctx.page.waitForTimeout(1400);
  await check("closing during lookup prevents a delayed batch save", async () => {
    assert.equal(saveRequests, 0);
    assert.equal((await vault()).length, initialCount);
  });
  await ctx.page.close();

  for (const lang of ["nl", "ar"]) {
    ctx = await companion({ batch: false, viewport: { width: 320, height: 740 }, lang });
    await check(`${lang} compact phone: batch controls fit and have accessible labels`, async () => {
      assert.equal(await ctx.frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const box = await ctx.frame.locator("#scn-native-batch").boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320);
      assert.ok(await ctx.frame.locator("label[for=scn-native-batch]").textContent());
      assert.ok(await ctx.frame.locator("#scn-native-batch-help").textContent());
    });
    assert.deepEqual(ctx.page.errors, []);
    await ctx.page.close();
  }
  ctx = await companion({ batch: true, viewport: { width: 1440, height: 900 } });
  await check("existing batch selection is honored on desktop", async () => {
    assert.equal(await ctx.frame.locator("#scn-native-batch").isChecked(), true);
    assert.equal(await ctx.page.evaluate(() => nativeMessages.some(message => message.type === "bar_code/scan")), false);
  });
  await ctx.frame.evaluate(() => AM.sheets.close("scanner", "test", "api"));
  await ctx.frame.evaluate(() => AM.act("openEditor", null));
  await ctx.frame.locator("#editor-scan").click();
  await ctx.frame.locator(".native-wait__actions .btn--primary").waitFor();
  await openCamera(ctx);
  await result(ctx, HOMEKIT);
  await check("editor scans fill the form without batch saving", async () => {
    await ctx.frame.waitForFunction(() => !AM.sheets.isOpen("scanner") && AM.sheets.isOpen("sheet-editor"));
    assert.equal(await ctx.frame.locator("#ed-hk-uri").inputValue(), HOMEKIT);
    assert.equal((await vault()).length, initialCount);
  });
  assert.deepEqual(ctx.page.errors, []);
  await ctx.page.close();
  console.log(`scanner: ${passed} checks passed`);
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  fs.rmSync(storage, { recursive: true, force: true });
}

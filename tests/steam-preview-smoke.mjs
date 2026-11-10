// Exercise the built Next.js application, an isolated SQLite database and
// real browser interactions. Steam responses and accounts are synthetic.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { chromium, expect } from "@playwright/test";
import { key, prefix } from "./steam-preview-fixture.cjs";

const baseline = process.argv.includes("--baseline");
const dir = resolve(process.env.STEAM_QA_DIR ?? "engineering/steam-preview-" + Date.now());
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name);
const token = randomBytes(24).toString("hex"), password = randomBytes(24).toString("hex");
const memberToken = randomBytes(32).toString("hex");
writeFileSync(file("qa.db"), "");
writeFileSync(file("setup-token"), token);
writeFileSync(file("upstream.log"), "");
const env = { ...process.env, DATABASE_URL: "file:" + file("qa.db").replaceAll("\\", "/"),
  SETUP_TOKEN: token, SETUP_TOKEN_FILE: file("setup-token"), APP_URL: "", SECURE_COOKIE: "false",
  NEXT_TELEMETRY_DISABLED: "1", GAMESHELF_QA_STEAM_LOG: file("upstream.log") };
writeFileSync(file("migration.log"), execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
  { env, encoding: "utf8", windowsHide: true }));
let checks = 0, admin = "", browser;
const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const requests = () => readFileSync(file("upstream.log"), "utf8").trim().split(/\r?\n/).filter(Boolean);
const snapshot = value => ({ ...value, exportedAt: "" });

async function withServer(name, apiKey, run) {
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("./steam-preview-fixture.cjs", import.meta.url)),
    resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { env: { ...env, STEAM_WEB_API_KEY: apiKey }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise((res, rej) => { child.once("exit", res); child.once("error", rej); });
  let log = "";
  child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  async function api(path, method = "GET", input, status = 200, cookie = admin, requestHeader = true) {
    const r = await fetch(base + "/api/" + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { cookie, "content-type": "application/json", ...(requestHeader ? { "x-gameshelf-request": "1" } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input)
    });
    const raw = await r.text();
    assert.equal(r.status, status, method + " " + path + " -> " + raw);
    assert.ok(!raw.includes(key));
    assert.equal(r.headers.get("cache-control"), "no-store");
    if (r.headers.has("set-cookie")) admin = r.headers.get("set-cookie").split(";")[0];
    checks++;
    return { body: JSON.parse(raw), retryAfter: r.headers.get("retry-after") };
  }
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(600) })).ok) break; } catch {}
      if (child.exitCode !== null || i === 79) throw new Error("QA server did not become healthy");
      await new Promise(r => setTimeout(r, 150));
    }
    await run(api, base);
    assert.ok(!log.includes(key), "fixture key must not reach the server log");
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    writeFileSync(file(name + "-server.log"), log.replaceAll(token, "[QA_TOKEN]").replaceAll(key, "[QA_KEY]"));
  }
}

const preview = "steam/preview";
const input = suffix => ({ steamId: prefix + suffix });
let before;
try {
  await withServer("disabled", "", async (api) => {
    await api("auth/setup", "POST", { username: "qa-demo", password, passwordConfirm: password, setupToken: token }, 201);
    await api("games", "POST", { title: "QA ローカル作品", rating: 4,
      ownership: { platformId: "PC", storeId: "STEAM", releaseDate: "2024" } }, 201);
    before = snapshot((await api("backup")).body);
    await api(preview, "POST", input("01"), 401, "");
    const catalog = (await api("catalog")).body;
    if (baseline) {
      assert.equal(catalog.steamPreview, undefined);
      await api(preview, "POST", input("01"), 404);
    } else {
      assert.deepEqual(catalog.steamPreview, { configured: false });
      await api(preview, "POST", input("01"), 503);
    }
    assert.deepEqual(requests(), []);
  });
  if (baseline) console.log("BASELINE steam-preview=404 catalog=no-preview library=1 upstream=0");
  else {
    await db.user.create({ data: { id: "qa-member", username: "qa-member", passwordHash: "unused" } });
    await db.session.create({ data: { userId: "qa-member", tokenHash: createHash("sha256").update(memberToken).digest("hex"),
      expiresAt: new Date(Date.now() + 3600000) } });
    await withServer("enabled", key, async (api, base) => {
      const member = "gameshelf_session=" + memberToken;
      assert.equal((await api("catalog", "GET", undefined, 200, member)).body.steamPreview, null);
      assert.deepEqual((await api("catalog")).body.steamPreview, { configured: true });
      await api(preview, "POST", input("01"), 403, member);
      await api(preview, "POST", input("01"), 403, admin, false);
      await api(preview, "POST", { steamId: "not-a-steamid" }, 400);
      await api(preview, "POST", { steamId: Number(prefix + "01") }, 400);
      assert.deepEqual(requests(), []);
      const { body: list } = await api(preview, "POST", input("01"));
      assert.equal(list.state, "listed");
      assert.equal(list.items.length, 13);
      assert.equal(list.skipped, 2);
      assert.equal(list.items[0].playtimeMinutes, 0);
      assert.equal(list.items[1].playtimeMinutes, null);
      assert.equal(list.items.at(-1).appid, 90013);
      for (const suffix of ["02", "03"])
        assert.deepEqual((await api(preview, "POST", input(suffix))).body, { state: "no_visible_games" });
      assert.ok(Number((await api(preview, "POST", input("04"), 429)).retryAfter) > 0);
      await api(preview, "POST", input("05"), 502);
      await api(preview, "POST", input("06"), 502);
      await api(preview, "POST", input("07"), 504);

      const channel = process.env.PLAYWRIGHT_CHANNEL ??
        (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
      browser = await chromium.launch({ channel, headless: true });
      const page = await browser.newPage({ viewport: { width: 1365, height: 920 } });
      const errors = [], outside = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.route("**/*", r => {
        if (new URL(r.request().url()).origin === base) return r.continue();
        outside.push(r.request().url()); return r.abort();
      });
      await page.context().addCookies([{ name: "gameshelf_session", value: admin.split("=")[1], url: base }]);
      await page.goto(base);
      await page.getByRole("button", { name: "Steam 预览" }).click();
      await expect(page.getByRole("heading", { name: "Steam 游戏库预览" })).toBeVisible();
      assert.equal(requests().length, 7, "opening the view must not call Steam");
      await page.getByLabel("SteamID64").fill(prefix + "01");
      await page.getByRole("button", { name: "预览可见游戏" }).click();
      await expect(page.getByRole("status").filter({ hasText: "13 款可见游戏" })).toBeVisible();
      await expect(page.getByText("时长未知", { exact: true })).toBeVisible();
      await page.screenshot({ path: file("steam-preview-desktop.png") });
      await page.getByRole("button", { name: "下一页" }).click();
      await expect(page.getByText("QA Steam サンプル 13", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByText("第 2 / 2 页")).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: file("steam-preview-mobile.png") });
      await page.getByLabel("SteamID64").fill(prefix + "02");
      await expect(page.getByText("QA Steam サンプル 13", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "预览可见游戏" }).click();
      await expect(page.getByRole("status").filter({ hasText: "没有返回可见游戏" })).toBeVisible();
      await page.locator("aside nav").getByRole("button", { name: /游戏库/ }).click();
      await expect(page.getByRole("heading", { name: "QA ローカル作品", exact: true })).toBeVisible();
      await browser.close(); browser = null;
      assert.deepEqual(errors, []);
      assert.deepEqual(outside, []);
      assert.deepEqual(requests(), ["01", "02", "03", "04", "05", "06", "07", "01", "02"]);
      assert.deepEqual(snapshot((await api("backup")).body), before);
      assert.equal(await db.userGameProfile.count(), 1);
      assert.equal(await db.libraryItem.count(), 1);
      console.log("MODIFIED steam-preview=13 pages=2 skipped=2 upstream=9 backup=identical desktop=1365 mobile=390");
    });
  }
  console.log("HTTP_CHECKS=" + checks + " QA_ARTIFACTS=" + dir);
} finally {
  await browser?.close();
  await db.$disconnect();
}

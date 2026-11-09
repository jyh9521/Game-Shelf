// Replays the reported 0.1.7 symptoms against a production build. All
// sessions, upstream API responses, media and SQLite files are isolated.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { env as fixtureEnv, zelda } from "./metadata-fixtures.cjs";

const baseline = process.argv.includes("--baseline");
const dir = resolve(process.env.COVER_PLATFORMS_QA_DIR ?? "engineering/cover-platforms-" + Date.now());
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name);
const token = randomBytes(24).toString("hex"), password = randomBytes(24).toString("hex");
writeFileSync(file("qa.db"), ""); writeFileSync(file("setup-token"), token);
const env = { ...process.env, ...fixtureEnv, DATABASE_URL: "file:" + file("qa.db").replaceAll("\\", "/"),
  SETUP_TOKEN: token, SETUP_TOKEN_FILE: file("setup-token"), APP_URL: "", SECURE_COOKIE: "false",
  NEXT_TELEMETRY_DISABLED: "1", GAMESHELF_QA_PROVIDER_LOG: file("provider-requests.log") };
writeFileSync(file("migration.log"), execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
  { env, encoding: "utf8", windowsHide: true }));
const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const reservation = createServer();
await new Promise(r => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const base = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("./metadata-fixtures.cjs", import.meta.url)),
  resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
  { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const exited = new Promise(r => child.once("exit", r));
let log = "", checks = 0, browser, cookie = "";
child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
async function call(path, method = "GET", input, status = 200, session = cookie) {
  const r = await fetch(base + "/api/" + path, {
    method, signal: AbortSignal.timeout(10000),
    headers: { cookie: session, "content-type": "application/json", "x-gameshelf-request": "1" },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  const b = await r.json();
  assert.equal(r.status, status, method + " " + path + " " + JSON.stringify(b));
  checks++;
  return { data: b, cookie: r.headers.get("Set-Cookie")?.split(";")[0] };
}
const api = async (...args) => (await call(...args)).data;
const stable = b => Object.fromEntries(Object.entries(b).filter(([key]) => key !== "exportedAt").map(([key, value]) =>
  [key, Array.isArray(value) ? value.toSorted((a, b) => a.id.localeCompare(b.id)) : value]));
const legacyCover = "https://cdn.steamgriddb.com/grid/qa-original.png";

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(600) })).ok) break; } catch {}
    if (child.exitCode !== null || i === 79) throw new Error("QA server did not become healthy");
    await new Promise(r => setTimeout(r, 150));
  }
  cookie = (await call("auth/setup", "POST", { username: "platform-qa", password, passwordConfirm: password, setupToken: token }, 201)).cookie;
  if (baseline) {
    const p = await api("platforms", "POST", { name: "QA Nintendo 64" }, 201);
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    await api("platforms", "POST", { name: "QA new platform", code: "N64" }, 400);
    await api("platforms/" + p.id, "PUT", { name: p.name, code: "N64" }, 404);
    await api("platforms/" + p.id, "DELETE", undefined, 404);
    assert.deepEqual((await api("metadata/preview", "POST", { provider: "steamgriddb", id: zelda.id })).items, []);
    console.log("BASELINE PASS HTTP=" + checks + " Zelda-21202-cover-candidates=0 custom-code=400 platform-edit=404 platform-delete=404");
  } else {
    // Directly exercise the missing 0.1.7 create/edit/delete API seam.
    const n64 = await api("platforms", "POST", { name: "QA Nintendo 64", code: "n64" }, 201);
    assert.deepEqual(n64, { id: "N64", name: "QA Nintendo 64" });
    await api("platforms", "POST", { name: "QA Duplicate code", code: "n64" }, 409);
    await api("platforms", "POST", { name: "QA Nintendo 64", code: "DUP" }, 409);
    await api("platforms", "POST", { name: "QA Invalid", code: "path/unsafe" }, 400);
    const unused = await api("platforms", "POST", { name: "QA Saturn" }, 201);
    assert.equal(unused.id, "QA-SATURN");
    await api("platforms/" + unused.id, "DELETE");
    assert.ok(!(await api("catalog")).platforms.some(p => p.id === unused.id));
    const owner = await db.user.findUniqueOrThrow({ where: { id: "admin" } });
    await db.user.create({ data: { id: "qa-viewer", username: "qa-viewer", passwordHash: owner.passwordHash } });
    const viewer = (await call("auth/login", "POST", { username: "qa-viewer", password }, 200, "")).cookie;
    assert.equal((await api("catalog", "GET", undefined, 200, viewer)).canManagePlatforms, false);
    await api("platforms", "POST", { name: "QA foreign platform", code: "OTHER2" }, 403, viewer);
    await api("platforms/N64", "PUT", { name: "QA foreign edit", code: "N64-OTHER" }, 403, viewer);
    await api("platforms/N64", "DELETE", undefined, 403, viewer);

    const ownership = { platformId: n64.id, releaseDate: "1998-11-21", edition: "QA Cartridge", region: "JP" };
    const game = await api("games", "POST", { title: "QA 塞尔达传说：时之笛", coverUrl: legacyCover, ownership, rating: 5 }, 201);
    const gamePath = "games/" + game.id;
    const [original] = (await api(gamePath)).releases;
    assert.match((await api("platforms/N64", "DELETE", undefined, 409)).error, /修改这些记录的发行平台/);
    await api("platforms/N64", "PUT", { name: "QA Conflict", code: "PC" }, 409);
    const revised = await api("platforms/N64", "PUT", { name: "QA Nintendo 64 日本版", code: "n64-jp" });
    assert.deepEqual(revised, { id: "N64-JP", name: "QA Nintendo 64 日本版" });
    const [linked] = (await api(gamePath)).releases;
    assert.equal(linked.platform.id, revised.id); assert.equal(linked.id, original.id);
    assert.deepEqual(linked.contents, original.contents);
    assert.equal((await api("games?platform=N64")).total, 0);
    assert.equal((await api("games?platform=N64-JP")).total, 1);
    assert.equal((await api("games?platform=N64-JP&year=1998&rating=5")).total, 1);
    await api("platforms/N64-JP", "DELETE", undefined, 409);
    await api("contents/" + original.contents[0].id, "PUT", { ...ownership, platformId: "PC" });
    assert.equal((await api("platforms/N64-JP", "DELETE")).removedUnusedReleases, 1);
    const [remaining] = (await api(gamePath)).releases;
    assert.equal(remaining.platform.id, "PC");
    assert.equal(remaining.contents[0].item.id, original.contents[0].item.id);
    assert.equal(remaining.contents[0].edition.name, ownership.edition);

    // Simulate a platform created by the old UI, then edit it in the browser.
    const legacy = await db.platform.create({ data: { id: randomUUID(), name: "QA 旧 UUID 平台" } });
    const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage({ viewport: { width: 1365, height: 930 } });
    const errors = [], outside = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", r => {
      const url = new URL(r.request().url());
      if (url.origin === base) return r.continue();
      if (["https://cdn.steamgriddb.com", "https://cdn2.steamgriddb.com"].includes(url.origin)) return r.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900"><rect width="600" height="900" fill="#344c43"/><circle cx="300" cy="300" r="170" fill="#b5ce86"/><text x="300" y="655" text-anchor="middle" fill="white" font-family="sans-serif" font-size="58">QA COVER</text></svg>'
      });
      outside.push(url.origin); return r.abort();
    });
    await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url: base }]);
    await page.goto(base);
    await page.getByRole("button", { name: /平台管理/ }).click();
    await page.getByRole("button", { name: "编辑平台：QA 旧 UUID 平台", exact: true }).click();
    const editPlatform = page.getByRole("dialog", { name: "编辑平台" });
    await expect(editPlatform.getByLabel("平台代号", { exact: true })).toHaveValue(legacy.id);
    await editPlatform.getByLabel("平台名称", { exact: true }).fill("QA 自定义平台");
    await editPlatform.getByLabel("平台代号", { exact: true }).fill("QATEST");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: file("platform-mobile.png") });
    await editPlatform.getByRole("button", { name: "保存平台", exact: true }).click();
    await expect(editPlatform).toHaveCount(0);
    await expect(page.getByText("QATEST", { exact: true })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok((await api("catalog")).platforms.some(p => p.id === "QATEST" && p.name === "QA 自定义平台"));
    await page.getByRole("button", { name: "删除平台：QA 自定义平台", exact: true }).click();
    const removePlatform = page.getByRole("dialog", { name: "删除平台" });
    await expect(removePlatform).toContainText("QA 自定义平台");
    await removePlatform.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("QATEST", { exact: true })).toHaveCount(0);
    await page.getByLabel("新平台名称", { exact: true }).fill("QA 手输代号平台");
    await page.getByLabel("新平台代号（可选）", { exact: true }).fill("handheld");
    await page.getByRole("button", { name: "添加平台", exact: true }).click();
    await expect(page.getByText("HANDHELD", { exact: true })).toBeVisible();
    assert.ok((await api("catalog")).platforms.some(p => p.id === "HANDHELD"));

    await page.setViewportSize({ width: 1365, height: 930 });
    await page.getByRole("button", { name: /游戏库/ }).click();
    await page.getByRole("heading", { name: "QA 塞尔达传说：时之笛", exact: true }).click();
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
    await editor.getByText("查找外部资料或封面", { exact: true }).click();
    await editor.getByLabel("资料源").selectOption("steamgriddb");
    await editor.getByLabel("外部搜索标题").fill(zelda.title);
    await editor.getByRole("button", { name: "搜索外部资料" }).click();
    const candidates = editor.locator(".metadata-hits");
    await candidates.getByRole("button", { name: /ID 5532594/ }).click();
    const gallery = editor.getByRole("region", { name: "SteamGridDB 封面候选", exact: true });
    await expect(gallery.getByRole("link", { name: "在 SteamGridDB 查看该条目", exact: true })).toHaveAttribute("href", /5532594\/grids$/);
    await candidates.getByRole("button", { name: /ID 21202/ }).click();
    await expect(gallery.getByRole("img")).toHaveAttribute("src", zelda.thumb);
    const choose = gallery.getByRole("button", { name: "选择封面 1", exact: true });
    await expect(choose).toBeVisible();
    await choose.scrollIntoViewIfNeeded();
    await page.screenshot({ path: file("cover-desktop.png") });
    page.once("dialog", d => d.dismiss());
    await choose.click();
    const coverInput = editor.locator('input[name="coverUrl"]');
    await expect(coverInput).toHaveValue(legacyCover);
    page.once("dialog", d => d.accept());
    await choose.click();
    await expect(coverInput).toHaveValue(zelda.cover);
    await editor.getByRole("button", { name: "移除暂存：封面", exact: true }).click();
    await expect(coverInput).toHaveValue(legacyCover);
    await page.setViewportSize({ width: 390, height: 844 });
    await choose.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
      [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
    page.once("dialog", d => d.accept());
    await choose.click();
    await expect(coverInput).toHaveValue(zelda.cover);
    await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
    await expect(editor).toHaveCount(0);
    assert.equal((await api(gamePath)).coverUrl, zelda.cover);
    const cover = (await api(gamePath + "/fields")).fields.find(f => f.field === "coverUrl");
    assert.equal(cover.locked, true); assert.equal(cover.source.externalId, zelda.grid);
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);

    const backup = await api("backup");
    assert.equal(backup.schema_version, 3);
    await api("backup/preview", "POST", backup);
    await api(gamePath, "DELETE");
    await api("backup/restore", "POST", backup);
    assert.deepEqual(stable(await api("backup")), stable(backup));
    console.log("MODIFIED PASS HTTP=" + checks + " Zelda-21202-cover=selected-and-saved platform-code=editable cascade=preserved delete=unused-only permissions=pass backup=v3 UI=desktop,390px");
  }
  console.log("QA_ARTIFACTS=" + dir);
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill();
  await exited;
  await db.$disconnect();
  writeFileSync(file("server.log"), log.replaceAll(token, "[QA_TOKEN]"));
}

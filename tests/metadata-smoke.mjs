// Production Next.js + SQLite, official-shaped synthetic provider responses,
// real browser interactions, and isolated upgrade and restore databases.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { env as providerEnv, title, coverUrl } from "./metadata-fixtures.cjs";

const baseline = process.argv.includes("--baseline");
const dir = resolve(process.env.METADATA_QA_DIR ?? "engineering/metadata-smoke-" + Date.now());
mkdirSync(dir, { recursive: true });
const file = (...parts) => resolve(dir, ...parts);
const keys = Object.keys(providerEnv);
const sensitive = Object.entries(providerEnv).filter(([key]) => key !== "SCREENSCRAPER_SOFTNAME").map(([, value]) => value);
const hash = value => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(24).toString("hex");
const passwords = { admin: random(), other: random() };
const sessions = { admin: randomBytes(32).toString("hex"), other: randomBytes(32).toString("hex") };
const token = random(), oldId = "qa-shared", oldTitle = "QA 旧库星港", oldDescription = "旧库手动简介", otherId = "qa-other-only";
const fixtureFile = fileURLToPath(new URL("./metadata-fixtures.cjs", import.meta.url));
const fields = ["title", "originalTitle", "localizedTitle", "developer", "publisher", "genre", "description", "coverUrl"];
const own = { platformId: "PC", storeId: "STEAM", releaseDate: "2005" };
const log = [];
let checks = 0, browser;
const servers = [];
function makeEnv(name, enabled) {
  const dbFile = file(name + ".db"), tokenFile = file(name + ".setup-token");
  writeFileSync(dbFile, ""); writeFileSync(tokenFile, token);
  return { ...process.env, ...Object.fromEntries(keys.map(key => [key, enabled ? providerEnv[key] : ""])),
    DATABASE_URL: "file:" + dbFile.replaceAll("\\", "/"), SETUP_TOKEN: token, SETUP_TOKEN_FILE: tokenFile,
    APP_URL: "", SECURE_COOKIE: "false", NEXT_TELEMETRY_DISABLED: "1",
    GAMESHELF_QA_PROVIDER_LOG: file(name + "-upstream.log") };
}
function migrate(env, schema, output) {
  writeFileSync(file(output), execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], {
    env, encoding: "utf8", windowsHide: true
  }));
}
const schema = resolve("prisma/schema.prisma");
const legacy = file("legacy-prisma");
mkdirSync(resolve(legacy, "migrations"), { recursive: true });
cpSync(schema, resolve(legacy, "schema.prisma"));
for (const entry of ["20261006021417_initial", "20261006033000_release_identity", "20261102000000_game_relations", "migration_lock.toml"]) {
  cpSync(resolve("prisma/migrations", entry), resolve(legacy, "migrations", entry), { recursive: true });
}
const upgradeEnv = makeEnv("upgrade", !baseline);
migrate(upgradeEnv, resolve(legacy, "schema.prisma"), "legacy-migrate.log");
const db = new PrismaClient({ datasourceUrl: upgradeEnv.DATABASE_URL });
const canonical = value => {
  if (Array.isArray(value)) return [...value].sort((a, b) => a.id.localeCompare(b.id)).map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
};
const stable = data => canonical({ ...data, exportedAt: "" });
function assertRedacted(text) {
  for (const value of sensitive) assert.ok(!text.includes(value), "fixture credential appeared outside transport");
  assert.doesNotMatch(text, /QA-fixture-igdb-token|[?&](apikey|devpassword|sspassword)=/);
}
async function seed() {
  for (const id of ["admin", "other"]) {
    const salt = randomBytes(16).toString("hex");
    await db.user.create({ data: { id, username: "metadata-" + id, passwordHash: salt + ":" + scryptSync(passwords[id], salt, 64).toString("hex") } });
    await db.session.create({ data: { tokenHash: hash(sessions[id]), userId: id, expiresAt: new Date(Date.now() + 3600000) } });
  }
  await db.platform.create({ data: { id: "PC", name: "PC" } });
  await db.store.create({ data: { id: "STEAM", name: "Steam" } });
  const g = await db.game.create({ data: { id: oldId, title: oldTitle, description: oldDescription, genre: "旧库 RPG",
    developer: "旧库工作室", searchText: "qa 旧库星港 旧库工作室", releases: { create: { id: "release", platformId: "PC", releaseDate: "2005" } } } });
  await db.game.create({ data: { id: otherId, title: "QA 其他用户私有作品", searchText: "qa 其他用户私有作品",
    profiles: { create: { id: "private-other", userId: "other" } } } });
  const overridesJson = JSON.stringify(Object.fromEntries(["title", "developer", "genre", "description", "coverUrl"].map(field =>
    [field, { mode: "MANUAL_OVERRIDE", value: g[field] }])));
  const profile = await db.userGameProfile.create({ data: { id: "profile", userId: "admin", gameId: g.id, rating: 4,
    favorite: true, status: "CLEARED", memo: "旧库独立备注", overridesJson } });
  await db.userGameProfile.create({ data: { id: "other-profile", userId: "other", gameId: g.id } });
  const item = await db.libraryItem.create({ data: { id: "item", userId: "admin", storeId: "STEAM", mediaType: "DIGITAL",
    acquisitionType: "PURCHASE", accessStatus: "ACTIVE", sourceTotalSeconds: 900, contents: { create: { id: "content", releaseId: "release" } } } });
  const { searchText, ...game } = g, { userId, ...profileData } = profile, { userId: owner, ...owned } = item;
  const backup = { format: "gameshelf", schema_version: 2, exportedAt: new Date().toISOString(),
    platforms: await db.platform.findMany(), stores: await db.store.findMany(),
    games: [{ ...game, createdAt: game.createdAt.toISOString(), updatedAt: game.updatedAt.toISOString() }],
    releases: await db.release.findMany(), editions: [], items: [{ ...owned, createdAt: owned.createdAt.toISOString() }],
    contents: await db.libraryItemContent.findMany(), profiles: [profileData], relations: [], relationHistory: [] };
  const { relations, relationHistory, ...v1 } = backup;
  v1.schema_version = 1;
  await db.backupImport.createMany({ data: [backup, v1].map(x => ({ id: hash("admin" + JSON.stringify(stable(x))), userId: "admin" })) });
  return { v2: backup, v1 };
}
async function snapshot() {
  const result = {};
  for (const model of ["user", "session", "game", "release", "edition", "libraryItem", "libraryItemContent", "userGameProfile", "backupImport"]) {
    result[model] = await db[model].findMany({ orderBy: model === "session" ? { tokenHash: "asc" } : { id: "asc" } });
  }
  return JSON.stringify(result);
}
async function start(env, name) {
  const reservation = createServer(); await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--require", fixtureFile, resolve("node_modules/next/dist/bin/next"),
    "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", data => output += data);
  child.stderr.on("data", data => output += data);
  const exited = new Promise(r => child.once("exit", r));
  servers.push(async () => {
    if (child.exitCode === null) child.kill();
    await exited; assertRedacted(output);
    writeFileSync(file(name + "-server.log"), output.replaceAll(token, "[QA_TOKEN]"));
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) return base; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("QA server did not start: " + output);
}
async function call(base, path, { method = "GET", input, expected = 200, session = sessions.admin, trusted = true } = {}) {
  const r = await fetch(base + "/api/" + path, {
    method, headers: { cookie: session ? "gameshelf_session=" + session : "", "content-type": "application/json",
      ...(trusted ? { "x-gameshelf-request": "1" } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15000)
  });
  const body = await r.text(); assertRedacted(body);
  assert.equal(r.status, expected, method + " " + path + " " + body);
  checks++;
  return { data: JSON.parse(body), cookie: r.headers.get("Set-Cookie"), retryAfter: r.headers.get("Retry-After") };
}
const selected = (p, keys) => ({ token: p.token, fields: keys });
const inputOf = g => ({
  ...Object.fromEntries(fields.map(field => [field, g[field]])),
  ...Object.fromEntries(["status", "rating", "favorite", "memo"].map(field => [field, g.profiles[0][field]])),
  revision: g.metadataRevision
});
const change = (input, expected = 200, session = sessions.admin) => ({ method: "POST", input, expected, session });
const sourceOf = (report, field) => report.fields.find(f => f.field === field);

try {
  const legacyBackups = await seed(), original = await snapshot();
  if (!baseline) {
    migrate(upgradeEnv, schema, "upgrade.log");
    assert.equal(await snapshot(), original, "old tables, sessions, lock strings, ownership and restore markers unchanged");
    assert.equal(await db.userGameMetadata.count(), 3);
    assert.equal(await db.profileFieldHistory.count(), 0);
  }
  const base = await start(upgradeEnv, "upgrade");
  const get = async (path, options) => (await call(base, path, options)).data;
  const details = session => get("games/" + oldId, { session });
  const report = session => get("games/" + oldId + "/fields", { session });
  assert.equal((await get("auth/status")).user.username, "metadata-admin");
  assert.equal((await details()).description, oldDescription);
  assert.equal((await get("backup/restore", change(legacyBackups.v2))).duplicate, true);
  assert.equal((await get("backup/restore", change(legacyBackups.v1))).duplicate, true);
  if (baseline) {
    await get("metadata/providers", { expected: 404 });
    await get("games/" + oldId + "/fields", { expected: 404 });
    assert.equal((await get("backup")).schema_version, 2);
    console.log("BASELINE PASS HTTP=" + checks + "; providers=404; field-history=404; backup=v2; old-session-and-lock=preserved");
  } else {
    const providerList = await get("metadata/providers");
    assert.deepEqual(providerList.providers.map(p => [p.id, p.enabled]), [
      ["igdb", true], ["rawg", true], ["thegamesdb", true], ["screenscraper", true], ["steamgriddb", true]
    ]);
    assert.deepEqual((await report()).history, []);
    assert.deepEqual(sourceOf(await report(), "description"), { field: "description", value: oldDescription, locked: true, source: null });
    assert.equal((await get("backup/preview", change(legacyBackups.v2))).migratedFrom, 2);
    await get("metadata/providers", { session: "", expected: 401 });
    await get("metadata/search", { ...change({ provider: "rawg", query: title }, 403), trusted: false });
    await get("metadata/preview", change({ provider: "rawg", id: "https://example.invalid/" }, 400));
    await get("games/" + otherId + "/fields", { expected: 404 });
    await get("games/" + otherId + "/fields/unlock", change({ field: "title", revision: 0 }, 404));
    assert.equal(existsSync(upgradeEnv.GAMESHELF_QA_PROVIDER_LOG), false, "no provider request before explicit search");

    const previews = {};
    for (const provider of ["igdb", "rawg", "thegamesdb", "screenscraper", "steamgriddb"]) {
      const results = await get("metadata/search", change({ provider, query: title }));
      const hit = results.items[0];
      assert.equal(hit.title, title);
      const { items } = await get("metadata/preview", change({ provider, id: hit.id }));
      assert.equal(items[0].candidate.provider, provider);
      previews[provider] = items[0];
    }
    await get("games", change({ title: "跨用户令牌", ownership: own,
      candidates: [selected(previews.rawg, ["title"])] }, 409, sessions.other));
    const before = await details();
    const choices = [selected(previews.rawg, ["title", "genre", "description"]), selected(previews.steamgriddb, ["coverUrl"])];
    const save = (g, candidates, rest = {}, expected = 200, session = sessions.admin) =>
      get("games/" + oldId, { ...change({ ...inputOf(g), candidates, ...rest }, expected, session), method: "PUT" });
    const kept = await save(before, choices);
    assert.equal(kept.description, oldDescription);
    assert.equal(kept.title, oldTitle); assert.equal(kept.coverUrl, "");
    const newer = (await get("metadata/preview", change({ provider: "rawg", id: "202" }))).items[0];
    const refreshed = await save(kept, [selected(newer, ["description"])]);
    assert.equal(refreshed.description, oldDescription);
    assert.equal((await save(refreshed, [selected(newer, ["description"])])).metadataRevision, refreshed.metadataRevision);
    assert.equal(sourceOf(await report(), "description").source.value, "RAWG 的新版来源简介");
    await get("games/" + oldId + "/fields/unlock", change({ field: "description", revision: kept.metadataRevision }, 409));
    const unlock = async field => get("games/" + oldId + "/fields/unlock", change({ field, revision: (await report()).revision }));
    for (const field of ["description", "title", "genre", "coverUrl", "developer"]) await unlock(field);
    const after = await details();
    assert.equal(after.title, title); assert.equal(after.description, "RAWG 的新版来源简介");
    assert.equal(after.coverUrl, coverUrl); assert.equal(after.developer, "旧库工作室");
    assert.equal(after.profiles[0].rating, 4); assert.equal(after.profiles[0].memo, "旧库独立备注");
    assert.equal(after.releases[0].releaseDate, "2005");
    assert.equal(sourceOf(await report(), "developer").source, null);
    assert.equal((await get("games?genre=Adventure&year=2005")).total, 1);
    assert.equal((await get("games?genre=Adventure", { session: sessions.other })).total, 0);
    assert.equal((await get("games?q=" + encodeURIComponent(title), { session: sessions.other })).total, 0);
    assert.deepEqual((await report(sessions.other)).history, []);
    const second = await details(sessions.other);
    assert.equal(second.title, oldTitle); assert.equal(second.description, oldDescription);
    await save(second, [], { title: "QA 另一账户私有标题", genre: "第二账户类型" }, 200, sessions.other);
    assert.equal((await details()).title, title);
    assert.equal((await get("games?genre=" + encodeURIComponent("第二账户类型"))).total, 0);
    const relationTarget = await get("games", change({ title: "QA 关系原作", ownership: own }, 201));
    await get("games/" + relationTarget.id + "/relations", change({ targetGameId: oldId, type: "REMAKE_OF", note: "QA 来源隔离后仍使用个人标题" }, 201));
    assert.equal((await get("games/" + relationTarget.id + "/relations")).relations[0].target.title, title);

    const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [], outside = [], outgoing = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => {
      if (r.url().startsWith(base + "/api/metadata/")) outgoing.push(r.url());
      if (!r.url().startsWith(base) && !r.url().startsWith("https://cdn.steamgriddb.com/")) outside.push(r.url());
      assertRedacted(r.url());
    });
    await page.route("https://cdn.steamgriddb.com/**", r => r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900"><rect width="600" height="900" fill="#334745"/><circle cx="300" cy="260" r="170" fill="#8fba9b"/><text x="300" y="640" text-anchor="middle" fill="white" font-family="sans-serif" font-size="68">QA COVER</text></svg>'
    }));
    await page.context().addCookies([{ name: "gameshelf_session", value: sessions.admin, url: base }]);
    await page.goto(base);
    await page.getByRole("button", { name: "＋ 登记游戏", exact: true }).first().click();
    const editor = page.getByRole("dialog", { name: "登记游戏", exact: true });
    await editor.getByText("查找外部资料或封面", { exact: true }).click();
    await expect(editor.getByLabel("资料源")).toHaveValue("igdb");
    await editor.getByLabel("资料源").selectOption("rawg");
    await editor.getByLabel("外部搜索标题").fill(title);
    assert.ok(!outgoing.some(x => x.endsWith("/search")), "typing does not request provider search");
    await editor.getByRole("button", { name: "搜索外部资料" }).click();
    await editor.locator(".metadata-hits button").filter({ hasText: title }).first().click();
    await expect(editor.getByText("RAWG 的来源简介", { exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "暂存所选字段" }).click();
    await expect(editor.getByRole("textbox", { name: "游戏标题", exact: true })).toHaveValue(title);
    await editor.getByRole("textbox", { name: "游戏标题", exact: true }).fill("QA 浏览器登记");
    await editor.locator('textarea[name="description"]').fill("");
    await editor.getByLabel("资料源").selectOption("steamgriddb");
    await editor.getByRole("button", { name: "搜索外部资料" }).click();
    await editor.locator(".metadata-hits button").filter({ hasText: title }).first().click();
    await expect(editor.getByRole("button", { name: "选择封面 1" })).toBeVisible();
    await editor.getByRole("button", { name: "选择封面 1" }).click();
    await expect(editor.getByLabel("封面 URL（http/https）")).toHaveValue(coverUrl);
    await editor.locator(".metadata-covers").scrollIntoViewIfNeeded();
    await page.screenshot({ path: file("metadata-desktop.png") });
    await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".game-tile").filter({ hasText: "QA 浏览器登记" }).getByRole("link", { name: "RAWG", exact: true })).toHaveAttribute("href", "https://rawg.io/");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "QA 浏览器登记", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "游戏详情", exact: true });
    await detail.getByText("字段来源与历史", { exact: true }).click();
    const descriptionState = detail.locator(".field-state").filter({ has: page.getByText("简介", { exact: true }) });
    await expect(descriptionState).toContainText("当前：（空值）");
    await expect(descriptionState).toContainText("候选：RAWG 的来源简介");
    await descriptionState.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
      [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
    await page.screenshot({ path: file("metadata-mobile.png") });
    page.once("dialog", d => d.accept());
    await descriptionState.getByRole("button", { name: "恢复自动更新：简介" }).click();
    await expect(descriptionState).toContainText("当前：RAWG 的来源简介");
    await expect(detail.locator(".preserve").first()).toHaveText("RAWG 的来源简介");
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    await browser.close(); browser = undefined;

    const quota = await call(base, "metadata/search", change({ provider: "rawg", query: "quota" }, 429));
    assert.ok(Number(quota.retryAfter) > 0);
    await get("metadata/search", change({ provider: "rawg", query: "different" }, 429));
    const manual = await get("games", change({ title: "QA API 失败后仍可手填", ownership: own }, 201));
    assert.equal(manual.title, "QA API 失败后仍可手填");
    const v3 = await get("backup");
    assert.equal(v3.schema_version, 3);
    assert.ok(v3.fieldHistory.some(e => e.action === "UNLOCK" && e.field === "description"));
    assert.ok(v3.fieldHistory.some(e => e.field === "coverUrl" && e.source?.provider === "steamgriddb"));
    assert.doesNotMatch(JSON.stringify(v3), /另一账户私有标题|其他用户私有作品|passwordHash|tokenHash|userId/);
    for (const p of Object.values(previews)) assert.ok(!JSON.stringify(v3).includes(p.token));
    writeFileSync(file("demo-backup-v3.json"), JSON.stringify(v3, null, 2));

    const restoreEnv = makeEnv("restore", false);
    migrate(restoreEnv, schema, "restore-migrate.log");
    const dst = await start(restoreEnv, "restore");
    const setup = await call(dst, "auth/setup", change({ username: "restore-admin", password: passwords.admin, passwordConfirm: passwords.admin, setupToken: token }, 201, ""));
    const session = setup.cookie.match(/^gameshelf_session=([^;]+)/)[1];
    const dstCall = async (path, options) => (await call(dst, path, { ...options, session })).data;
    assert.ok((await dstCall("metadata/providers")).providers.every(p => !p.enabled));
    await dstCall("metadata/search", change({ provider: "igdb", query: title }, 409));
    for (const version of [1, 2]) {
      const source = legacyBackups["v" + version];
      const preview = await dstCall("backup/preview", change(source));
      assert.equal(preview.migratedFrom, version); assert.equal(preview.fieldHistory, 0);
      assert.equal((await dstCall("backup/restore", change(source))).games, 1);
      const p = await dstCall("games/" + oldId + "/fields");
      assert.deepEqual(p.history, []); assert.equal(sourceOf(p, "description").value, oldDescription);
      assert.equal(sourceOf(p, "description").source, null); assert.equal(sourceOf(p, "description").locked, true);
      assert.equal((await dstCall("backup/restore", change(source))).duplicate, true);
      await dstCall("games/" + oldId, { method: "DELETE" });
      // An identical historical import stays idempotent by design. Use a
      // distinct legacy backup identity to exercise the next version fresh.
      if (version === 1) legacyBackups.v2.profiles[0].memo = "独立 v2 恢复";
    }
    const bad = { ...v3, fieldHistory: [{ ...v3.fieldHistory[0], gameId: "not-mine" }, ...v3.fieldHistory.slice(1)] };
    await dstCall("backup/preview", change(bad, 400)); await dstCall("backup/restore", change(bad, 400));
    assert.equal((await dstCall("games")).total, 0);
    assert.equal((await dstCall("backup/preview", change(v3))).fieldHistory, v3.fieldHistory.length);
    await dstCall("backup/restore", change({ ...v3, fieldHistory: v3.fieldHistory.toReversed() }));
    assert.deepEqual(stable(await dstCall("backup")), stable(v3));
    assert.deepEqual(await dstCall("games/" + oldId + "/fields"), await report());
    assert.equal((await dstCall("backup/restore", change(v3))).duplicate, true);
    assert.ok(!existsSync(restoreEnv.GAMESHELF_QA_PROVIDER_LOG), "restore does not contact providers");
    for (const entry of readdirSync(resolve(".next/static"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const text = readFileSync(resolve(entry.parentPath, entry.name), "utf8");
      assertRedacted(text); assert.ok(keys.every(key => !text.includes(key)), "runtime env variables are absent from browser JS");
    }
    const used = readFileSync(upgradeEnv.GAMESHELF_QA_PROVIDER_LOG, "utf8");
    for (const host of ["api.igdb.com", "api.rawg.io", "api.thegamesdb.net", "api.screenscraper.fr", "www.steamgriddb.com"]) assert.ok(used.includes(host));
    assert.equal(hash(readFileSync(upgradeEnv.SETUP_TOKEN_FILE)), hash(token));
    console.log("MODIFIED PASS HTTP=" + checks + "; providers=5-fixtures; cover=portrait; locks=preserved,cleared,unlocked; isolation=pass; backup=v1,v2,v3; UI=desktop,390px; credential-leaks=0");
  }
  console.log("QA_ARTIFACTS=" + dir);
} finally {
  await browser?.close();
  await Promise.all(servers.map(close => close()));
  await db.$disconnect();
}

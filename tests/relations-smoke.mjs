// Self-contained legacy SQLite upgrade + HTTP + browser + backup rehearsal.
// Never uses a personal instance, database, setup token or external service.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHash, scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const baseline = process.argv.includes("--baseline");
const root = process.cwd(), dir = resolve("engineering", `relations-${baseline ? "baseline" : "modified"}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const hash = value => createHash("sha256").update(value).digest("hex");
const token = randomBytes(24).toString("hex"), password = randomBytes(18).toString("hex"), session = randomBytes(32).toString("hex");
const tokenFile = resolve(dir, "setup-token"); writeFileSync(tokenFile, token); writeFileSync(resolve(dir, "qa.db"), "");
const env = { ...process.env, DATABASE_URL: `file:${resolve(dir, "qa.db").replaceAll("\\", "/")}`, SETUP_TOKEN_FILE: tokenFile, SETUP_TOKEN: token, APP_URL: "", SECURE_COOKIE: "false" };
// Apply the two pre-relationship migrations, seed real old-model records, then upgrade.
const legacySchema = resolve(dir, "legacy-prisma"); mkdirSync(resolve(legacySchema, "migrations"), { recursive: true });
cpSync("prisma/schema.prisma", resolve(legacySchema, "schema.prisma"));
for (const name of ["20261006021417_initial", "20261006033000_release_identity", "migration_lock.toml"]) {
  cpSync(resolve("prisma/migrations", name), resolve(legacySchema, "migrations", name), { recursive: true });
}
function migrate(schema) {
  const output = execFileSync(process.execPath, [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], { env, encoding: "utf8" });
  writeFileSync(resolve(dir, schema === resolve("prisma/schema.prisma") ? "upgrade.log" : "legacy-migrate.log"), output);
}
migrate(resolve(legacySchema, "schema.prisma"));
const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const salt = randomBytes(16).toString("hex"), passwordHash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
await db.user.create({ data: { id: "admin", username: "relations-qa", passwordHash } });
await db.session.create({ data: { tokenHash: hash(session), userId: "admin", expiresAt: new Date(Date.now() + 3600000) } });
await db.platform.createMany({ data: [{ id: "PC", name: "PC" }, { id: "PS4", name: "PlayStation 4" }] });
await db.store.create({ data: { id: "STEAM", name: "Steam" } });
await db.game.create({ data: { id: "legacy-original", title: "QA 星海原作", searchText: "qa 星海原作", genre: "RPG", profiles: { create: {
  id: "legacy-profile", userId: "admin", status: "CLEARED", rating: 5, favorite: true, memo: "旧库备注保持不变"
} }, releases: { create: { id: "legacy-release", platformId: "PC", releaseDate: "2005" } } } });
await db.libraryItem.create({ data: { id: "legacy-item", userId: "admin", storeId: "STEAM", mediaType: "DIGITAL", acquisitionType: "PURCHASE", accessStatus: "ACTIVE", sourceTotalSeconds: 14400,
  contents: { create: { id: "legacy-content", releaseId: "legacy-release" } } } });
const canonical = value => {
  if (Array.isArray(value)) return [...value].sort((a, b) => a.id.localeCompare(b.id)).map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
};
const stable = backup => canonical({ ...backup, exportedAt: "" });
const legacyBackup = {
  format: "gameshelf", schema_version: 1, exportedAt: new Date().toISOString(),
  platforms: await db.platform.findMany(), stores: await db.store.findMany(),
  games: (await db.game.findMany()).map(({ searchText, ...game }) => ({ ...game, createdAt: game.createdAt.toISOString(), updatedAt: game.updatedAt.toISOString() })),
  releases: await db.release.findMany(), editions: [],
  items: (await db.libraryItem.findMany()).map(({ userId, ...item }) => ({ ...item, createdAt: item.createdAt.toISOString() })),
  contents: await db.libraryItemContent.findMany(), profiles: (await db.userGameProfile.findMany()).map(({ userId, ...profile }) => profile)
};
await db.backupImport.create({ data: { id: hash("admin" + JSON.stringify(stable(legacyBackup))), userId: "admin" } });
async function snapshot() {
  const result = {};
  for (const model of ["user", "session", "platform", "store", "game", "release", "edition", "libraryItem", "libraryItemContent", "userGameProfile", "backupImport"]) result[model] = await db[model].findMany();
  return JSON.stringify(result);
}
const before = await snapshot(); await db.$disconnect();
if (!baseline) {
  migrate(resolve("prisma/schema.prisma"));
  assert.equal(await snapshot(), before, "additive migration preserves every legacy entity, credential and session");
  assert.equal(await db.gameRelation.count(), 0); assert.equal(await db.gameRelationEvent.count(), 0);
}
const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port; await new Promise(r => server.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let log = "", browser, checks = 0, cookie = `gameshelf_session=${session}`;
child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
const exited = new Promise(r => child.once("exit", r));
async function call(path, method = "GET", data, status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method, signal: AbortSignal.timeout(10000), headers: { cookie, "content-type": "application/json", "x-gameshelf-request": "1" }, body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`); checks++;
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return body;
}
const owned = { platformId: "PC", storeId: "STEAM", mediaType: "DIGITAL", acquisitionType: "PURCHASE", accessStatus: "ACTIVE", releaseDate: "2023" };
const add = (title, other = {}) => call("games", "POST", { title, rating: 3, memo: "重制作品的独立备注", ownership: owned, ...other }, 201);
const link = (source, target, type = "REMAKE_OF", note = "人工确认独立重制作品") => call(`games/${source}/relations`, "POST", { targetGameId: target, type, note }, 201);
const original = "legacy-original";
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, "isolated QA server healthy");
  assert.equal((await call("auth/status")).user.username, "relations-qa", "pre-upgrade session still works");
  assert.equal((await call(`games/${original}`)).profiles[0].memo, "旧库备注保持不变");
  const remake = await add("QA 星海重制"), remaster = await add("QA 星海复刻");
  if (baseline) {
    await call(`games/${original}/relations`, "GET", undefined, 404);
    await call(`games/${remake.id}/relations`, "POST", { targetGameId: original, type: "REMAKE_OF", note: "依据" }, 404);
    assert.equal((await call("backup")).schema_version, 1);
    assert.equal((await call("games")).total, 3);
    console.log(`BASELINE PASS HTTP=${checks}; relations=404; backup=v1; legacy-session=preserved; works=3`);
  } else {
    assert.equal((await call("backup/restore", "POST", legacyBackup)).duplicate, true, "v1 import hash remains idempotent across upgrade");
    const v1preview = await call("backup/preview", "POST", legacyBackup);
    assert.equal(v1preview.migratedFrom, 1); assert.equal(v1preview.relations, 0);
    const a = await link(remake.id, original), b = await link(remaster.id, original, "REMASTER_OF", "原作高清复刻");
    assert.equal((await call(`games/${original}/relations`)).relations.length, 2);
    assert.equal((await call(`games/${remake.id}/relations`)).relations[0].target.id, original);
    const dataBeforeInvalid = await call("backup");
    for (const input of [
      { targetGameId: remake.id, type: "REMAKE_OF", note: "自身" },
      { targetGameId: original, type: "REMAKE_OF", note: "重复" },
      { targetGameId: original, type: "EDITION", note: "不支持" },
      { targetGameId: original, type: "REMAKE_OF", note: " " },
      { targetGameId: original, type: "REMAKE_OF", note: "依据", userId: "other" }
    ]) await call(`games/${remake.id}/relations`, "POST", input, 400);
    await call(`games/${original}/relations`, "POST", { targetGameId: remake.id, type: "REMASTER_OF", note: "反向" }, 400);
    await link(remaster.id, remake.id, "REMASTER_OF", "系列内多层关联");
    await call(`games/${original}/relations`, "POST", { targetGameId: remaster.id, type: "REMAKE_OF", note: "循环" }, 400);
    await call(`games/${remake.id}/relations`, "POST", { targetGameId: "not-found", type: "REMAKE_OF", note: "缺失" }, 404);
    await call(`relations/${a.id}`, "PUT", { type: "REMASTER_OF", note: "人工修正：实际为复刻" });
    await call(`relations/${a.id}`, "PUT", { type: "REMASTER_OF", note: "人工修正：实际为复刻" });
    assert.equal((await call(`games/${remake.id}/relations`)).history.filter(e => e.relationId === a.id).length, 2, "no-op edit adds no history");
    await call(`relations/${a.id}`, "DELETE");
    const removed = (await call(`games/${remake.id}/relations`)).history.filter(e => e.relationId === a.id);
    assert.deepEqual(removed.map(e => e.action), ["DELETE", "UPDATE", "CREATE"]);
    assert.equal(removed.find(e => e.action === "CREATE").note, "人工确认独立重制作品");
    assert.equal((await call("games")).total, 3, "unlink never merges or removes works");
    for (const key of ["games", "releases", "editions", "items", "contents", "profiles"]) {
      assert.deepEqual(stable(await call("backup"))[key], stable(dataBeforeInvalid)[key], `relation edits do not alter ${key}`);
    }
    // Exercise actual UI, including pagination over candidates, direction, edit and removal.
    for (let i = 0; i < 25; i++) await add(`QA 候选 ${String(i).padStart(2, "0")}`);
    const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    const external = [], errors = [];
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(base); await page.locator('[name="username"]').fill("relations-qa"); await page.locator('[name="password"]').fill(password);
    await page.getByRole("button", { name: "登录游戏库", exact: true }).click();
    await expect(page.locator(".count")).toHaveText("28");
    await page.getByRole("textbox", { name: "搜索游戏", exact: true }).fill("QA 星海重制");
    await page.getByRole("heading", { name: "QA 星海重制", exact: true }).click();
    const panel = page.getByRole("region", { name: "作品关系", exact: true });
    await panel.getByRole("button", { name: "关联原作", exact: true }).click();
    await expect(panel.getByRole("button", { name: "候选下一页", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "候选下一页", exact: true }).click();
    await expect(panel.locator(".relation-pagination")).toContainText("第 2 / 2 页");
    await panel.getByRole("textbox", { name: "搜索库内原作", exact: true }).fill("QA 星海原作");
    await expect(panel.locator(".relation-pagination")).toContainText("第 1 / 1 页");
    await panel.getByRole("group", { name: "选择原作", exact: true }).getByRole("button", { name: /QA 星海原作/ }).click();
    await panel.getByRole("textbox", { name: "判定依据", exact: true }).fill("桌面确认重制，保留原作评分");
    await panel.getByRole("button", { name: "保存关系", exact: true }).click();
    await expect(panel.locator(".relation-row").filter({ hasText: "桌面确认重制" })).toBeVisible();
    await page.screenshot({ path: resolve(dir, "relations-desktop.png"), fullPage: true });
    await panel.getByRole("button", { name: "QA 星海原作", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "游戏详情", exact: true }).getByRole("heading", { name: "QA 星海原作", exact: true })).toBeVisible();
    await expect(panel.locator(".relation-row").filter({ hasText: "QA 星海重制" })).toContainText("重制作品");
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.locator(".relation-row").filter({ hasText: "QA 星海重制" }).getByRole("button", { name: "编辑关系", exact: true }).click();
    await panel.getByRole("button", { name: "复刻自", exact: true }).click();
    await panel.getByRole("textbox", { name: "判定依据", exact: true }).fill("手机核对后修正为复刻");
    await panel.getByRole("button", { name: "保存关系", exact: true }).click();
    await expect(panel.locator(".relation-row").filter({ hasText: "QA 星海重制" })).toContainText("复刻作品");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)), "390px page and detail have no horizontal overflow");
    await page.screenshot({ path: resolve(dir, "relations-mobile.png"), fullPage: true });
    page.once("dialog", dialog => dialog.accept());
    await panel.locator(".relation-row").filter({ hasText: "QA 星海重制" }).getByRole("button", { name: "解除关系", exact: true }).click();
    await expect(panel.locator(".relation-row").filter({ hasText: "QA 星海重制" })).toHaveCount(0);
    await panel.locator("summary").click(); await expect(panel.locator(".relation-history")).toContainText("手机核对后修正为复刻");
    await expect(panel.locator(".relation-history")).toContainText("桌面确认重制，保留原作评分");
    await page.getByRole("dialog", { name: "游戏详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "备份与恢复" }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "legacy-v1.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacyBackup)) });
    await expect(page.locator(".restore-preview")).toContainText("v1 备份将迁移为 v3");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await browser.close(); browser = undefined;

    // Two users share Game metadata but never share manual relation judgments or history.
    const ownCookie = cookie;
    await db.user.create({ data: { id: "other", username: "relations-other", passwordHash } });
    await db.userGameProfile.createMany({ data: [original, remaster.id].map(gameId => ({ id: `other-${gameId}`, userId: "other", gameId })) });
    await call("auth/login", "POST", { username: "relations-other", password });
    assert.deepEqual(await call(`games/${original}/relations`), { relations: [], history: [] });
    await call(`relations/${b.id}`, "PUT", { type: "REMAKE_OF", note: "越权" }, 404);
    await call(`relations/${b.id}`, "DELETE", undefined, 404);
    await call(`games/${remake.id}/relations`, "GET", undefined, 404);
    const hidden = await add("Private original");
    const otherLink = await link(remaster.id, original, "REMAKE_OF", "另一个用户独立判断");
    cookie = ownCookie;
    assert.ok(!(await call(`games/${original}/relations`)).relations.some(r => r.id === otherLink.id));
    await call(`games/${remake.id}/relations`, "POST", { targetGameId: hidden.id, type: "REMAKE_OF", note: "跨账号" }, 404);
    assert.ok(!(await call("backup")).relationHistory.some(e => e.note === "另一个用户独立判断"));
    cookie = ""; await call(`games/${original}/relations`, "GET", undefined, 401);
    await call(`games/${remake.id}/relations`, "POST", { targetGameId: original, type: "REMAKE_OF", note: "未登录" }, 401);
    cookie = ownCookie;

    // Deleting a shared work removes only this user's judgments and retains the other user's work.
    await call(`games/${remaster.id}`, "DELETE");
    assert.equal(await db.gameRelation.count({ where: { userId: "admin", OR: [{ sourceGameId: remaster.id }, { targetGameId: remaster.id }] } }), 0);
    assert.equal(await db.gameRelationEvent.count({ where: { userId: "admin", OR: [{ sourceGameId: remaster.id }, { targetGameId: remaster.id }] } }), 0);
    assert.ok(await db.gameRelation.findUnique({ where: { id: otherLink.id } }));
    // Clean the second account's fixture, leaving a nonempty active + deleted history backup.
    await call("auth/login", "POST", { username: "relations-other", password });
    for (const game of (await call("backup")).games) await call(`games/${game.id}`, "DELETE");
    cookie = ownCookie;
    await link(remake.id, original);
    const backup = await call("backup"); assert.equal(backup.schema_version, 3); assert.ok(backup.relationHistory.length > backup.relations.length);
    assert.ok(!/passwordHash|tokenHash|userId/.test(JSON.stringify(backup)));
    writeFileSync(resolve(dir, "demo-backup-v3.json"), JSON.stringify(backup, null, 2));
    const preview = await call("backup/preview", "POST", backup);
    assert.equal(preview.relations, backup.relations.length); assert.equal(preview.relationHistory, backup.relationHistory.length);
    for (const game of backup.games) await call(`games/${game.id}`, "DELETE");
    assert.equal((await call("games")).total, 0);
    for (const bad of [
      { ...backup, schema_version: 99 },
      { ...backup, relations: [{ ...backup.relations[0], targetGameId: "dangling" }] },
      { ...backup, relations: [...backup.relations, { ...backup.relations[0], id: "duplicate" }] },
      { ...backup, relationHistory: [] }
    ]) {
      await call("backup/preview", "POST", bad, 400); await call("backup/restore", "POST", bad, 400);
      assert.equal((await call("games")).total, 0); assert.equal(await db.gameRelationEvent.count({ where: { userId: "admin" } }), 0);
    }
    await call("backup/restore", "POST", backup);
    assert.deepEqual(stable(await call("backup")), stable(backup), "v3 restore retains exact graph, audit history and independent personal data");
    assert.equal((await call("backup/restore", "POST", { ...backup, relations: [...backup.relations].reverse(), relationHistory: [...backup.relationHistory].reverse() })).duplicate, true);
    // Fresh v1 restoration (not the old idempotency marker) also upgrades cleanly.
    for (const game of backup.games) await call(`games/${game.id}`, "DELETE");
    const v1 = { ...legacyBackup, profiles: legacyBackup.profiles.map(p => ({ ...p, memo: "v1 空库恢复" })) };
    assert.equal((await call("backup/restore", "POST", v1)).games, 1);
    const v3 = await call("backup"); assert.equal(v3.schema_version, 3); assert.deepEqual(v3.relations, []); assert.deepEqual(v3.relationHistory, []);
    const { relations, relationHistory, fieldHistory, ...rest } = v3; assert.deepEqual(fieldHistory, []); assert.deepEqual(stable({ ...rest, schema_version: 1 }), stable(v1));
    assert.equal(hash(readFileSync(tokenFile)), hash(token));
    console.log(`MODIFIED PASS HTTP=${checks}; upgrade=legacy-data,session,token-preserved; relations=CRUD,direction,history,cycle-validation; backup=v1-migration,v3-roundtrip,atomic-rejection,idempotency; isolation=pass; UI=desktop,390px,candidate-pagination; external-requests=0; personal-db=untouched`);
  }
  console.log(`QA_ARTIFACTS=${dir}`);
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill(); await exited;
  await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {}); await db.$disconnect();
  writeFileSync(resolve(dir, "server.log"), log.replaceAll(token, "[QA_TOKEN]"));
}

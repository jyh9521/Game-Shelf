// Container-level 0.1.5 -> 0.1.6 upgrade, independent snapshot rollback and restore proof.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";

const dir = resolve(process.env.RELEASE_QA_DIR ?? "engineering/release-0.1.6");
mkdirSync(dir, { recursive: true });
const id = `gs-release-016-${Date.now()}`, label = "release-0.1.6";
const old = "jyh9521/gameshelf@sha256:1a2751416859b90d4b5c79051993fa05dae9b873c8e6159a96276ba886f195a4";
const image = process.env.TEST_IMAGE ?? "jyh9521/gameshelf:0.1.6";
const names = Object.fromEntries(["baseline", "modified", "rollback", "restore"].map(k => [k, `${id}-${k}`]));
const volumes = Object.fromEntries(["baseline", "modified", "rollback", "restore", "fresh", "symlink"].map(k => [k, `${id}-${k}`]));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trim();
const records = [], log = s => { records.push(s); console.log(s); };
const password = randomBytes(24).toString("hex");
let base = "", cookie = "", browser, checks = 0;
const helper = (volume, code) => docker("run", "--rm", "--label", `gameshelf.qa=${label}`, "--entrypoint", "node", "-v", `${volume}:/data`, old, "-e", code);
const clone = (from, to) => docker("run", "--rm", "--label", `gameshelf.qa=${label}`, "--entrypoint", "sh", "-v", `${from}:/from:ro`, "-v", `${to}:/to`, old, "-c", "cp -a /from/. /to/");
function fileStats(volume) {
  return JSON.parse(helper(volume, "const f=require('fs'),c=require('crypto'),out={};for(const n of ['setup-token','gameshelf.db','unrelated.txt','nested/unrelated.txt']){const p='/data/'+n,s=f.statSync(p);out[n]={uid:s.uid,gid:s.gid,mode:s.mode&511,sha256:c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}}console.log(JSON.stringify(out))"));
}
const rollbackScript = resolve(dir, "ROLLBACK.sh");
writeFileSync(rollbackScript, `#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1
NAME="\${1:?isolated QA container name}"
VOLUME="\${2:?isolated pre-upgrade snapshot volume}"
case "$NAME:$VOLUME" in gs-release-016-*:gs-release-016-*) ;; *) echo "Expected isolated release QA names" >&2; exit 2;; esac
[[ "$(docker volume inspect --format '{{index .Labels "gameshelf.qa"}}' "$VOLUME")" == "release-0.1.6" ]]
docker run -d --name "$NAME" --label gameshelf.qa=release-0.1.6 -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ${old} >/dev/null
echo "ROLLBACK_STARTED image=0.1.5 snapshot=isolated"
`);
chmodSync(rollbackScript, 0o755);
async function start(which, tag) {
  if (which === "rollback") {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const output = execFileSync(bash, [rollbackScript, names[which], volumes[which]], { encoding: "utf8", windowsHide: true });
    assert.equal(output.trim(), "ROLLBACK_STARTED image=0.1.5 snapshot=isolated");
  } else docker("run", "-d", "--name", names[which], "--label", `gameshelf.qa=${label}`, "-p", "127.0.0.1::3000", "-e", "PUID=99", "-e", "PGID=100", "-v", `${volumes[which]}:/data`, tag);
  base = `http://127.0.0.1:${docker("port", names[which], "3000/tcp").split(":").at(-1)}`;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (docker("inspect", "--format", "{{.State.Running}}", names[which]) !== "true") break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(ready, `${which} startup: ${docker("logs", names[which])}`);
  assert.equal(docker("exec", names[which], "node", "-e", "console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/Uid:\\s+(\\d+)/)[1])"), "99");
}
async function healthy(name) {
  for (let i = 0; i < 90; i++) {
    if (docker("inspect", "--format", "{{.State.Health.Status}}", name) === "healthy") return "healthy";
    await new Promise(r => setTimeout(r, 500));
  }
  throw Error("Docker HEALTHCHECK timeout");
}
async function call(path, method = "GET", data, status = 200) {
  const r = await fetch(`${base}/api/${path}`, { method, signal: AbortSignal.timeout(10000), headers: { cookie, "content-type": "application/json", "x-gameshelf-request": "1" }, body: data === undefined ? undefined : JSON.stringify(data) });
  const b = await r.json(); assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(b)}`); checks++;
  if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
  return b;
}
function stable(b) {
  const result = structuredClone(b); delete result.exportedAt;
  for (const v of Object.values(result)) if (Array.isArray(v)) v.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
const backup = async () => stable(await call("backup"));
const portable = b => ({ ...b, exportedAt: new Date().toISOString() });
const link = (source, target, type = "REMAKE_OF", note = "Container release QA") => call(`games/${source}/relations`, "POST", { targetGameId: target, type, note }, 201);

try {
  for (const volume of Object.values(volumes)) docker("volume", "create", "--label", `gameshelf.qa=${label}`, volume);
  await start("baseline", old);
  const token = docker("exec", names.baseline, "cat", "/data/setup-token");
  await call("auth/setup", "POST", { username: "release-qa", password, passwordConfirm: password, setupToken: token }, 201);
  const add = (title, year, rating) => call("games", "POST", { title, genre: "RPG", rating, memo: "独立记录", ownership: { platformId: "PC", storeId: "STEAM", mediaType: "DIGITAL", acquisitionType: "PURCHASE", accessStatus: "ACTIVE", releaseDate: year } }, 201);
  const original = await add("Release original", "2005", 5);
  const remake = await add("Release remake", "2023", 3);
  const remaster = await add("Release remaster", "2010", 4);
  await call(`games/${original.id}/relations`, "GET", undefined, 404);
  await call(`games/${remake.id}/relations`, "POST", { targetGameId: original.id, type: "REMAKE_OF", note: "not supported" }, 404);
  assert.equal((await call("games?genre=RPG&year=2005")).total, 1);
  const beforeBackup = await backup(); assert.equal(beforeBackup.schema_version, 1);
  writeFileSync(resolve(dir, "baseline-backup.json"), JSON.stringify(portable(beforeBackup), null, 2));
  log("BASELINE PASS image=0.1.5 relations=404 backup=v1 games=3 session=preserved exit=0");
  docker("stop", names.baseline);
  helper(volumes.baseline, "const f=require('fs');f.chownSync('/data/setup-token',0,0);f.chmodSync('/data/setup-token',384);f.chownSync('/data/gameshelf.db',1000,1000);f.chmodSync('/data/gameshelf.db',384);f.writeFileSync('/data/unrelated.txt','keep',{mode:384});f.mkdirSync('/data/nested');f.writeFileSync('/data/nested/unrelated.txt','nested keep',{mode:384})");
  const before = fileStats(volumes.baseline);
  clone(volumes.baseline, volumes.modified); clone(volumes.baseline, volumes.rollback);
  assert.deepEqual(fileStats(volumes.modified), before); assert.deepEqual(fileStats(volumes.rollback), before);
  await start("modified", image);
  assert.equal((await call("auth/status")).user.username, "release-qa");
  const upgraded = await backup();
  assert.equal(upgraded.schema_version, 2); assert.deepEqual(upgraded.relations, []); assert.deepEqual(upgraded.relationHistory, []);
  const { relations, relationHistory, schema_version, ...legacyFields } = upgraded;
  const { schema_version: oldSchema, ...originalFields } = beforeBackup;
  assert.deepEqual(legacyFields, originalFields);
  const after = fileStats(volumes.modified);
  for (const name of ["setup-token", "gameshelf.db"]) { assert.equal(after[name].uid, 99); assert.equal(after[name].gid, 100); assert.equal(after[name].mode, 384); }
  assert.equal(after["setup-token"].sha256, before["setup-token"].sha256);
  for (const name of ["unrelated.txt", "nested/unrelated.txt"]) assert.deepEqual(after[name], before[name]);
  assert.equal(docker("exec", names.modified, "node", "-p", "require('./package.json').version"), "0.1.6");
  assert.equal((await call("games?genre=RPG&year=2005&rating=5")).total, 1);
  log("UPGRADE PASS data=identical session=preserved token=unchanged owner=99:100 mode=600 unrelated=unchanged exit=0");
  const a = await link(remake.id, original.id);
  await link(remaster.id, original.id, "REMASTER_OF");
  for (const [source, target] of [[original.id, remake.id], [remake.id, remake.id], [remake.id, original.id]]) await call(`games/${source}/relations`, "POST", { targetGameId: target, type: "REMAKE_OF", note: "invalid" }, 400);
  await call(`relations/${a.id}`, "PUT", { type: "REMASTER_OF", note: "Corrected release QA" });
  await call(`relations/${a.id}`, "PUT", { type: "REMASTER_OF", note: "Corrected release QA" });
  assert.equal((await call(`games/${remake.id}/relations`)).history.length, 2);
  await call(`relations/${a.id}`, "DELETE");
  assert.deepEqual((await call(`games/${remake.id}/relations`)).history.map(e => e.action), ["DELETE", "UPDATE", "CREATE"]);
  await link(remake.id, original.id);
  assert.equal((await call(`games/${original.id}/relations`)).relations.length, 2);
  const modified = await backup(); assert.equal(modified.relations.length, 2); assert.equal(modified.relationHistory.length, 5);
  for (const key of Object.keys(originalFields)) assert.deepEqual(modified[key], originalFields[key]);
  writeFileSync(resolve(dir, "modified-backup-v2.json"), JSON.stringify(portable(modified), null, 2));
  const session = cookie; cookie = "";
  await call(`games/${original.id}/relations`, "GET", undefined, 401); cookie = session;
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } }), errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin === base) return route.continue(); external.push(route.request().url()); return route.abort(); });
  await page.goto(base); await page.locator('[name="username"]').fill("release-qa"); await page.locator('[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录游戏库", exact: true }).click();
  await expect(page.getByText("LOCAL-FIRST / v0.1.6", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "Release remake", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品关系", exact: true });
  await expect(panel.locator(".relation-row")).toContainText("重制自");
  await page.screenshot({ path: resolve(dir, "desktop.png"), fullPage: true });
  await panel.getByRole("button", { name: "Release original", exact: true }).click();
  await expect(panel.locator(".relation-row").filter({ hasText: "Release remake" })).toContainText("重制作品");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.locator(".relation-row")).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
  await page.screenshot({ path: resolve(dir, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await browser.close(); browser = undefined;
  log(`MODIFIED PASS image=0.1.6 relations=CRUD,history backup=v2 games=3 UI=desktop,390px health=${await healthy(names.modified)} exit=0`);
  docker("stop", names.modified); docker("rm", names.modified); await start("modified", image);
  assert.deepEqual(await backup(), modified);
  log("PERSISTENCE PASS recreated=0.1.6 relations=2 history=5 data=identical session=preserved exit=0");
  await start("rollback", old); assert.deepEqual(await backup(), beforeBackup);
  await call(`games/${original.id}/relations`, "GET", undefined, 404);
  await call("backup/preview", "POST", portable(modified), 400);
  assert.equal((await call("games?genre=RPG&year=2005")).total, 1);
  log("ROLLBACK PASS image=0.1.5 snapshot=isolated relations=404 backup=v1 games=3 session=preserved exit=0");
  // Round-trip actual old and new exports in a separate new-version instance.
  cookie = ""; await start("restore", image);
  const restoreToken = docker("exec", names.restore, "cat", "/data/setup-token");
  await call("auth/setup", "POST", { username: "restore-qa", password, passwordConfirm: password, setupToken: restoreToken }, 201);
  assert.equal((await call("backup/preview", "POST", portable(beforeBackup))).migratedFrom, 1);
  await call("backup/restore", "POST", portable(beforeBackup)); assert.deepEqual(await backup(), upgraded);
  for (const game of beforeBackup.games) await call(`games/${game.id}`, "DELETE");
  const bad = { ...modified, relationHistory: [] };
  await call("backup/restore", "POST", portable(bad), 400); assert.equal((await call("games")).total, 0);
  await call("backup/restore", "POST", portable(modified)); assert.deepEqual(await backup(), modified);
  assert.equal((await call("backup/restore", "POST", portable(modified))).duplicate, true);
  log("RESTORE PASS v1=migrated v2=exact relations=2 history=5 invalid=atomic idempotency=pass exit=0");
  const fresh = docker("run", "--rm", "--label", `gameshelf.qa=${label}`, "-e", "PUID=1000", "-e", "PGID=1000", "-v", `${volumes.fresh}:/data`, image, "node", "-e", "console.log('FRESH_STARTUP_OK uid='+process.getuid())");
  assert.match(fresh, /FRESH_STARTUP_OK uid=1000/); log("FRESH PASS FRESH_STARTUP_OK uid=1000 exit=0");
  helper(volumes.symlink, "const f=require('fs');f.writeFileSync('/data/unrelated.txt','unchanged',{mode:384});f.symlinkSync('/data/unrelated.txt','/data/setup-token')");
  const targetStats = "const f=require('fs'),s=f.statSync('/data/unrelated.txt');console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode,content:f.readFileSync('/data/unrelated.txt','utf8')}))";
  const linkBefore = helper(volumes.symlink, targetStats);
  const failure = spawnSync("docker", ["run", "--rm", "--label", `gameshelf.qa=${label}`, "-e", "PUID=99", "-e", "PGID=100", "-v", `${volumes.symlink}:/data`, image, "node", "-e", "console.log('UNEXPECTED_START')"], { encoding: "utf8", windowsHide: true });
  assert.equal(failure.status, 1); assert.match(failure.stderr, /must not be a symbolic link/);
  assert.equal(helper(volumes.symlink, targetStats), linkBefore);
  log("SYMLINK PASS rejected=expected container-exit=1 target=unchanged");
  assert.deepEqual(fileStats(volumes.baseline), before, "pre-upgrade baseline stays byte-identical");
  writeFileSync(resolve(dir, "fixture-hashes.json"), JSON.stringify({ before, after, volumes }, null, 2));
  log(`RELEASE PASS HTTP=${checks} personal-data=untouched baseline=pass modified=pass rollback=pass`);
  writeFileSync(resolve(dir, "container-qa.json"), JSON.stringify({ image, old, names, volumes, checks, imageId: docker("image", "inspect", image, "--format", "{{.Id}}"), records }, null, 2));
} finally {
  await browser?.close();
  for (const name of Object.values(names)) {
    try { writeFileSync(resolve(dir, `${name}.log`), docker("logs", name)); docker("stop", name); docker("rm", name); } catch {}
  }
  for (const volume of Object.values(volumes)) { try { docker("volume", "rm", volume); } catch {} }
  writeFileSync(resolve(dir, "container-qa.txt"), records.join("\n") + "\n");
}

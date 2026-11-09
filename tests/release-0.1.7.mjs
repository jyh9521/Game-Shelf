// Exercise the exact release image against copies of a database created by
// the published 0.1.6 image. No personal volume, account or API key is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { env as fixtureEnv, title as lookupTitle, coverUrl } from "./metadata-fixtures.cjs";

const old = "jyh9521/gameshelf@sha256:9148dbe5e4b81e996ee10b69f7c23ae7b21c723b9114accf5e678859a3af87e1";
const image = process.env.TEST_IMAGE ?? "jyh9521/gameshelf:0.1.7";
const published = process.argv.includes("--published");
const id = "gs-release-017-" + Date.now() + "-" + randomBytes(3).toString("hex");
const label = "release-0.1.7", runLabel = "gameshelf.run=" + id;
const dir = resolve(process.env.RELEASE_QA_DIR ?? "engineering/release-0.1.7", published ? "published" : "container");
mkdirSync(dir, { recursive: true });
const path = name => resolve(dir, name);
const name = phase => id + "-" + phase;
const volumes = new Set(), containers = new Set(), records = [];
const log = line => { records.push(line); console.log(line); };
const password = randomBytes(24).toString("hex");
const sensitive = Object.entries(fixtureEnv).filter(([key]) => key !== "SCREENSCRAPER_SOFTNAME").map(([, value]) => value);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 }).trim();
let browser, checks = 0;
const phases = new Map();
const save = (file, value) => writeFileSync(path(file), JSON.stringify(value, null, 2) + "\n");
const own = { platformId: "PC", storeId: "STEAM", mediaType: "DIGITAL", acquisitionType: "PURCHASE", accessStatus: "ACTIVE", releaseDate: "2005" };
const envFile = (file, env) => {
  const filename = path(file);
  writeFileSync(filename, Object.entries(env).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  return filename;
};
function noSecrets(body) {
  for (const secret of sensitive) assert.ok(!body.includes(secret), "credential outside provider transport");
  assert.doesNotMatch(body, /QA-fixture-igdb-token|[?&](apikey|devpassword|sspassword)=/);
}
function volume(phase) {
  const v = name(phase);
  docker("volume", "create", "--label", "gameshelf.qa=" + label, "--label", runLabel, v);
  volumes.add(v);
  return v;
}
function helper(v, code, readOnly = false) {
  assert.ok(volumes.has(v));
  return docker("run", "--rm", "--label", runLabel, "--entrypoint", "node",
    "--mount", "type=volume,source=" + v + ",target=/data" + (readOnly ? ",readonly" : ""), old, "-e", code);
}
function copyVolume(source, target) {
  assert.ok(volumes.has(source) && volumes.has(target) && source !== target);
  docker("run", "--rm", "--label", runLabel, "--entrypoint", "sh", "--mount", "type=volume,source=" + source + ",target=/from,readonly",
    "--mount", "type=volume,source=" + target + ",target=/to", old, "-c", "test -f /from/gameshelf.db && cp -a /from/. /to/");
}
const stats = v => JSON.parse(helper(v,
  "const f=require('node:fs'),c=require('node:crypto'),out={};for(const n of ['gameshelf.db','setup-token','keep.txt']){const p='/data/'+n,s=f.statSync(p);out[n]={uid:s.uid,gid:s.gid,mode:s.mode&511,sha256:c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}}console.log(JSON.stringify(out))", true));
const tokenOf = phase => docker("exec", name(phase), "cat", "/data/setup-token");
const fullFields = ["title", "originalTitle", "localizedTitle", "description", "developer", "publisher", "genre", "coverUrl"];
const personalFields = ["status", "rating", "favorite", "memo"];
const form = game => ({
  ...Object.fromEntries(fullFields.map(key => [key, game[key]])),
  ...Object.fromEntries(personalFields.map(key => [key, game.profiles[0][key]])), revision: game.metadataRevision
});
const select = (preview, fields) => ({ token: preview.token, fields });

async function ready(phase) {
  const container = name(phase);
  const port = docker("port", container, "3000/tcp").split(":").at(-1);
  assert.match(port, /^\d+$/);
  const url = "http://127.0.0.1:" + port;
  let live = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(800) })).ok) { live = true; break; } } catch {}
    if (docker("inspect", "--format", "{{.State.Running}}", container) !== "true") break;
    await new Promise(r => setTimeout(r, 350));
  }
  if (!live) throw Error(phase + " startup: " + docker("logs", container));
  assert.equal(docker("exec", container, "node", "-p",
    "const s=require('fs').readFileSync('/proc/1/status','utf8');s.match(/Uid:\\s+(\\d+)/)[1]+':'+s.match(/Gid:\\s+(\\d+)/)[1]"), "99:100");
  phases.set(phase, url);
  return url;
}
async function health(phase) {
  for (let i = 0; i < 35; i++) {
    if (docker("inspect", "--format", "{{.State.Health.Status}}", name(phase)) === "healthy") return "healthy";
    await new Promise(r => setTimeout(r, 750));
  }
  throw Error(phase + " Docker healthcheck timeout");
}
async function start(phase, v, tag, settings = null, fixture = false) {
  assert.ok(volumes.has(v));
  const args = ["run", "-d", "--name", name(phase), "--label", "gameshelf.qa=" + label, "--label", runLabel,
    "--pull", "never", "-p", "127.0.0.1::3000", "--health-interval", "2s", "--health-start-period", "8s",
    "-e", "PUID=99", "-e", "PGID=100", "-e", "PRISMA_HIDE_UPDATE_MESSAGE=1",
    "--mount", "type=volume,source=" + v + ",target=/data"];
  if (settings) args.push("--env-file", settings);
  if (fixture) {
    const source = fileURLToPath(new URL("./metadata-fixtures.cjs", import.meta.url));
    args.push("--mount", "type=bind,source=" + source + ",target=/qa/providers.cjs,readonly",
      "-e", "NODE_OPTIONS=--require=/qa/providers.cjs", "-e", "GAMESHELF_QA_PROVIDER_LOG=/data/qa-provider-requests.log");
  }
  containers.add(name(phase));
  docker(...args, tag);
  return ready(phase);
}
async function call(phase, cookie, path, method = "GET", input, status = 200) {
  const response = await fetch(phases.get(phase) + "/api/" + path, {
    method, signal: AbortSignal.timeout(12000),
    headers: { cookie, "content-type": "application/json", "x-gameshelf-request": "1" },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  const raw = await response.text(); noSecrets(raw);
  assert.equal(response.status, status, method + " " + phase + " " + path + " " + raw);
  checks++;
  return { data: JSON.parse(raw), cookie: response.headers.get("Set-Cookie")?.split(";")[0] };
}
const using = (phase, cookie) => async (...args) => (await call(phase, cookie, ...args)).data;
async function setup(phase, username) {
  return (await call(phase, "", "auth/setup", "POST", {
    username, password, passwordConfirm: password, setupToken: tokenOf(phase)
  }, 201)).cookie;
}
function stable(b, legacyComparison = false) {
  const data = structuredClone(b); delete data.exportedAt;
  if (legacyComparison) {
    delete data.fieldHistory; data.schema_version = 2;
    for (const p of data.profiles) p.overridesJson = JSON.parse(p.overridesJson);
  }
  for (const value of Object.values(data)) if (Array.isArray(value)) value.sort((a, b) => a.id.localeCompare(b.id));
  return data;
}
const enabled = async api => (await api("metadata/providers")).providers.filter(p => p.enabled).map(p => p.id);
const portable = b => ({ ...b, exportedAt: new Date().toISOString() });
const sourceOf = (report, field) => report.fields.find(f => f.field === field);
async function find(api, provider) {
  const matches = await api("metadata/search", "POST", { provider, query: lookupTitle });
  assert.equal(matches.items[0]?.title, lookupTitle);
  const { items } = await api("metadata/preview", "POST", { provider, id: matches.items[0].id });
  assert.equal(items[0]?.candidate.provider, provider);
  return items[0];
}
function version(phase, expected) {
  assert.equal(docker("exec", name(phase), "node", "-p", "require('./package.json').version"), expected);
}
function assertImage() {
  const x = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(x.Os + "/" + x.Architecture, "linux/amd64");
  assert.equal(x.Config.Labels["org.opencontainers.image.version"], "0.1.7");
  if (process.env.SOURCE_REVISION) assert.equal(x.Config.Labels["org.opencontainers.image.revision"], process.env.SOURCE_REVISION);
  save("image-identity.json", { id: x.Id, repoDigests: x.RepoDigests, os: x.Os, arch: x.Architecture, labels: x.Config.Labels });
}
const pair = { RAWG_API_KEY: fixtureEnv.RAWG_API_KEY, STEAMGRIDDB_API_KEY: fixtureEnv.STEAMGRIDDB_API_KEY };

async function release() {
  const baseline = volume("baseline"), upgrade = volume("upgrade"), rollback = volume("rollback"), restore = volume("restore");
  await start("baseline", baseline, old);
  version("baseline", "0.1.6");
  const username = "release-017-qa";
  const cookie = await setup("baseline", username);
  const before = using("baseline", cookie);
  const add = (title, date, rating) => before("games", "POST", {
    title, genre: "RPG", description: "旧库手动简介", developer: "旧库工作室", rating, status: "CLEARED", favorite: true,
    memo: "旧库备注", ownership: { ...own, releaseDate: date, manualTotalOverride: 7200 }
  }, 201);
  const original = await add("QA 0.1.6 原作", "2005-02", 5);
  const remake = await add("QA 0.1.6 重制", "2023", 3);
  const remaster = await add("QA 0.1.6 复刻", "2010-03-18", 4);
  const relation = await before("games/" + remake.id + "/relations", "POST", { targetGameId: original.id, type: "REMAKE_OF", note: "旧版建立关系" }, 201);
  await before("relations/" + relation.id, "PUT", { type: "REMAKE_OF", note: "旧版补充判定依据" });
  await before("games/" + remaster.id + "/relations", "POST", { targetGameId: original.id, type: "REMASTER_OF", note: "旧版建立复刻关系" }, 201);
  await before("games/" + original.id + "/items", "POST", { ...own, platformId: "PS4", storeId: "PHYSICAL", mediaType: "PHYSICAL", releaseDate: "2010" }, 201);
  await before("metadata/providers", "GET", undefined, 404);
  await before("games/" + original.id + "/fields", "GET", undefined, 404);
  assert.equal((await before("auth/status")).user.username, username);
  assert.equal((await before("games?genre=RPG&year=2005&rating=5")).total, 1);
  const originalBackup = await before("backup");
  assert.equal(originalBackup.schema_version, 2);
  assert.equal(originalBackup.games.length, 3); assert.equal(originalBackup.items.length, 4);
  assert.equal(originalBackup.relations.length, 2); assert.equal(originalBackup.relationHistory.length, 3);
  save("baseline-backup-v2.json", originalBackup);
  log("BASELINE PASS image=0.1.6 games=3 items=4 relations=2 relationHistory=3 backup=v2 metadata=404");
  docker("stop", name("baseline"));
  helper(baseline, "require('node:fs').writeFileSync('/data/keep.txt','independent QA marker',{mode:384})");
  const baselineStats = stats(baseline);
  copyVolume(baseline, upgrade); copyVolume(baseline, rollback);
  assert.deepEqual(stats(upgrade), baselineStats); assert.deepEqual(stats(rollback), baselineStats);
  // Emulate old appdata ownership on the upgrade copy alone.
  helper(upgrade, "const f=require('node:fs');f.chownSync('/data/setup-token',0,0);f.chownSync('/data/gameshelf.db',1000,1000)");

  const all = envFile("all-providers.qa.env", fixtureEnv);
  const url = await start("upgrade", upgrade, image, all, true);
  const upgraded = using("upgrade", cookie);
  version("upgrade", "0.1.7");
  assert.equal((await upgraded("auth/status")).user.username, username);
  const newBackup = await upgraded("backup");
  assert.equal(newBackup.schema_version, 3);
  assert.deepEqual(newBackup.fieldHistory, []);
  assert.deepEqual(stable(newBackup, true), stable(originalBackup, true));
  assert.equal((await upgraded("games?genre=RPG&year=2005&rating=5")).total, 1);
  const after = stats(upgrade);
  for (const key of ["setup-token", "gameshelf.db"]) {
    assert.equal(after[key].uid + ":" + after[key].gid, "99:100");
    assert.equal(after[key].mode, 0o600);
  }
  assert.equal(after["setup-token"].sha256, baselineStats["setup-token"].sha256);
  assert.deepEqual(after["keep.txt"], baselineStats["keep.txt"]);
  assert.match(docker("logs", name("upgrade")), /20261109000000_metadata_history/);
  const gamePath = "games/" + original.id;
  const getFields = () => upgraded(gamePath + "/fields");
  const first = await getFields();
  assert.deepEqual(first.history, []);
  assert.deepEqual(sourceOf(first, "description"), { field: "description", value: "旧库手动简介", locked: true, source: null });
  log("UPGRADE PASS data=equal session=preserved setup-token=unchanged uid=99:100 migration=additive backup=v3");

  const providers = await enabled(upgraded);
  assert.deepEqual(providers, ["igdb", "rawg", "thegamesdb", "screenscraper", "steamgriddb"]);
  await call("upgrade", "", "metadata/providers", "GET", undefined, 401);
  const previews = {};
  for (const provider of providers) previews[provider] = await find(upgraded, provider);
  assert.equal(previews.igdb.candidate.fields.developer, "IGDB QA Studio");
  assert.equal(previews.thegamesdb.candidate.fields.genre, "Strategy");
  assert.equal(previews.screenscraper.candidate.fields.publisher, "SS QA Press");
  assert.deepEqual(previews.steamgriddb.candidate.fields, { coverUrl });
  const update = await upgraded(gamePath, "PUT", {
    ...form(await upgraded(gamePath)), candidates: [select(previews.rawg, ["description"]), select(previews.steamgriddb, ["coverUrl"])]
  });
  assert.equal(update.description, "旧库手动简介"); assert.equal(update.coverUrl, "");
  const report = await getFields();
  assert.equal(sourceOf(report, "coverUrl").source.value, coverUrl);
  assert.equal(sourceOf(report, "description").source.value, "RAWG 的来源简介");
  await upgraded(gamePath + "/fields/unlock", "POST", { field: "description", revision: report.revision });
  const unlocked = await upgraded(gamePath);
  assert.equal(unlocked.description, "RAWG 的来源简介"); assert.equal(unlocked.coverUrl, "");
  assert.equal(unlocked.profiles[0].memo, "旧库备注"); assert.equal(unlocked.profiles[0].rating, 5);
  const added = await upgraded("games", "POST", {
    title: lookupTitle, coverUrl, candidates: [select(previews.igdb, ["title"]), select(previews.steamgriddb, ["coverUrl"])], ownership: own
  }, 201);
  assert.equal(added.coverUrl, coverUrl);
  const requests = docker("exec", name("upgrade"), "cat", "/data/qa-provider-requests.log");
  noSecrets(requests);
  for (const host of ["api.igdb.com", "api.rawg.io", "api.thegamesdb.net", "api.screenscraper.fr", "www.steamgriddb.com"]) assert.ok(requests.includes(host));
  writeFileSync(path("provider-hosts.txt"), requests + "\n");
  log("DOCKER_ENV PASS enabled=5 synthetic-transport=5 locked-values=preserved cover=verified credentials=redacted");

  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 970 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    const address = route.request().url();
    noSecrets(address);
    if (address.startsWith(url + "/")) return route.continue();
    return route.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url }]);
  await page.goto(url);
  await expect(page.getByText("LOCAL-FIRST / v0.1.7", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "QA 0.1.6 原作", exact: true }).click();
  await page.getByText("字段来源与历史", { exact: true }).click();
  await expect(page.locator(".field-state").getByText("候选：" + coverUrl, { exact: true })).toBeVisible();
  await page.getByText("字段来源与历史", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path("desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "恢复自动更新：封面", exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
  await page.screenshot({ path: path("mobile.png") });
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;

  const saved = await upgraded("backup");
  assert.ok(saved.fieldHistory.length >= 5);
  save("modified-backup-v3.json", saved);
  assert.equal(await health("upgrade"), "healthy");
  docker("stop", name("upgrade"));
  writeFileSync(path("upgrade-initial.log"), docker("logs", name("upgrade")) + "\n");
  docker("rm", name("upgrade"));
  const reduced = envFile("selected-providers.qa.env", pair);
  await start("recreate", upgrade, image, reduced);
  const recreated = using("recreate", cookie);
  assert.deepEqual(await enabled(recreated), ["rawg", "steamgriddb"]);
  await recreated("metadata/search", "POST", { provider: "igdb", query: lookupTitle }, 409);
  assert.deepEqual(stable(await recreated("backup")), stable(saved));
  assert.equal((await recreated("auth/status")).user.username, username);
  assert.equal(docker("exec", name("recreate"), "node", "-p",
    "['/app/.env','/app/tests','/qa/providers.cjs'].every(p=>!require('fs').existsSync(p))"), "true");
  log("RECREATE PASS providers=rawg,steamgriddb disabled=igdb,thegamesdb,screenscraper v3=equal session=preserved");

  const script = resolve(dir, "..", "ROLLBACK.sh");
  const scriptContent = [
    "#!/usr/bin/env bash", "set -euo pipefail", "export MSYS_NO_PATHCONV=1",
    'NAME="${1:?isolated QA container name}"; VOLUME="${2:?isolated QA snapshot volume}"',
    'case "$NAME" in gs-release-017-*-rollback) ;; *) echo "Expected a release-0.1.7 QA rollback name" >&2; exit 2;; esac',
    '[[ "$VOLUME" == "$NAME" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.qa"}}\' "$VOLUME")" == "release-0.1.7" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.run"}}\' "$VOLUME")" == "${NAME%-rollback}" ]]',
    'docker run -d --pull never --name "$NAME" --label gameshelf.qa=release-0.1.7 --label "gameshelf.run=${NAME%-rollback}" -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ' + old + ' >/dev/null',
    'echo "ROLLBACK_STARTED image=0.1.6 snapshot=isolated"', ""
  ].join("\n");
  writeFileSync(script, scriptContent); chmodSync(script, 0o755);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  execFileSync(bash, ["-c", 'chmod +x "$1" && test -x "$1" && bash -n "$1"', "--", script], { windowsHide: true });
  containers.add(name("rollback"));
  const rollbackCommand = [bash, script.replaceAll("\\", "/"), name("rollback"), rollback];
  const rollbackOutput = execFileSync(rollbackCommand[0], rollbackCommand.slice(1), { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(rollbackOutput, "ROLLBACK_STARTED image=0.1.6 snapshot=isolated");
  save("rollback-command.json", { command: rollbackCommand, input: { snapshot: rollback, source: "independent pre-upgrade 0.1.6 volume" }, output: rollbackOutput, exit: 0 });
  await ready("rollback"); version("rollback", "0.1.6");
  const restored = using("rollback", cookie);
  assert.equal((await restored("auth/status")).user.username, username);
  assert.deepEqual(stable(await restored("backup")), stable(originalBackup));
  await restored("metadata/providers", "GET", undefined, 404);
  await restored(gamePath + "/fields", "GET", undefined, 404);
  await restored("backup/preview", "POST", portable(saved), 400);
  assert.deepEqual(stats(baseline), baselineStats);
  save("snapshot-hashes.json", { baseline: baselineStats, upgraded: after, baselineUntouched: true });
  log("ROLLBACK PASS image=0.1.6 snapshot=isolated data=v2-identical metadata=404 session=preserved");

  await start("restore", restore, image);
  const empty = using("restore", await setup("restore", "release-017-restore"));
  assert.deepEqual(await enabled(empty), []);
  assert.equal((await empty("backup/preview", "POST", portable(originalBackup))).migratedFrom, 2);
  await empty("backup/restore", "POST", portable(originalBackup));
  assert.deepEqual(stable(await empty("backup"), true), stable(originalBackup, true));
  for (const game of originalBackup.games) await empty("games/" + game.id, "DELETE");
  await empty("backup/restore", "POST", portable(saved));
  assert.deepEqual(stable(await empty("backup")), stable(saved));
  assert.equal((await empty("backup/restore", "POST", portable(saved))).duplicate, true);
  log("RESTORE PASS v2=migrated v3=equal duplicate=idempotent disabled-configuration=usable");
  log("RELEASE PASS HTTP=" + checks + " platform=linux/amd64 UI=desktop,390px health=healthy");
}

async function publishedSmoke() {
  assert.match(image, /^jyh9521\/gameshelf@sha256:[0-9a-f]{64}$/);
  const v = volume("published"), keys = envFile("published-providers.qa.env", pair);
  await start("published", v, image, keys, true);
  version("published", "0.1.7");
  const api = using("published", await setup("published", "release-017-published"));
  assert.deepEqual(await enabled(api), ["rawg", "steamgriddb"]);
  const rawg = await find(api, "rawg"), grid = await find(api, "steamgriddb");
  const work = await api("games", "POST", { title: lookupTitle, coverUrl, ownership: own,
    candidates: [select(rawg, ["title"]), select(grid, ["coverUrl"])] }, 201);
  assert.equal((await api("games/" + work.id)).coverUrl, coverUrl);
  const backup = await api("backup");
  assert.equal(backup.schema_version, 3); assert.equal(backup.fieldHistory.length, 2);
  assert.equal(await health("published"), "healthy");
  log("PUBLISHED PASS HTTP=" + checks + " image=" + image + " providers=rawg,steamgriddb backup=v3 uid=99:100 health=healthy");
}

try {
  assertImage();
  if (published) await publishedSmoke(); else await release();
} finally {
  await browser?.close();
  let logError;
  for (const container of containers) {
    const matching = docker("ps", "-a", "--filter", "label=" + runLabel, "--format", "{{.Names}}").split(/\r?\n/);
    if (!matching.includes(container)) continue;
    try { const output = docker("logs", container); noSecrets(output); writeFileSync(path(container + ".log"), output + "\n"); }
    catch (e) { logError ??= e; }
    docker("rm", "-f", container);
  }
  for (const v of volumes) {
    assert.equal(docker("volume", "inspect", "--format", '{{index .Labels "gameshelf.run"}}', v), id);
    docker("volume", "rm", v);
  }
  assert.equal(docker("ps", "-a", "--filter", "label=" + runLabel, "--format", "{{.Names}}"), "");
  assert.equal(docker("volume", "ls", "--filter", "label=" + runLabel, "--format", "{{.Name}}"), "");
  log("QA_CLEANUP PASS containers=0 volumes=0");
  writeFileSync(path("results.txt"), records.join("\n") + "\n");
  if (logError) throw logError;
}

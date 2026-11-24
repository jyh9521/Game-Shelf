// Compare the real 0.1.11 image with the candidate on independent volumes,
// using deterministic wire-level responses and a real browser for translation.
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { env, title as metadataTitle, coverGallery } from "./metadata-fixtures.cjs";
import { key as steamKey, prefix } from "./steam-preview-fixture.cjs";
import { geminiKey, description, translations, title } from "./release-0.1.10-fixtures.cjs";

import { checkSteamImport } from "./steam-import-checks.mjs";
import { seedComparison, checkComparison, comparisonUI } from "./steam-library-match-checks.mjs";

const version = "0.1.12";
const old = "jyh9521/gameshelf@sha256:728d8a9f0d7307c11276f48d0290611a2fec8a471af4051c5121f88bffe5d35a";
const published = process.argv.includes("--published");
const image = process.env.TEST_IMAGE ?? "jyh9521/gameshelf:" + version;
const id = "gs-release-0112-" + Date.now() + "-" + randomBytes(3).toString("hex");
const runLabel = "gameshelf.run=" + id, qaLabel = "gameshelf.qa=release-0.1.12";
const root = resolve(process.env.RELEASE_QA_DIR ?? "engineering/release-0.1.12");
const dir = resolve(root, published ? "published" : "container");
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name), name = phase => id + "-" + phase;
const logLines = [], volumes = new Set(), containers = new Set(), urls = new Map();
const log = message => { logLines.push(message); console.log(message); };
const json = (f, data) => writeFileSync(file(f), JSON.stringify(data, null, 2) + "\n");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 }).trim();
const fixtureDir = resolve("tests");
const password = randomBytes(24).toString("hex"), username = "release-0112-qa";
const settings = file("providers.qa.env"), disabledSettings = file("providers-disabled.qa.env");
const secrets = [...Object.values(env).filter(value => value !== env.SCREENSCRAPER_SOFTNAME), steamKey, geminiKey, password];
const redact = text => secrets.reduce((out, secret) => out.replaceAll(secret, "[QA_REDACTED]"), text);
const envLines = (value) => Object.entries({ ...env, GEMINI_MODEL: "", ...value }).map(([k, v]) => k + "=" + v).join("\n") + "\n";
writeFileSync(settings, envLines({ STEAM_WEB_API_KEY: steamKey, GEMINI_API_KEY: geminiKey }));
writeFileSync(disabledSettings, envLines({ STEAM_WEB_API_KEY: "", GEMINI_API_KEY: "" }));
let checks = 0, browser;

function volume(phase) {
  const v = name(phase);
  docker("volume", "create", "--label", qaLabel, "--label", runLabel, v);
  volumes.add(v);
  return v;
}
const mount = (v, target, readOnly = false) => "type=volume,source=" + v + ",target=" + target + (readOnly ? ",readonly" : "");
function copy(source, target) {
  assert.ok(volumes.has(source) && volumes.has(target) && source !== target);
  docker("run", "--rm", "--pull", "never", "--label", runLabel, "--entrypoint", "sh",
    "--mount", mount(source, "/from", true), "--mount", mount(target, "/to"), old, "-c", "test -f /from/gameshelf.db && cp -a /from/. /to/");
}
function snapshot(v) {
  assert.ok(volumes.has(v));
  const code = "const f=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(['gameshelf.db','setup-token'].map(n=>[n,c.createHash('sha256').update(f.readFileSync('/data/'+n)).digest('hex')]))))";
  return JSON.parse(docker("run", "--rm", "--pull", "never", "--label", runLabel, "--entrypoint", "node", "--mount", mount(v, "/data", true), old, "-e", code));
}
async function ready(phase, expected) {
  const port = docker("port", name(phase), "3000/tcp").split(":").at(-1);
  assert.match(port, /^\d+$/);
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    let up = false;
    try { up = (await fetch(url + "/api/health", { signal: AbortSignal.timeout(750) })).ok; } catch {}
    if (up) {
      assert.equal(docker("exec", name(phase), "node", "-p", "require('./package.json').version"), expected);
      assert.equal(docker("exec", name(phase), "node", "-p",
        "const s=require('fs').readFileSync('/proc/1/status','utf8');s.match(/Uid:\\s+(\\d+)/)[1]+':'+s.match(/Gid:\\s+(\\d+)/)[1]"), "99:100");
      urls.set(phase, url);
      return url;
    }
    if (docker("inspect", "--format", "{{.State.Running}}", name(phase)) !== "true") break;
    await new Promise(r => setTimeout(r, 300));
  }
  throw Error(phase + " startup failed: " + redact(docker("logs", name(phase))));
}
async function healthy(phase) {
  for (let i = 0; i < 35; i++) {
    if (docker("inspect", "--format", "{{.State.Health.Status}}", name(phase)) === "healthy") return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw Error(phase + " healthcheck failed");
}
async function start(phase, v, tag, expected, config = settings) {
  assert.ok(volumes.has(v));
  const reservation=createServer();await new Promise(r=>reservation.listen(0,"127.0.0.1",r));
  const hostPort=reservation.address().port;await new Promise(r=>reservation.close(r));
  containers.add(name(phase));
  docker("run", "-d", "--pull", "never", "--name", name(phase), "--label", qaLabel, "--label", runLabel,
    "-p", "127.0.0.1:"+hostPort+":3000", "--health-interval", "2s", "--health-start-period", "8s", "-e", "PUID=99", "-e", "PGID=100",
    "-e", "PRISMA_HIDE_UPDATE_MESSAGE=1", "-e", "APP_URL=http://127.0.0.1:"+hostPort, "--env-file", config, "--mount", mount(v, "/data"),
    "--mount", "type=bind,source=" + fixtureDir + ",target=/qa,readonly",
    "-e", "NODE_OPTIONS=--require=/qa/steam-import-fixture.cjs", "-e", "GAMESHELF_QA_RELEASE_LOG=/data/qa-providers.log",
    "-e", "GAMESHELF_QA_STEAM_LOG=/data/qa-steam.log", tag);
  return ready(phase, expected);
}
async function call(phase, cookie, path, method = "GET", input, status = 200, requestHeader = true) {
  const response = await fetch(urls.get(phase) + "/api/" + path, {
    method, signal: AbortSignal.timeout(12000),
    // Docker snapshot commands can outlive Next's keep-alive window. Do not
    // reuse a socket across those pauses, and never retry a write implicitly.
    headers: { cookie, connection: "close", "content-type": "application/json", ...(requestHeader ? { "x-gameshelf-request": "1" } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  const raw = await response.text(), safe = redact(raw);
  assert.equal(raw, safe, "credential leaked in HTTP body");
  assert.equal(response.status, status, method + " " + phase + "/" + path + " " + safe);
  assert.equal(response.headers.get("cache-control"), "no-store");
  checks++;
  return { data: JSON.parse(raw), cookie: response.headers.get("Set-Cookie")?.split(";")[0], retry: response.headers.get("retry-after") };
}
const apiFor = (phase, cookie) => async (...args) => (await call(phase, cookie, ...args)).data;
async function setup(phase) {
  const setupToken = docker("exec", name(phase), "cat", "/data/setup-token");
  return (await call(phase, "", "auth/setup", "POST", { username, password, passwordConfirm: password, setupToken }, 201)).cookie;
}
const stable = b => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "exportedAt").map(([k, v]) =>
  [k, Array.isArray(v) ? v.toSorted((a, b) => a.id.localeCompare(b.id)) : v]));
const providers = ["igdb", "rawg", "thegamesdb", "screenscraper", "steamgriddb"];
const stableCandidate = ({ token, candidate: { collectedAt, ...candidate }, ...view }) => {
  assert.equal(typeof token, "string");
  assert.ok(Number.isFinite(Date.parse(collectedAt)));
  return { ...view, candidate };
};
async function metadata(api) {
  const flags = (await api("metadata/providers")).providers;
  assert.deepEqual(flags.filter(p => p.enabled).map(p => p.id).sort(), [...providers].sort());
  const output = { flags, sources: {}, gallery: [] };
  for (const provider of providers) {
    const hits = (await api("metadata/search", "POST", { provider, query: metadataTitle })).items;
    assert.ok(hits.length > 0);
    const details = await api("metadata/preview", "POST", { provider, id: hits[0].id });
    assert.ok(details.items.length > 0);
    assert.equal(details.items[0].candidate.provider, provider);
    if (provider !== "steamgriddb") assert.ok(details.items[0].candidate.fields.description);
    output.sources[provider] = { hits, items: details.items.map(stableCandidate) };
  }
  const search = await api("metadata/search", "POST", { provider: "steamgriddb", query: coverGallery.title });
  assert.equal(search.items[0].id, coverGallery.id);
  for (let page = 0; page < 6; page++) {
    const result = await api("metadata/preview", "POST", { provider: "steamgriddb", id: coverGallery.id, page });
    const grids = coverGallery.grids.slice(page * 12, (page + 1) * 12).filter(g => !g.humor);
    assert.deepEqual(result.pagination, { page, pageSize: 12, totalPages: 6, hasNext: page < 5 });
    assert.deepEqual(result.items.map(p => p.candidate.fields.coverUrl), grids.map(g => g.url));
    output.gallery.push({ ...result, items: result.items.map(stableCandidate) });
  }
  output.invalid = await api("metadata/search", "POST", { provider: "not-a-provider", query: metadataTitle }, 400);
  output.failure = await api("metadata/search", "POST", { provider: "rawg", query: "bad-json" }, 502);
  return output;
}
const translationRoute = "translations/description";
const translation = { text: description, target: "zh-CN" };
const steam = { steamId: prefix + "01" };
const ownership = { platformId: "PC", storeId: "STEAM", releaseDate: "2024", manualTotalOverride: 3600 };
async function newApi(api, ids) {
  const catalog = await api("catalog");
  assert.deepEqual(catalog.steamPreview, { configured: true });
  assert.deepEqual(catalog.descriptionTranslation, { configured: true });
  const preview = await api("steam/preview", "POST", steam);
  assert.equal(preview.items.length, 13);
  if (ids) checkComparison(preview, ids);
  assert.equal(preview.items[0].playtimeMinutes, 0);
  assert.equal(preview.items[1].playtimeMinutes, null);
  assert.deepEqual(await api(translationRoute, "POST", translation), { text: translations["zh-CN"] });
  assert.deepEqual(await api(translationRoute, "POST", { ...translation, target: "ja" }), { text: translations.ja });
}
async function translationUI(url, cookie, game, api) {
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 920 } }), errors = [], outside = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", r => {
    if (new URL(r.request().url()).origin === url) return r.continue();
    outside.push(new URL(r.request().url()).origin);
    return r.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url }]);
  await page.goto(url);
  await expect(page.getByText("LOCAL-FIRST / v" + version, { exact: true })).toBeVisible();
  await page.getByLabel("搜索游戏", { exact: true }).fill(title);
  await page.getByRole("heading", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
  const text = editor.locator('textarea[name="description"]');
  const panel = editor.locator(".description-translation");
  await panel.locator("summary").click();
  await expect(panel.getByLabel("译文语言")).toHaveValue("zh-CN");
  await panel.getByRole("button", { name: "翻译当前简介" }).click();
  const result = panel.getByRole("region", { name: "译文预览" });
  await expect(result).toContainText("探索灯笼海");
  await expect(text).toHaveValue(description);
  assert.equal((await api("games/" + game.id)).description, description);
  await panel.screenshot({ path: file("gemini-preview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    [...document.querySelectorAll(".modal")].every(x => x.scrollWidth <= x.clientWidth)));
  await panel.getByLabel("译文语言").selectOption("ja");
  await expect(result).toHaveCount(0);
  await panel.getByRole("button", { name: "翻译当前简介" }).click();
  await expect(result).toContainText("ランタンの海");
  await text.fill(description + " New draft.");
  await expect(result).toHaveCount(0);
  await text.fill(description);
  await expect(result).toContainText("ランタンの海");
  await panel.screenshot({ path: file("gemini-preview-mobile.png") });
  await result.getByRole("button", { name: "采用译文" }).click();
  await expect(text).toHaveValue(translations.ja);
  assert.equal((await api("games/" + game.id)).description, description);
  await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
  await expect(editor).toHaveCount(0);
  assert.equal((await api("games/" + game.id)).description, translations.ja);
  const field = (await api("games/" + game.id + "/fields")).fields.find(f => f.field === "description");
  assert.equal(field.locked, true);
  assert.equal(field.value, translations.ja);
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  await browser.close(); browser = undefined;
}
async function comparisonBrowser(url, cookie, api, ids) {
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 920 } }), errors = [], outside = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", r => {
    if (new URL(r.request().url()).origin === url) return r.continue();
    outside.push(r.request().url()); return r.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url }]);
  await page.goto(url);
  await comparisonUI(page, file, { edit: true });
  const updated = await api("games/" + ids.single);
  assert.equal(updated.originalTitle, "QA changed alias");
  assert.equal(updated.profiles[0].rating, 5);
  assert.equal(updated.profiles[0].memo, "QA preserved memo");
  assert.equal((await api("steam/preview", "POST", steam)).summary.single_candidate, 0);
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  await browser.close(); browser = undefined;
}

async function rollback(v) {
  const script = resolve(root, "ROLLBACK.sh");
  writeFileSync(script, [
    "#!/usr/bin/env bash", "set -euo pipefail", "export MSYS_NO_PATHCONV=1",
    'NAME="${1:?QA container}"; VOLUME="${2:?QA snapshot}"',
    'case "$NAME" in gs-release-0112-*-rollback) ;; *) exit 2;; esac',
    '[[ "$VOLUME" == "$NAME" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.qa"}}\' "$VOLUME")" == "release-0.1.12" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.run"}}\' "$VOLUME")" == "${NAME%-rollback}" ]]',
    'docker run -d --pull never --name "$NAME" --label gameshelf.qa=release-0.1.12 --label "gameshelf.run=${NAME%-rollback}" -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ' + old + ' >/dev/null',
    'echo "ROLLBACK_STARTED image=0.1.11 snapshot=isolated"', ""
  ].join("\n"));
  chmodSync(script, 0o755);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const sh = script.replaceAll("\\", "/");
  execFileSync(bash, ["-c", 'chmod +x "$1" && test -x "$1" && bash -n "$1"', "--", sh], { windowsHide: true });
  const command = [bash, sh, name("rollback"), v];
  containers.add(name("rollback"));
  const output = execFileSync(bash, command.slice(1), { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(output, "ROLLBACK_STARTED image=0.1.11 snapshot=isolated");
  json("rollback-command.json", { command, input: "independent pre-upgrade 0.1.11 volume", output, exit: 0 });
  await ready("rollback", "0.1.11");
}
async function release() {
  const baseline = volume("baseline"), upgrade = volume("upgrade"), rollbackVolume = volume("rollback");
  await start("baseline", baseline, old, "0.1.11");
  const cookie = await setup("baseline"), before = apiFor("baseline", cookie);
  const game = await before("games", "POST", { title, description, rating: 5, memo: "QA 个人备注", ownership }, 201);
  const related = await before("games", "POST", { title: "QA 原作", ownership }, 201);
  await before("games/" + game.id + "/relations", "POST", { targetGameId: related.id, type: "REMAKE_OF", note: "QA 旧关系" }, 201);
  const comparisonIds = await seedComparison(before);
  const oldBackup = stable(await before("backup"));
  assert.equal(oldBackup.schema_version, 3); assert.equal(oldBackup.games.length, 31); assert.equal(oldBackup.relations.length, 1);
  const reference = await metadata(before), oldCatalog = await before("catalog");
  checkComparison(await before("steam/preview", "POST", steam), comparisonIds);
  assert.deepEqual(await before(translationRoute, "POST", translation), { text: translations["zh-CN"] });
  log("BASELINE PASS image=0.1.11 providers=5 covers=6-pages steam=13 comparison=present backup=v3");
  docker("stop", name("baseline"));
  const hashes = snapshot(baseline);
  copy(baseline, upgrade); copy(baseline, rollbackVolume);
  assert.deepEqual(snapshot(upgrade), hashes); assert.deepEqual(snapshot(rollbackVolume), hashes);
  const url = await start("upgrade", upgrade, image, version), api = apiFor("upgrade", cookie);
  assert.equal((await api("auth/status")).user.username, username);
  assert.deepEqual(stable(await api("backup")), {...oldBackup,schema_version:4,steamLinks:[]});
  assert.equal(snapshot(upgrade)["setup-token"], hashes["setup-token"]);
  assert.match(docker("logs", name("upgrade")), /20261124010000_steam_import/);
  const { steamPreview, descriptionTranslation, ...catalog } = await api("catalog");
  assert.deepEqual({ ...catalog, steamPreview, descriptionTranslation }, oldCatalog);
  assert.deepEqual(await metadata(api), reference);
  log("LEGACY_APIS PASS differential=identical providers=IGDB,RAWG,TheGamesDB,ScreenScraper,SteamGridDB covers=6-pages");

  await call("upgrade", "", translationRoute, "POST", translation, 401);
  await call("upgrade", cookie, translationRoute, "POST", translation, 403, false);
  const member = randomBytes(32).toString("hex");
  const seed = 'const {PrismaClient}=require("@prisma/client");const db=new PrismaClient();(async()=>{await db.user.create({data:{id:"qa-member",username:"qa-member",passwordHash:"unused"}});await db.session.create({data:{userId:"qa-member",tokenHash:process.argv[1],expiresAt:new Date(Date.now()+3600000)}})})().finally(()=>db.$disconnect()).catch(()=>process.exit(1));';
  docker("exec", name("upgrade"), "node", "-e", seed, createHash("sha256").update(member).digest("hex"));
  await call("upgrade", "gameshelf_session=" + member, translationRoute, "POST", translation, 403);
  await api(translationRoute, "POST", { text: " ", target: "zh-CN" }, 400);
  await api(translationRoute, "POST", { text: "QA blocked", target: "zh-CN" }, 422);
  assert.ok(Number((await call("upgrade", cookie, translationRoute, "POST", { text: "QA quota", target: "zh-CN" }, 429)).retry) > 0);
  await newApi(api, comparisonIds);
  assert.deepEqual(stable(await api("backup")), {...oldBackup,schema_version:4,steamLinks:[]});
  await translationUI(url, cookie, game, api);
  await comparisonBrowser(url, cookie, api, comparisonIds);
  await healthy("upgrade");
  await checkSteamImport(api);
  const saved = stable(await api("backup"));
  log("NEW_FEATURES PASS steam=13 comparison=1-single,1-multiple,11-none read-only filters=local UI=desktop,390px edit=invalidate gemini=preserved steam-import=atomic-idempotent");
  docker("stop", name("upgrade")); docker("rm", name("upgrade"));
  await start("recreate", upgrade, image, version, disabledSettings);
  const recreate = apiFor("recreate", cookie);
  assert.equal((await recreate("auth/status")).user.username, username);
  assert.deepEqual(stable(await recreate("backup")), saved);
  const flags = await recreate("catalog");
  assert.deepEqual(flags.steamPreview, { configured: false });
  assert.deepEqual(flags.descriptionTranslation, { configured: false });
  await recreate("steam/preview", "POST", steam, 503);
  await recreate(translationRoute, "POST", translation, 503);
  assert.deepEqual(await metadata(recreate), reference);
  log("RECREATE PASS session=preserved translated-description=persisted optional-keys=independent");

  await rollback(rollbackVolume);
  const restored = apiFor("rollback", cookie);
  assert.equal((await restored("auth/status")).user.username, username);
  assert.deepEqual(stable(await restored("backup")), oldBackup);
  // The rollback container intentionally has no optional provider credentials.
  await restored("steam/preview", "POST", steam, 503);
  await restored(translationRoute, "POST", translation, 503);
  assert.deepEqual(snapshot(baseline), hashes);
  json("snapshot-hashes.json", { baseline: hashes, untouched: true });
  log("ROLLBACK PASS image=0.1.11 snapshot=isolated data=v3-identical session=preserved optional-services=503");
  log("RELEASE PASS HTTP=" + checks + " platform=linux/amd64 health=healthy");
}
async function publishedSmoke() {
  assert.match(image, /^jyh9521\/gameshelf@sha256:[a-f0-9]{64}$/);
  await start("published", volume("published"), image, version);
  const api = apiFor("published", await setup("published"));
  await metadata(api);
  const comparisonIds = await seedComparison(api);
  const before = stable(await api("backup"));
  await newApi(api, comparisonIds);
  assert.deepEqual(stable(await api("backup")), before);
  await checkSteamImport(api);
  await healthy("published");
  log("PUBLISHED PASS HTTP=" + checks + " image=" + image + " providers=5 steam=verified-import-idempotent gemini=preview health=healthy");
}
try {
  const info = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(info.Os + "/" + info.Architecture, "linux/amd64");
  assert.equal(info.Config.Labels["org.opencontainers.image.version"], version);
  if (process.env.SOURCE_REVISION) assert.equal(info.Config.Labels["org.opencontainers.image.revision"], process.env.SOURCE_REVISION);
  json("image-identity.json", { id: info.Id, os: info.Os, arch: info.Architecture, labels: info.Config.Labels });
  if (published) await publishedSmoke(); else await release();
} finally {
  await browser?.close();
  for (const c of containers) {
    const owned = docker("ps", "-a", "--filter", "label=" + runLabel, "--format", "{{.Names}}").split(/\r?\n/);
    if (!owned.includes(c)) continue;
    writeFileSync(file(c + ".log"), redact(docker("logs", c)) + "\n");
    docker("rm", "-f", c);
  }
  for (const v of volumes) {
    assert.equal(docker("volume", "inspect", "--format", '{{index .Labels "gameshelf.run"}}', v), id);
    docker("volume", "rm", v);
  }
  assert.equal(docker("ps", "-a", "--filter", "label=" + runLabel, "--format", "{{.Names}}"), "");
  assert.equal(docker("volume", "ls", "--filter", "label=" + runLabel, "--format", "{{.Name}}"), "");
  log("QA_CLEANUP PASS containers=0 volumes=0");
  writeFileSync(file("results.txt"), logLines.join("\n") + "\n");
}

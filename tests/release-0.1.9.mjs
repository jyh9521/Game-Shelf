// Run the published 0.1.8 image, upgrade only a copy of its QA volume, and
// independently boot the old snapshot. The SteamGridDB transport is a fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { env, coverGallery } from "./metadata-fixtures.cjs";

const old = "jyh9521/gameshelf@sha256:f01b97270fba2d239b18f5fb2418db09c88942aeef35d3d5c28cafcf25e83022";
const image = process.env.TEST_IMAGE ?? "jyh9521/gameshelf:0.1.9";
const published = process.argv.includes("--published");
const label = "release-0.1.9", id = "gs-release-019-" + Date.now() + "-" + randomBytes(3).toString("hex");
const runLabel = "gameshelf.run=" + id, qaLabel = "gameshelf.qa=" + label;
const dir = resolve(process.env.RELEASE_QA_DIR ?? "engineering/release-0.1.9", published ? "published" : "container");
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name), name = phase => id + "-" + phase;
const logLines = [], volumes = new Set(), containers = new Set(), urls = new Map();
const log = text => { logLines.push(text); console.log(text); };
const json = (name, data) => writeFileSync(file(name), JSON.stringify(data, null, 2) + "\n");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 }).trim();
const password = randomBytes(24).toString("hex"), username = "release-019-qa";
const oldCover = "https://cdn.steamgriddb.com/grid/qa-cover.png", key = env.STEAMGRIDDB_API_KEY;
const provider = "steamgriddb", last = coverGallery.grids.at(-1);
const owned = { platformId: "PC", storeId: "STEAM", releaseDate: "1998-11-21", edition: "QA Cartridge", region: "JP", manualTotalOverride: 7200 };
const fixtureFile = fileURLToPath(new URL("./metadata-fixtures.cjs", import.meta.url));
const settings = file("provider.qa.env");
writeFileSync(settings, "STEAMGRIDDB_API_KEY=" + key + "\n");
let checks = 0, browser;

function volume(phase) {
  const v = name(phase);
  docker("volume", "create", "--label", qaLabel, "--label", runLabel, v);
  volumes.add(v); return v;
}
const readMount = (v, target) => "type=volume,source=" + v + ",target=" + target + ",readonly";
const writeMount = (v, target) => "type=volume,source=" + v + ",target=" + target;
function copy(source, target) {
  assert.ok(volumes.has(source) && volumes.has(target) && source !== target);
  docker("run", "--rm", "--pull", "never", "--label", runLabel, "--entrypoint", "sh",
    "--mount", readMount(source, "/from"), "--mount", writeMount(target, "/to"), old, "-c", "test -f /from/gameshelf.db && cp -a /from/. /to/");
}
function snapshot(v) {
  assert.ok(volumes.has(v));
  const code = "const f=require('fs'),c=require('crypto'); console.log(JSON.stringify(Object.fromEntries(['gameshelf.db','setup-token'].map(n=>[n,c.createHash('sha256').update(f.readFileSync('/data/'+n)).digest('hex')]))))";
  return JSON.parse(docker("run", "--rm", "--pull", "never", "--label", runLabel, "--entrypoint", "node", "--mount", readMount(v, "/data"), old, "-e", code));
}
const runtimeVersion = phase => docker("exec", name(phase), "node", "-p", "require('./package.json').version");
async function ready(phase) {
  const port = docker("port", name(phase), "3000/tcp").split(":").at(-1);
  assert.match(port, /^\d+$/);
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(750) })).ok) {
        assert.equal(docker("exec", name(phase), "node", "-p",
          "const s=require('fs').readFileSync('/proc/1/status','utf8');s.match(/Uid:\\s+(\\d+)/)[1]+':'+s.match(/Gid:\\s+(\\d+)/)[1]"), "99:100");
        urls.set(phase, url); return url;
      }
    } catch (e) { if (e instanceof assert.AssertionError) throw e; }
    if (docker("inspect", "--format", "{{.State.Running}}", name(phase)) !== "true") break;
    await new Promise(r => setTimeout(r, 300));
  }
  throw Error(phase + " startup failed: " + docker("logs", name(phase)).replaceAll(key, "[QA_KEY]"));
}
async function start(phase, v, tag, fixture = true) {
  assert.ok(volumes.has(v));
  const args = ["run", "-d", "--pull", "never", "--name", name(phase), "--label", qaLabel, "--label", runLabel,
    "-p", "127.0.0.1::3000", "--health-interval", "2s", "--health-start-period", "8s", "-e", "PUID=99", "-e", "PGID=100",
    "-e", "PRISMA_HIDE_UPDATE_MESSAGE=1", "--env-file", settings, "--mount", writeMount(v, "/data")];
  if (fixture) args.push("--mount", "type=bind,source=" + fixtureFile + ",target=/qa/providers.cjs,readonly",
    "-e", "NODE_OPTIONS=--require=/qa/providers.cjs", "-e", "GAMESHELF_QA_PROVIDER_LOG=/data/qa-upstream.log");
  containers.add(name(phase));
  docker(...args, tag);
  return ready(phase);
}
async function healthy(phase) {
  for (let i = 0; i < 30; i++) {
    if (docker("inspect", "--format", "{{.State.Health.Status}}", name(phase)) === "healthy") return;
    await new Promise(r => setTimeout(r, 750));
  }
  throw Error(phase + " healthcheck failed");
}
async function call(phase, cookie, path, method = "GET", input, status = 200) {
  const response = await fetch(urls.get(phase) + "/api/" + path, {
    method, signal: AbortSignal.timeout(10000),
    headers: { cookie, "content-type": "application/json", "x-gameshelf-request": "1" },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  const raw = (await response.text()).replaceAll(key, "[QA_KEY]");
  assert.ok(!raw.includes("[QA_KEY]"), "credential leaked in HTTP body");
  assert.equal(response.status, status, method + " " + phase + "/" + path + " " + raw);
  checks++;
  return { data: JSON.parse(raw), cookie: response.headers.get("Set-Cookie")?.split(";")[0] };
}
const apiFor = (phase, cookie) => async (...args) => (await call(phase, cookie, ...args)).data;
async function setup(phase) {
  const setupToken = docker("exec", name(phase), "cat", "/data/setup-token");
  return (await call(phase, "", "auth/setup", "POST", { username, password, passwordConfirm: password, setupToken }, 201)).cookie;
}
const stable = b => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "exportedAt").map(([k, v]) =>
  [k, Array.isArray(v) ? v.toSorted((a, b) => a.id.localeCompare(b.id)) : v]));
const coverPage = (api, page) => api("metadata/preview", "POST", { provider, id: coverGallery.id, page });
async function searchGallery(api) {
  const { items } = await api("metadata/search", "POST", { provider, query: coverGallery.title });
  assert.equal(items[0].id, coverGallery.id);
}
function assertPage(result, page) {
  const wanted = coverGallery.grids.slice(page * 12, (page + 1) * 12).filter(g => !g.humor);
  assert.deepEqual(result.pagination, { page, pageSize: 12, totalPages: 6, hasNext: page < 5 });
  assert.deepEqual(result.items.map(p => [p.candidate.externalId, p.candidate.fields.coverUrl, p.image.thumbnail]),
    wanted.map(g => [String(g.id), g.url, g.thumb]));
  return result.items;
}
function imageIdentity() {
  const info = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(info.Os + "/" + info.Architecture, "linux/amd64");
  assert.equal(info.Config.Labels["org.opencontainers.image.version"], "0.1.9");
  if (process.env.SOURCE_REVISION) assert.equal(info.Config.Labels["org.opencontainers.image.revision"], process.env.SOURCE_REVISION);
  json("image-identity.json", { id: info.Id, os: info.Os, arch: info.Architecture, labels: info.Config.Labels });
}

async function coverUi(url, cookie, game, api) {
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 920 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", r => {
    const origin = new URL(r.request().url()).origin;
    if (origin === url) return r.continue();
    if (["https://cdn.steamgriddb.com", "https://cdn2.steamgriddb.com"].includes(origin))
      return r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 930"><rect width="660" height="930" fill="#405846"/><text x="330" y="510" text-anchor="middle" fill="white" font-size="75">QA</text></svg>' });
    return r.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url }]);
  await page.goto(url);
  await expect(page.getByText("LOCAL-FIRST / v0.1.9", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: game.title, exact: true }).click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
  const lookup = editor.locator("details.metadata-panel"), summary = lookup.locator("summary");
  await summary.click();
  await expect(editor.getByLabel("资料源")).toHaveValue(provider);
  await editor.getByRole("button", { name: "搜索外部资料" }).click();
  await editor.locator(".metadata-hits").getByRole("button", { name: /ID 26001/ }).click();
  const gallery = editor.getByRole("region", { name: "SteamGridDB 封面候选", exact: true });
  const pager = gallery.getByRole("navigation", { name: "封面分页（顶部）" });
  const next = pager.getByRole("button", { name: "下一页" });
  const prev = pager.getByRole("button", { name: "上一页" });
  await expect(prev).toBeDisabled();
  for (let i = 1; i <= 6; i++) {
    await expect(pager).toContainText(`第 ${i} / 6 页`);
    if (i === 3) await expect(gallery).toContainText("本页暂无可导入的竖版封面");
    if (i < 6) await next.click();
  }
  await expect(next).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
  const choose = gallery.getByRole("button", { name: "选择封面 64", exact: true });
  const cover = editor.locator('input[name="coverUrl"]');
  await choose.scrollIntoViewIfNeeded();
  await page.screenshot({ path: file("cover-page-6.png") });
  page.once("dialog", d => d.dismiss());
  await choose.click();
  await expect(cover).toHaveValue(oldCover);
  await expect(gallery).toBeVisible();
  page.once("dialog", d => d.accept());
  await choose.click();
  await expect(cover).toHaveValue(last.url);
  await expect(gallery).toBeHidden();
  await expect(summary).toBeFocused();
  await expect(editor.getByText("已选封面，保存游戏后生效。", { exact: true })).toBeVisible();
  await page.screenshot({ path: file("cover-collapsed.png") });
  assert.equal((await api("games/" + game.id)).coverUrl, oldCover);
  await summary.click();
  await expect(pager).toContainText("第 6 / 6 页");
  await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = (await api("games/" + game.id + "/fields")).fields.find(f => f.field === "coverUrl");
  assert.equal(saved.value, last.url); assert.equal(saved.source.externalId, String(last.id)); assert.equal(saved.locked, true);
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
}

async function release() {
  const baseline = volume("baseline"), upgrade = volume("upgrade"), rollback = volume("rollback");
  await start("baseline", baseline, old);
  assert.equal(runtimeVersion("baseline"), "0.1.8");
  const cookie = await setup("baseline"), before = apiFor("baseline", cookie);
  const game = await before("games", "POST", { title: coverGallery.title, coverUrl: oldCover, rating: 5, memo: "QA 旧库备注", ownership: owned }, 201);
  const related = await before("games", "POST", { title: "QA 关联作品", ownership: owned }, 201);
  await before("games/" + related.id + "/relations", "POST", { targetGameId: game.id, type: "REMASTER_OF", note: "QA 旧关系" }, 201);
  const oldBackup = await before("backup");
  assert.equal(oldBackup.schema_version, 3); assert.equal(oldBackup.games.length, 2); assert.equal(oldBackup.relations.length, 1);
  json("baseline-backup-v3.json", oldBackup);
  await searchGallery(before);
  const first = await coverPage(before);
  assert.equal(first.items.length, 12); assert.equal(first.pagination, undefined);
  await before("metadata/preview", "POST", { provider, id: coverGallery.id, page: 1 }, 400);
  log("BASELINE PASS image=0.1.8 games=2 backup=v3 covers=12 page=400");
  docker("stop", name("baseline"));
  const hashes = snapshot(baseline);
  copy(baseline, upgrade); copy(baseline, rollback);
  assert.deepEqual(snapshot(upgrade), hashes); assert.deepEqual(snapshot(rollback), hashes);
  const url = await start("upgrade", upgrade, image), api = apiFor("upgrade", cookie);
  assert.equal(runtimeVersion("upgrade"), "0.1.9");
  assert.equal((await api("auth/status")).user.username, username);
  assert.deepEqual(stable(await api("backup")), stable(oldBackup));
  assert.equal(snapshot(upgrade)["setup-token"], hashes["setup-token"]);
  assert.match(docker("logs", name("upgrade")), /No pending migrations to apply/);
  assert.deepEqual((await api("metadata/providers")).providers.filter(p => p.enabled).map(p => p.id), [provider]);
  log("UPGRADE PASS image=0.1.9 data=v3-identical session=preserved setup-token=unchanged new-migrations=0");
  await searchGallery(api);
  const covers = [];
  for (let i = 0; i < 6; i++) covers.push(...assertPage(await coverPage(api, i), i));
  assert.equal(new Set(covers.map(p => p.candidate.externalId)).size, 51);
  await coverUi(url, cookie, game, api);
  const saved = await api("backup");
  assert.equal(saved.schema_version, 3);
  await api("backup/preview", "POST", saved);
  json("modified-backup-v3.json", saved);
  await healthy("upgrade");
  log("COVER_PAGE PASS pages=6 eligible-covers=51 empty-page=continued cancel=stayed-open selected=collapsed reopened=same-page saved-grid=260163 UI=desktop,390px");
  docker("stop", name("upgrade"));
  docker("rm", name("upgrade"));
  await start("recreate", upgrade, image, false);
  const recreated = apiFor("recreate", cookie);
  assert.equal((await recreated("auth/status")).user.username, username);
  assert.deepEqual(stable(await recreated("backup")), stable(saved));
  log("RECREATE PASS cover=persisted session=preserved");

  const script = resolve(dir, "..", "ROLLBACK.sh");
  writeFileSync(script, [
    "#!/usr/bin/env bash", "set -euo pipefail", "export MSYS_NO_PATHCONV=1",
    'NAME="${1:?QA container}"; VOLUME="${2:?QA snapshot}"',
    'case "$NAME" in gs-release-019-*-rollback) ;; *) exit 2;; esac',
    '[[ "$VOLUME" == "$NAME" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.qa"}}\' "$VOLUME")" == "release-0.1.9" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.run"}}\' "$VOLUME")" == "${NAME%-rollback}" ]]',
    'docker run -d --pull never --name "$NAME" --label gameshelf.qa=release-0.1.9 --label "gameshelf.run=${NAME%-rollback}" -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ' + old + ' >/dev/null',
    'echo "ROLLBACK_STARTED image=0.1.8 snapshot=isolated"', ""
  ].join("\n")); chmodSync(script, 0o755);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const sh = script.replaceAll("\\", "/");
  execFileSync(bash, ["-c", 'chmod +x "$1" && test -x "$1" && bash -n "$1"', "--", sh], { windowsHide: true });
  containers.add(name("rollback"));
  const command = [bash, sh, name("rollback"), rollback];
  const output = execFileSync(bash, command.slice(1), { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(output, "ROLLBACK_STARTED image=0.1.8 snapshot=isolated");
  json("rollback-command.json", { command, input: { snapshot: rollback, source: "independent pre-upgrade 0.1.8 volume" }, output, exit: 0 });
  await ready("rollback");
  assert.equal(runtimeVersion("rollback"), "0.1.8");
  const restored = apiFor("rollback", cookie);
  assert.equal((await restored("auth/status")).user.username, username);
  assert.deepEqual(stable(await restored("backup")), stable(oldBackup));
  await restored("metadata/preview", "POST", { provider, id: coverGallery.id, page: 1 }, 400);
  assert.deepEqual(snapshot(baseline), hashes);
  json("snapshot-hashes.json", { baseline: hashes, untouched: true });
  log("ROLLBACK PASS image=0.1.8 snapshot=isolated data=v3-identical session=preserved page=400");
  log("RELEASE PASS HTTP=" + checks + " platform=linux/amd64 health=healthy");
}

async function publishedSmoke() {
  assert.match(image, /^jyh9521\/gameshelf@sha256:[a-f0-9]{64}$/);
  await start("published", volume("published"), image);
  assert.equal(runtimeVersion("published"), "0.1.9");
  const api = apiFor("published", await setup("published"));
  assert.deepEqual((await api("metadata/providers")).providers.filter(p => p.enabled).map(p => p.id), [provider]);
  await searchGallery(api);
  assertPage(await coverPage(api, 0), 0);
  assertPage(await coverPage(api, 2), 2);
  const selected = assertPage(await coverPage(api, 5), 5).at(-1);
  const game = await api("games", "POST", { title: coverGallery.title, coverUrl: last.url, ownership: owned,
    candidates: [{ token: selected.token, fields: ["coverUrl"] }] }, 201);
  const saved = (await api("games/" + game.id + "/fields")).fields.find(f => f.field === "coverUrl");
  assert.equal(saved.value, last.url); assert.equal(saved.source.externalId, String(last.id));
  await healthy("published");
  log("PUBLISHED PASS HTTP=" + checks + " image=" + image + " last-page-cover=saved health=healthy");
}

try {
  imageIdentity();
  if (published) await publishedSmoke(); else await release();
} finally {
  await browser?.close();
  for (const c of containers) {
    const ownedContainers = docker("ps", "-a", "--filter", "label=" + runLabel, "--format", "{{.Names}}").split(/\r?\n/);
    if (!ownedContainers.includes(c)) continue;
    writeFileSync(file(c + ".log"), docker("logs", c).replaceAll(key, "[QA_KEY]") + "\n");
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

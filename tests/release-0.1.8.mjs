// Run the published 0.1.7 image, upgrade only a copy of its QA volume, and
// independently boot the old snapshot. The SteamGridDB transport is a fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { env, zelda } from "./metadata-fixtures.cjs";

const old = "jyh9521/gameshelf@sha256:4c34d42cb052d0322a940086e45ad8552991ac409dc7ac833b115644076423d5";
const image = process.env.TEST_IMAGE ?? "jyh9521/gameshelf:0.1.8";
const published = process.argv.includes("--published");
const label = "release-0.1.8", id = "gs-release-018-" + Date.now() + "-" + randomBytes(3).toString("hex");
const runLabel = "gameshelf.run=" + id, qaLabel = "gameshelf.qa=" + label;
const dir = resolve(process.env.RELEASE_QA_DIR ?? "engineering/release-0.1.8", published ? "published" : "container");
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name), name = phase => id + "-" + phase;
const logLines = [], volumes = new Set(), containers = new Set(), urls = new Map();
const log = text => { logLines.push(text); console.log(text); };
const json = (name, data) => writeFileSync(file(name), JSON.stringify(data, null, 2) + "\n");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 }).trim();
const password = randomBytes(24).toString("hex"), username = "release-018-qa";
const oldCover = "https://cdn.steamgriddb.com/grid/qa-cover.png", key = env.STEAMGRIDDB_API_KEY;
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
async function candidates(api) {
  const hit = (await api("metadata/search", "POST", { provider: "steamgriddb", query: zelda.title })).items[0];
  assert.equal(hit.id, zelda.id);
  return (await api("metadata/preview", "POST", { provider: "steamgriddb", id: hit.id })).items;
}
function imageIdentity() {
  const info = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(info.Os + "/" + info.Architecture, "linux/amd64");
  assert.equal(info.Config.Labels["org.opencontainers.image.version"], "0.1.8");
  if (process.env.SOURCE_REVISION) assert.equal(info.Config.Labels["org.opencontainers.image.revision"], process.env.SOURCE_REVISION);
  json("image-identity.json", { id: info.Id, os: info.Os, arch: info.Architecture, labels: info.Config.Labels });
}

async function release() {
  const baseline = volume("baseline"), upgrade = volume("upgrade"), rollback = volume("rollback");
  await start("baseline", baseline, old);
  assert.equal(runtimeVersion("baseline"), "0.1.7");
  const cookie = await setup("baseline"), before = apiFor("baseline", cookie);
  const platform = await before("platforms", "POST", { name: "QA Nintendo 64" }, 201);
  assert.match(platform.id, /^[0-9a-f-]{36}$/);
  const game = await before("games", "POST", { title: "QA 塞尔达传说：时之笛", coverUrl: oldCover, rating: 5, memo: "QA 旧库备注",
    ownership: { ...owned, platformId: platform.id } }, 201);
  const related = await before("games", "POST", { title: "QA 关联作品", ownership: owned }, 201);
  const gamePath = "games/" + game.id;
  await before("games/" + related.id + "/relations", "POST", { targetGameId: game.id, type: "REMASTER_OF", note: "QA 旧关系" }, 201);
  const prior = await before(gamePath);
  assert.deepEqual(await candidates(before), []);
  await before("platforms/" + platform.id, "PUT", { name: platform.name, code: "N64" }, 404);
  await before("platforms/" + platform.id, "DELETE", undefined, 404);
  const oldBackup = await before("backup");
  assert.equal(oldBackup.schema_version, 3); assert.equal(oldBackup.games.length, 2); assert.equal(oldBackup.relations.length, 1);
  json("baseline-backup-v3.json", oldBackup);
  log("BASELINE PASS image=0.1.7 games=2 backup=v3 cover-21202=0 platform-edit=404 platform-delete=404");
  docker("stop", name("baseline"));
  const hashes = snapshot(baseline);
  copy(baseline, upgrade); copy(baseline, rollback);
  assert.deepEqual(snapshot(upgrade), hashes); assert.deepEqual(snapshot(rollback), hashes);
  const url = await start("upgrade", upgrade, image), api = apiFor("upgrade", cookie);
  assert.equal(runtimeVersion("upgrade"), "0.1.8");
  assert.equal((await api("auth/status")).user.username, username);
  assert.deepEqual(stable(await api("backup")), stable(oldBackup));
  assert.equal(snapshot(upgrade)["setup-token"], hashes["setup-token"]);
  assert.match(docker("logs", name("upgrade")), /No pending migrations to apply/);
  assert.deepEqual((await api("metadata/providers")).providers.filter(p => p.enabled).map(p => p.id), ["steamgriddb"]);
  log("UPGRADE PASS image=0.1.8 data=v3-identical session=preserved setup-token=unchanged new-migrations=0");

  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 920 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", r => {
    const origin = new URL(r.request().url()).origin;
    if (origin === url) return r.continue();
    if (["https://cdn.steamgriddb.com", "https://cdn2.steamgriddb.com"].includes(origin))
      return r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900"><rect width="600" height="900" fill="#405846"/><circle cx="300" cy="350" r="160" fill="#afc988"/><text x="300" y="680" text-anchor="middle" fill="white" font-size="65">QA</text></svg>' });
    return r.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url }]);
  await page.goto(url);
  await expect(page.getByText("LOCAL-FIRST / v0.1.8", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: game.title, exact: true }).click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
  await editor.getByText("查找外部资料或封面", { exact: true }).click();
  await expect(editor.getByLabel("资料源")).toHaveValue("steamgriddb");
  await editor.getByLabel("外部搜索标题").fill(zelda.title);
  await editor.getByRole("button", { name: "搜索外部资料" }).click();
  await editor.locator(".metadata-hits").getByRole("button", { name: /ID 21202/ }).click();
  const gallery = editor.getByRole("region", { name: "SteamGridDB 封面候选", exact: true });
  await expect(gallery.getByRole("img")).toHaveAttribute("src", zelda.thumb);
  await page.screenshot({ path: file("cover-desktop.png") });
  page.once("dialog", d => d.accept());
  await gallery.getByRole("button", { name: "选择封面 1", exact: true }).click();
  await expect(editor.locator('input[name="coverUrl"]')).toHaveValue(zelda.cover);
  await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const savedCover = (await api(gamePath + "/fields")).fields.find(x => x.field === "coverUrl");
  assert.equal(savedCover.value, zelda.cover); assert.equal(savedCover.source.externalId, zelda.grid); assert.equal(savedCover.locked, true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /平台管理/ }).click();
  await page.getByRole("button", { name: "编辑平台：" + platform.name, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑平台", exact: true });
  await expect(edit.getByLabel("平台代号", { exact: true })).toHaveValue(platform.id);
  await edit.getByLabel("平台代号", { exact: true }).fill("N64");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: file("platform-mobile.png") });
  await edit.getByRole("button", { name: "保存平台", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByText("N64", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  const upgraded = await api(gamePath);
  assert.equal(upgraded.releases[0].platform.id, "N64");
  assert.equal(upgraded.releases[0].id, prior.releases[0].id);
  assert.deepEqual(upgraded.releases[0].contents, prior.releases[0].contents);
  await api("platforms/N64", "DELETE", undefined, 409);
  const unused = await api("platforms", "POST", { name: "QA Unused", code: "UNUSED-018" }, 201);
  await api("platforms/" + unused.id, "DELETE");
  assert.ok(!(await api("catalog")).platforms.some(p => p.id === unused.id));
  const saved = await api("backup");
  assert.equal(saved.schema_version, 3);
  await api("backup/preview", "POST", saved);
  json("modified-backup-v3.json", saved);
  await healthy("upgrade");
  log("COVER_PLATFORM PASS cover-21202=selected-and-saved UUID-to-N64=preserved in-use-delete=409 unused-delete=pass UI=desktop,390px");
  docker("stop", name("upgrade"));
  docker("rm", name("upgrade"));
  await start("recreate", upgrade, image, false);
  const recreated = apiFor("recreate", cookie);
  assert.equal((await recreated("auth/status")).user.username, username);
  assert.deepEqual(stable(await recreated("backup")), stable(saved));
  log("RECREATE PASS cover-and-platform=persisted session=preserved");

  const script = resolve(dir, "..", "ROLLBACK.sh");
  writeFileSync(script, [
    "#!/usr/bin/env bash", "set -euo pipefail", "export MSYS_NO_PATHCONV=1",
    'NAME="${1:?QA container}"; VOLUME="${2:?QA snapshot}"',
    'case "$NAME" in gs-release-018-*-rollback) ;; *) exit 2;; esac',
    '[[ "$VOLUME" == "$NAME" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.qa"}}\' "$VOLUME")" == "release-0.1.8" ]]',
    '[[ "$(docker volume inspect --format \'{{index .Labels "gameshelf.run"}}\' "$VOLUME")" == "${NAME%-rollback}" ]]',
    'docker run -d --pull never --name "$NAME" --label gameshelf.qa=release-0.1.8 --label "gameshelf.run=${NAME%-rollback}" -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ' + old + ' >/dev/null',
    'echo "ROLLBACK_STARTED image=0.1.7 snapshot=isolated"', ""
  ].join("\n")); chmodSync(script, 0o755);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const sh = script.replaceAll("\\", "/");
  execFileSync(bash, ["-c", 'chmod +x "$1" && test -x "$1" && bash -n "$1"', "--", sh], { windowsHide: true });
  containers.add(name("rollback"));
  const command = [bash, sh, name("rollback"), rollback];
  const output = execFileSync(bash, command.slice(1), { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(output, "ROLLBACK_STARTED image=0.1.7 snapshot=isolated");
  json("rollback-command.json", { command, input: { snapshot: rollback, source: "independent pre-upgrade 0.1.7 volume" }, output, exit: 0 });
  await ready("rollback");
  assert.equal(runtimeVersion("rollback"), "0.1.7");
  const restored = apiFor("rollback", cookie);
  assert.equal((await restored("auth/status")).user.username, username);
  assert.deepEqual(stable(await restored("backup")), stable(oldBackup));
  await restored("platforms/" + platform.id, "PUT", { name: platform.name, code: "N64" }, 404);
  assert.deepEqual(snapshot(baseline), hashes);
  json("snapshot-hashes.json", { baseline: hashes, untouched: true });
  log("ROLLBACK PASS image=0.1.7 snapshot=isolated data=v3-identical session=preserved platform-edit=404");
  log("RELEASE PASS HTTP=" + checks + " platform=linux/amd64 health=healthy");
}

async function publishedSmoke() {
  assert.match(image, /^jyh9521\/gameshelf@sha256:[a-f0-9]{64}$/);
  await start("published", volume("published"), image);
  assert.equal(runtimeVersion("published"), "0.1.8");
  const api = apiFor("published", await setup("published"));
  const p = await api("platforms", "POST", { name: "QA published N64", code: "N64" }, 201);
  const updated = await api("platforms/N64", "PUT", { name: "QA published N64", code: "N64-JP" });
  assert.equal(updated.id, "N64-JP");
  const [cover] = await candidates(api);
  assert.equal(cover.candidate.externalId, zelda.grid); assert.equal(cover.candidate.fields.coverUrl, zelda.cover);
  const game = await api("games", "POST", { title: zelda.title, coverUrl: zelda.cover, ownership: { ...owned, platformId: updated.id },
    candidates: [{ token: cover.token, fields: ["coverUrl"] }] }, 201);
  assert.equal((await api("games/" + game.id)).coverUrl, zelda.cover);
  await api("platforms/N64-JP", "DELETE", undefined, 409);
  assert.equal((await api("backup")).schema_version, 3);
  await healthy("published");
  log("PUBLISHED PASS HTTP=" + checks + " image=" + image + " CDN2=pass platform-code=pass health=healthy");
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

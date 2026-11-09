// Browser regression on a production build. The upstream data, images,
// account and database are generated fixtures; no real library is opened.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { coverGallery, env as fixtureEnv } from "./metadata-fixtures.cjs";

const dir = resolve(process.env.COVER_PAGINATION_QA_DIR ?? "engineering/cover-pagination-" + Date.now());
mkdirSync(dir, { recursive: true });
const file = name => resolve(dir, name);
const token = randomBytes(24).toString("hex"), password = randomBytes(24).toString("hex");
writeFileSync(file("qa.db"), "");
writeFileSync(file("setup-token"), token);
const env = { ...process.env, ...fixtureEnv, DATABASE_URL: "file:" + file("qa.db").replaceAll("\\", "/"),
  SETUP_TOKEN: token, SETUP_TOKEN_FILE: file("setup-token"), APP_URL: "", SECURE_COOKIE: "false",
  NEXT_TELEMETRY_DISABLED: "1", GAMESHELF_QA_PROVIDER_LOG: file("provider-requests.log") };
writeFileSync(file("migration.log"), execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
  { env, encoding: "utf8", windowsHide: true }));
const reservation = createServer();
await new Promise(r => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const base = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("./metadata-fixtures.cjs", import.meta.url)),
  resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
  { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const exited = new Promise(r => child.once("exit", r));
let log = "", cookie = "", browser;
child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
async function api(path, method = "GET", input, status = 200) {
  const r = await fetch(base + "/api/" + path, {
    method, signal: AbortSignal.timeout(10000),
    headers: { cookie, "content-type": "application/json", "x-gameshelf-request": "1" },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  const b = await r.json();
  assert.equal(r.status, status, method + " " + path);
  if (r.headers.has("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
  return b;
}
const originalCover = "https://cdn.steamgriddb.com/grid/qa-original.png";

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(600) })).ok) break; } catch {}
    if (child.exitCode !== null || i === 79) throw new Error("QA server did not become healthy");
    await new Promise(r => setTimeout(r, 150));
  }
  await api("auth/setup", "POST", { username: "cover-pagination-qa", password, passwordConfirm: password, setupToken: token }, 201);
  const game = await api("games", "POST", { title: coverGallery.title, coverUrl: originalCover,
    ownership: { platformId: "PC", releaseDate: "2026", edition: "QA Standard", region: "JP" } }, 201);
  const path = "games/" + game.id;
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "msedge" : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 930 } });
  const errors = [], outside = [], requests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/api/metadata/preview") requests.push(req.postDataJSON());
  });
  await page.route("**/*", r => {
    const url = new URL(r.request().url());
    if (url.origin === base) return r.continue();
    if (["https://cdn.steamgriddb.com", "https://cdn2.steamgriddb.com"].includes(url.origin)) {
      const index = Number(/gallery-(\d+)/.exec(url.pathname)?.[1]) || 0;
      return r.fulfill({ contentType: "image/svg+xml", body:
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 930"><rect width="660" height="930" fill="hsl(${index * 29 % 360} 22% 29%)"/><text x="330" y="490" text-anchor="middle" fill="white" font-family="sans-serif" font-size="72">QA ${index}</text></svg>` });
    }
    outside.push(url.origin); return r.abort();
  });
  await page.context().addCookies([{ name: "gameshelf_session", value: cookie.split("=")[1], url: base }]);
  await page.goto(base);
  await page.getByRole("heading", { name: coverGallery.title, exact: true }).click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
  const lookup = editor.locator("details.metadata-panel");
  const summary = lookup.locator("summary");
  await summary.click();
  await editor.getByLabel("资料源").selectOption("steamgriddb");
  await editor.getByRole("button", { name: "搜索外部资料" }).click();
  await editor.getByRole("button", { name: /ID 26001/ }).click();
  const gallery = editor.getByRole("region", { name: "SteamGridDB 封面候选", exact: true });
  const pictures = gallery.locator(".metadata-covers img");
  await expect(pictures).toHaveCount(12);
  const canPage = await gallery.getByRole("button", { name: "下一页", exact: true }).count() > 0;
  const coverInput = editor.locator('input[name="coverUrl"]');
  const chooseFirst = gallery.getByRole("button", { name: "选择封面 1", exact: true });
  page.once("dialog", d => d.dismiss());
  await chooseFirst.click();
  await expect(coverInput).toHaveValue(originalCover);
  await expect(gallery).toBeVisible();
  page.once("dialog", d => d.accept());
  await chooseFirst.click();
  await expect(coverInput).toHaveValue(coverGallery.grids[0].url);
  const collapsed = await lookup.evaluate(el => !el.open);
  if (!canPage || !collapsed) {
    console.log(`REGRESSION FAIL first-page=12 next=${canPage} collapsed-after-selection=${collapsed}`);
    process.exitCode = 1;
  } else {
    await expect(summary).toBeFocused();
    await expect(editor.getByRole("status").filter({ hasText: "已选封面，保存游戏后生效。" })).toBeVisible();
    assert.equal((await api(path)).coverUrl, originalCover);
    await editor.getByRole("button", { name: "移除暂存：封面" }).click();
    await expect(coverInput).toHaveValue(originalCover);
    await expect(editor.getByText("已选封面，保存游戏后生效。", { exact: true })).toHaveCount(0);
    await summary.click();
    const top = gallery.getByRole("navigation", { name: "封面分页（顶部）" });
    const bottom = gallery.getByRole("navigation", { name: "封面分页（底部）" });
    const prev = top.getByRole("button", { name: "上一页" });
    const next = top.getByRole("button", { name: "下一页" });
    const visited = [];
    for (let i = 0; i < 6; i++) {
      await expect(top).toContainText(`第 ${i + 1} / 6 页`);
      const images = coverGallery.grids.slice(i * 12, (i + 1) * 12).filter(g => !g.humor).map(g => g.thumb);
      await expect(pictures).toHaveCount(images.length);
      const seen = await pictures.evaluateAll(imgs => imgs.map(img => img.getAttribute("src")));
      assert.deepEqual(seen, images);
      visited.push(...seen);
      if (i === 0) {
        await expect(prev).toBeDisabled();
        await gallery.scrollIntoViewIfNeeded();
        await page.screenshot({ path: file("desktop-pagination.png") });
      }
      if (i === 2) await expect(gallery).toContainText("本页暂无可导入的竖版封面");
      if (i === 5) await expect(next).toBeDisabled();
      else await (i === 0 ? bottom.getByRole("button", { name: "下一页" }) : next).click();
    }
    assert.equal(new Set(visited).size, 51);
    await prev.click();
    await expect(top).toContainText("第 5 / 6 页");
    await next.click();
    await expect(top).toContainText("第 6 / 6 页");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
      [...document.querySelectorAll(".modal")].every(e => e.scrollWidth <= e.clientWidth)));
    const last = coverGallery.grids.at(-1);
    const chooseLast = gallery.getByRole("button", { name: "选择封面 64", exact: true });
    await chooseLast.scrollIntoViewIfNeeded();
    await page.screenshot({ path: file("mobile-last-page.png") });
    page.once("dialog", d => d.accept());
    await chooseLast.click();
    await expect(lookup).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    await expect(coverInput).toHaveValue(last.url);
    await page.screenshot({ path: file("mobile-collapsed.png") });
    await summary.click();
    await expect(top).toContainText("第 6 / 6 页");
    assert.deepEqual(requests.map(r => r.page ?? 0), [0, 1, 2, 3, 4, 5, 4, 5]);
    await editor.getByRole("button", { name: /ID 26002/ }).click();
    await expect(gallery).toContainText("该条目暂无可导入的竖版封面");
    await expect(top).toHaveCount(0);
    assert.equal(requests.at(-1).page ?? 0, 0);
    await expect(coverInput).toHaveValue(last.url);
    await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
    await expect(editor).toHaveCount(0);
    assert.equal((await api(path)).coverUrl, last.url);
    const cover = (await api(path + "/fields")).fields.find(f => f.field === "coverUrl");
    assert.equal(cover.locked, true);
    assert.equal(cover.source.externalId, String(last.id));
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    console.log("REGRESSION PASS pages=6 eligible-covers=51 empty-middle=continued cancel=stayed-open selected=collapsed reopened=same-page saved-grid=260163 UI=desktop,390px");
  }
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill();
  await exited;
  writeFileSync(file("server.log"), log.replaceAll(token, "[QA_TOKEN]"));
}

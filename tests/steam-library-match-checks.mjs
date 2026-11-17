// Shared local-server and published-image checks. All accounts/games are synthetic.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { prefix } from "./steam-preview-fixture.cjs";

const ownership = { platformId: "PC", storeId: "STEAM" };
export async function seedComparison(api) {
  const create = input => api("games", "POST", { ownership, ...input }, 201);
  const single = await create({ title: "QA 本地别名", originalTitle: "ＱＡ  Steam サンプル 01", localizedTitle: "QA 対照タイトル", rating: 5, memo: "QA preserved memo" });
  const duplicateA = await create({ title: "QA Steam サンプル 02" });
  const duplicateB = await create({ title: "QA 同名另一作", localizedTitle: "QA Steam サンプル 02" });
  await create({ title: "QA Steam サンプル 03 Remake" });
  // The candidate sits beyond the first 24-item library page.
  for (let i = 0; i < 25; i++) await create({ title: "QA Filler " + i });
  return { single: single.id, duplicates: [duplicateA.id, duplicateB.id].sort() };
}

export function checkComparison(result, ids) {
  assert.equal(result.state, "listed");
  assert.equal(result.items.length, 13);
  assert.deepEqual(result.summary, { single_candidate: 1, multiple_candidates: 1, no_candidate: 11, missing_title: 0 });
  assert.equal(result.items[0].match.candidates[0].gameId, ids.single);
  assert.deepEqual(result.items[0].match.candidates[0].matchedFields, ["originalTitle"]);
  assert.deepEqual(result.items[0].match.candidates[0].platforms, ["PC"]);
  assert.deepEqual(result.items[1].match.candidates.map(c => c.gameId), ids.duplicates);
  assert.equal(result.items[2].match.state, "no_candidate");
  assert.equal(result.items[0].playtimeMinutes, 0);
  assert.equal(result.items[1].playtimeMinutes, null);
}

export async function comparisonUI(page, file, { edit = false } = {}) {
  await page.getByRole("button", { name: "Steam 预览", exact: true }).click();
  await page.getByLabel("SteamID64", { exact: true }).fill(prefix + "01");
  await page.getByRole("button", { name: "预览可见游戏", exact: true }).click();
  await expect(page.getByRole("button", { name: "单候选 · 待确认（1）", exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "Steam 可见游戏" });
  const requests = [];
  const listener = req => { if (req.url().endsWith("/api/steam/preview")) requests.push(req.url()); };
  page.on("request", listener);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
  await page.getByLabel("搜索预览结果", { exact: true }).fill("90001");
  await expect(list.locator(":scope > li")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Steam 预览分页" })).toHaveCount(0);
  await page.getByLabel("搜索预览结果", { exact: true }).fill("対照タイトル");
  await expect(list.locator(":scope > li")).toHaveCount(1);
  await page.getByRole("button", { name: "查看本地候选：QA 対照タイトル", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "游戏详情", exact: true });
  await expect(detail.getByRole("heading", { name: "QA 対照タイトル", exact: true })).toBeVisible();
  await expect(detail).toContainText("QA preserved memo");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "多候选 · 待确认（1）", exact: true }).click();
  await expect(list.locator(":scope > li")).toHaveCount(0);
  await expect(page.getByText("没有符合当前对照条件的游戏，请调整搜索或筛选。", { exact: true })).toBeVisible();
  await page.getByLabel("搜索预览结果", { exact: true }).fill("");
  await expect(list.locator(":scope > li")).toHaveCount(1);
  await expect(list.getByRole("button", { name: /查看本地候选/ })).toHaveCount(2);
  await page.screenshot({ path: file("steam-comparison-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: file("steam-comparison-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "缺少标题（0）", exact: true }).click();
  await expect(list.locator(":scope > li")).toHaveCount(0);
  await page.getByRole("button", { name: "重置对照筛选", exact: true }).click();
  await expect(list.locator(":scope > li")).toHaveCount(12);
  assert.deepEqual(requests, [], "search, filter, open and pagination must not call Steam");
  page.off("request", listener);
  await page.getByLabel("SteamID64", { exact: true }).fill(prefix + "08");
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "预览可见游戏", exact: true }).click();
  await expect(page.getByRole("button", { name: "缺少标题（1）", exact: true })).toBeVisible();
  await expect(list).toContainText("AppID 90050");
  await page.getByLabel("SteamID64", { exact: true }).fill(prefix + "01");
  await page.getByRole("button", { name: "预览可见游戏", exact: true }).click();
  await expect(page.getByRole("button", { name: "全部（13）", exact: true })).toHaveAttribute("aria-pressed", "true");
  if (edit) {
    await page.getByRole("button", { name: "查看本地候选：QA 対照タイトル", exact: true }).click();
    await detail.getByRole("button", { name: "编辑资料", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑游戏", exact: true });
    await editor.locator('input[name="originalTitle"]').fill("QA changed alias");
    await editor.getByRole("button", { name: "保存游戏", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(list).toHaveCount(0);
    await page.getByRole("button", { name: "预览可见游戏", exact: true }).click();
    await expect(page.getByRole("button", { name: "单候选 · 待确认（0）", exact: true })).toBeVisible();
  }
}

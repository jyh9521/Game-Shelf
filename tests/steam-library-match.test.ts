import test from "node:test";
import assert from "node:assert/strict";
import { candidateLimit, compareSteamLibrary, filterSteamComparisons, normalizeSteamTitle, type LocalSteamCandidate } from "../src/lib/steam-library-match";
import { readSteamPreview } from "../src/lib/steam-preview";

const local = (gameId: string, title: string, extra: Partial<LocalSteamCandidate> = {}): LocalSteamCandidate =>
  ({ gameId, title, originalTitle: "", localizedTitle: "", platforms: ["PC"], ...extra });
const compare = (names: (string | undefined)[], library: LocalSteamCandidate[]) => {
  const result = compareSteamLibrary(readSteamPreview({ response: { games: names.map((name, i) => ({ appid: i + 1, name })) } }), library);
  assert.equal(result.state, "listed");
  if (result.state !== "listed") throw Error("expected listed");
  return result;
};

test("Steam 对照只归一化宽度、大小写和空白，保留版本、标点及重音", () => {
  assert.equal(normalizeSteamTitle("  Ｆｏｏ\t BAR　"), "foo bar");
  for (const [a, b] of [["Foo II", "Foo 2"], ["Foo: Bar", "Foo Bar"], ["Foo Remake", "Foo"], ["café", "cafe"]])
    assert.notEqual(normalizeSteamTitle(a), normalizeSteamTitle(b));
});
test("Steam 对照按三个标题字段寻找候选，保留命中依据且不重复计数", () => {
  const result = compare(["Foo", "星の海", "中文名"], [
    local("a", "Ｆｏｏ", { originalTitle: "foo", platforms: ["PC", "PC", "PS4"] }),
    local("b", "别名", { originalTitle: "星の海" }), local("c", "CN", { localizedTitle: "中文名" })
  ]);
  assert.deepEqual(result.summary, { single_candidate: 3, multiple_candidates: 0, no_candidate: 0, missing_title: 0 });
  assert.deepEqual(result.items[0].match.candidates[0].matchedFields, ["title", "originalTitle"]);
  assert.deepEqual(result.items[0].match.candidates[0].platforms, ["PC", "PS4"]);
  assert.deepEqual(result.items[1].match.candidates[0].matchedFields, ["originalTitle"]);
  assert.deepEqual(result.items[2].match.candidates[0].matchedFields, ["localizedTitle"]);
});
test("同名不同作品保留多个候选，不自动认定身份或合并", () => {
  const result = compare(["Foo", "Foo Remake", "Bar"], [local("b", "Foo"), local("a", "Foo"), local("c", "Foo Remastered")]);
  assert.deepEqual(result.summary, { single_candidate: 0, multiple_candidates: 1, no_candidate: 2, missing_title: 0 });
  assert.deepEqual(result.items[0].match.candidates.map(c => c.gameId), ["a", "b"]);
});
test("缺少 Steam 标题时不把 AppID 占位符当作名称匹配", () => {
  const result = compare([undefined, "  "], [local("a", "AppID 1"), local("b", "AppID 2")]);
  assert.equal(result.summary.missing_title, 2);
  assert.ok(result.items.every(g => g.match.candidateCount === 0));
});
test("空可见库保持原状态，空本地库仍返回可见清单", () => {
  assert.deepEqual(compareSteamLibrary({ state: "no_visible_games" }, []), { state: "no_visible_games" });
  assert.equal(compare(["Foo"], []).summary.no_candidate, 1);
});
test("候选超限时保留真实总数，顺序确定且响应受限", () => {
  const library = Array.from({ length: 10000 }, (_, i) => local(String(i).padStart(5, "0"), "Foo"));
  const result = compare(["Foo"], library.reverse());
  assert.equal(result.items[0].match.candidateCount, 10000);
  assert.equal(result.items[0].match.candidates.length, candidateLimit);
  assert.equal(result.items[0].match.candidates[0].gameId, "00000");
});
test("搜索可用 AppID、Steam 名称及已展示本地别名，与状态取交集", () => {
  const result = compare(["Foo", "Bar", undefined], [local("a", "Foo", { localizedTitle: "中文名" })]);
  for (const q of ["  ＦＯＯ ", "中文名", "1"]) assert.equal(filterSteamComparisons(result.items, q, "all")[0].appid, 1);
  assert.equal(filterSteamComparisons(result.items, "中文名", "no_candidate").length, 0);
  assert.equal(filterSteamComparisons(result.items, "", "missing_title").length, 1);
  assert.equal(filterSteamComparisons(result.items, "zzz", "all").length, 0);
});
test("纯对照不修改输入、游玩时间或本地资料", () => {
  const library = [local("a", "Foo")];
  const preview = readSteamPreview({ response: { games: [{ appid: 1, name: "Foo", playtime_forever: 0 }] } });
  const before = JSON.stringify({ preview, library });
  const result = compareSteamLibrary(preview, library);
  assert.equal(JSON.stringify({ preview, library }), before);
  if (result.state === "listed") assert.equal(result.items[0].playtimeMinutes, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { previewSteamLibrary, readSteamPreview } from "../src/lib/steam-preview";

const input = { steamId: "76561198000000001" };
const failFetch: typeof fetch = async () => { assert.fail("should not call Steam"); };

test("Steam 预览无配置或非数字 SteamID64 时不发送请求", async () => {
  await assert.rejects(previewSteamLibrary(input, " ", failFetch), { status: 503 });
  for (const steamId of [Number(input.steamId), "00000000000000000", input.steamId + "0", "user-vanity"]) {
    await assert.rejects(previewSteamLibrary({ steamId }, "fixture", failFetch), { name: "ZodError" });
  }
});

test("Steam 预览按 AppID 去重，保留零时长并区分未知时长", () => {
  const result = readSteamPreview({ response: { game_count: 5, games: [
    { appid: 20, name: " 寒星 ", playtime_forever: 0 },
    { appid: 5, playtime_forever: -1 },
    { appid: 20, name: "另一个标题", playtime_forever: 60 },
    { appid: 0x100000000 }, null
  ] } });
  assert.deepEqual(result, { state: "listed", items: [
    { appid: 5, title: "AppID 5", playtimeMinutes: null },
    { appid: 20, title: "寒星", playtimeMinutes: 0 }
  ], skipped: 3 });
});

test("Steam 无可见游戏与返回结构错误使用不同结果", () => {
  for (const response of [{}, { game_count: 0 }, { game_count: 0, games: [] }]) {
    assert.deepEqual(readSteamPreview({ response }), { state: "no_visible_games" });
  }
  for (const response of [null, [], { game_count: 1 }, { game_count: 1, games: [] },
    { game_count: 0, games: [{ appid: 1 }] }, { games: [{ appid: 0 }] }]) {
    assert.throws(() => readSteamPreview({ response }), { status: 502 });
  }
});

test("Steam 凭据仅放请求头，SteamID64 保留完整位数", async () => {
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(String(value));
    assert.equal(url.origin + url.pathname, "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
    assert.equal(url.searchParams.get("input_json"), '{"steamid":76561198000000001,"include_appinfo":true,"include_played_free_games":true}');
    assert.deepEqual([...url.searchParams.keys()], ["input_json"]);
    assert.equal(new Headers(init?.headers).get("x-webapi-key"), "qa-key");
    assert.equal(init?.redirect, "error");
    return Response.json({ response: {} });
  };
  assert.deepEqual(await previewSteamLibrary(input, " qa-key ", fetcher), { state: "no_visible_games" });
});

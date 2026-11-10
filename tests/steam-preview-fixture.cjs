// Intercept the production server's outbound fetches without adding a test
// switch to the application. Nothing in this fixture calls the real Steam API.
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");
const fetchReal = globalThis.fetch;
const prefix = "765611980000000";
const key = "qa-steam-preview-key-not-a-secret";
module.exports = { prefix, key };

if (process.env.GAMESHELF_QA_STEAM_LOG) globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return fetchReal(input, init);
  assert.equal(url.origin + url.pathname, "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  assert.deepEqual([...url.searchParams.keys()], ["input_json"]);
  assert.equal(new Headers(init?.headers).get("x-webapi-key"), key);
  assert.equal(init?.redirect, "error");
  assert.equal(init?.cache, "no-store");
  const json = url.searchParams.get("input_json");
  const match = json?.match(/^\{"steamid":(765611980000000\d{2}),"include_appinfo":true,"include_played_free_games":true\}$/);
  assert.ok(match, "the 64-bit ID must be serialized without rounding");
  const suffix = match[1].slice(-2);
  appendFileSync(process.env.GAMESHELF_QA_STEAM_LOG, suffix + "\n");
  if (suffix === "02") return Response.json({ response: {} });
  if (suffix === "03") return Response.json({ response: { game_count: 0, games: [] } });
  if (suffix === "04") return new Response(key, { status: 429, headers: { "Retry-After": "30" } });
  if (suffix === "05") return new Response(key, { status: 403 });
  if (suffix === "06") return Response.json({ response: { game_count: 2 } });
  if (suffix === "07") throw new DOMException(key, "TimeoutError");
  assert.equal(suffix, "01");
  const games = Array.from({ length: 13 }, (_, i) => ({
    appid: 90001 + i, name: "QA Steam サンプル " + String(i + 1).padStart(2, "0"),
    ...(i === 1 ? {} : { playtime_forever: i * 65 })
  }));
  return Response.json({ response: { game_count: 15, games: [...games, { ...games[0], playtime_forever: 99 }, { appid: -1 }] } });
};

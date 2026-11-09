import test from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../src/lib/metadata-service";
import { MetadataError } from "../src/lib/metadata-http";
import { searchInput, previewInput } from "../src/lib/metadata-domain";
import { fixture, env, title, coverUrl, thumbUrl, zelda } from "./metadata-fixtures.cjs";

test("资料源由服务端变量单独启用；半套 IGDB / ScreenScraper 凭据不会发起请求", async () => {
  const service = new MetadataService({ IGDB_CLIENT_ID: "half", SCREENSCRAPER_DEV_ID: "id", SCREENSCRAPER_DEV_PASSWORD: "pw",
    SCREENSCRAPER_USERNAME: "only-member", RAWG_API_KEY: "key" }, async () => { throw new Error("unexpected fetch"); });
  assert.deepEqual(service.status().filter(s => s.enabled), [{ id: "rawg", enabled: true }]);
  const guest = new MetadataService({ SCREENSCRAPER_DEV_ID: "id", SCREENSCRAPER_DEV_PASSWORD: "pw" }, async () => { throw new Error("unexpected fetch"); });
  assert.deepEqual(guest.status().filter(s => s.enabled), [{ id: "screenscraper", enabled: true }]);
  await assert.rejects(service.search("u", "igdb", "query"), (e: MetadataError) => e.status === 409);
  assert.equal(previewInput.safeParse({ provider: "rawg", id: "../201" }).success, false);
  assert.equal(searchInput.safeParse({ provider: "http://evil.invalid", query: "title" }).success, false);
  assert.equal(searchInput.safeParse({ provider: "rawg", query: "a", apiKey: "x" }).success, false);
});
test("IGDB OAuth 缓存、401 单次续签、同名候选和 APICalypse 转义", async () => {
  const calls: string[] = [];
  const service = new MetadataService(env, fixture({ revokeOnce: true, log: (value: string) => calls.push(value) }) as typeof fetch);
  const search = await service.search("a", "igdb", 'QA "foo"; \\ break');
  assert.equal(search.length, 2);
  assert.equal(search[0].title, title); assert.equal(search[0].date, "2024-03-18");
  assert.notEqual(search[0].date, search[1].date);
  const [p] = await service.preview("a", "igdb", search[0].id);
  assert.equal(p.candidate.fields.developer, "IGDB QA Studio");
  assert.equal(p.candidate.fields.publisher, "IGDB QA Press");
  assert.equal(calls.filter(c => c.includes("oauth2")).length, 2);
  assert.equal(calls.filter(c => c.includes("v4/games")).length, 3);
});
test("RAWG、TheGamesDB、ScreenScraper 的详情按字段规范化，日期保持来源精度", async () => {
  const service = new MetadataService(env, fixture() as typeof fetch);
  for (const [provider, platform, date, genre, description] of [
    ["rawg", "PC", "2024-03-18", "Adventure", "RAWG 的来源简介"],
    ["thegamesdb", "Sega Saturn", "1997", "Strategy", "TheGamesDB 的来源简介"],
    ["screenscraper", "Sega Saturn", "1997-11", "Action", "ScreenScraper QA EN"]
  ] as const) {
    const [hit] = await service.search("a", provider, title);
    assert.deepEqual(hit.platforms, [platform]); assert.equal(hit.date, date);
    const [p] = await service.preview("a", provider, hit.id);
    assert.equal(p.candidate.fields.genre, genre); assert.equal(p.candidate.fields.description, description);
    assert.ok(p.candidate.fields.developer && p.candidate.fields.publisher);
    assert.equal(p.candidate.fields.coverUrl, undefined);
    assert.doesNotMatch(JSON.stringify(p), /QA-fixture-|api\.screenscraper/);
  }
  assert.deepEqual(await service.search("a", "screenscraper", "missing"), []);
});
test("SteamGridDB 只返回竖版封面；筛掉非 CDN、带查询参数和横图", async () => {
  const service = new MetadataService(env, fixture() as typeof fetch);
  const [hit] = await service.search("a", "steamgriddb", title);
  const [a, b, ...rest] = await service.preview("a", "steamgriddb", hit.id);
  assert.equal(rest.length, 0);
  assert.equal(a.candidate.externalId, "601");
  assert.deepEqual(a.candidate.fields, { coverUrl });
  assert.equal(a.image?.thumbnail, thumbUrl);
  assert.equal(b.candidate.externalId, "604"); assert.equal(b.image?.width, undefined);
  assert.throws(() => service.resolve("a", [{ token: a.token, fields: ["title"] }]), (e: MetadataError) => e.status === 400);
});
test("SteamGridDB 时之笛条目 21202 的官方 cdn2 竖版图能进入候选，而仿冒域名和带令牌地址仍被排除", async () => {
  const service = new MetadataService(env, fixture() as typeof fetch);
  const [hit] = await service.search("qa", "steamgriddb", zelda.title);
  assert.equal(hit.id, zelda.id);
  const items = await service.preview("qa", "steamgriddb", hit.id);
  assert.deepEqual(items.map(p => p.candidate.externalId), [zelda.grid]);
  assert.deepEqual(items[0].candidate.fields, { coverUrl: zelda.cover });
  assert.equal(items[0].image?.thumbnail, zelda.thumb);
});
test("重复查询共用缓存；候选令牌绑定会话用户，不能伪造、跨用户或重复字段", async () => {
  const calls: string[] = [];
  const service = new MetadataService(env, fixture({ log: (value: string) => calls.push(value) }) as typeof fetch);
  await Promise.all([service.search("a", "rawg", title), service.search("b", "rawg", title)]);
  const [first] = await service.preview("a", "rawg", "201");
  const [second] = await service.preview("b", "rawg", "201");
  assert.equal(calls.length, 2);
  assert.notEqual(first.token, second.token);
  assert.equal(service.resolve("a", [{ token: first.token, fields: ["title"] }]).title?.value, title);
  assert.throws(() => service.resolve("b", [{ token: first.token, fields: ["title"] }]), (e: MetadataError) => e.status === 409);
  assert.throws(() => service.resolve("a", [{ token: "invented", fields: ["title"] }]), (e: MetadataError) => e.status === 409);
  assert.throws(() => service.resolve("a", [{ token: first.token, fields: ["title", "title"] }]), (e: MetadataError) => e.status === 400);
});
test("超时、超长响应、非 JSON 和额度错误脱敏，不影响其它已配置服务", async () => {
  const calls: string[] = [];
  const service = new MetadataService(env, fixture({ log: (value: string) => calls.push(value) }) as typeof fetch);
  for (const [query, status] of [["bad-json", 502], ["oversize", 502], ["timeout", 504], ["quota", 429]] as const) {
    await assert.rejects(service.search("a", "rawg", query), (e: MetadataError) =>
      e.status === status && !e.message.includes(env.RAWG_API_KEY));
  }
  const count = calls.length;
  await assert.rejects(service.search("b", "rawg", title), (e: MetadataError) => e.status === 429 && !!e.retryAt);
  assert.equal(calls.length, count);
  assert.equal((await service.search("b", "steamgriddb", title)).length, 1);
});

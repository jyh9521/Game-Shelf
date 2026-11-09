import test from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../src/lib/metadata-service";
import { MetadataError } from "../src/lib/metadata-http";
import { searchInput, previewInput } from "../src/lib/metadata-domain";
import { fixture, env, title, coverUrl, thumbUrl, zelda, coverGallery } from "./metadata-fixtures.cjs";

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
  const { items: [p], pagination } = await service.preview("a", "igdb", search[0].id);
  assert.equal(pagination, undefined);
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
    const { items: [p] } = await service.preview("a", provider, hit.id);
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
  const { items: [a, b, ...rest] } = await service.preview("a", "steamgriddb", hit.id);
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
  const { items } = await service.preview("qa", "steamgriddb", hit.id);
  assert.deepEqual(items.map(p => p.candidate.externalId), [zelda.grid]);
  assert.deepEqual(items[0].candidate.fields, { coverUrl: zelda.cover });
  assert.equal(items[0].image?.thumbnail, zelda.thumb);
});
test("SteamGridDB 真分页使用不同的缓存键，过滤掉整页后仍能继续，最后一页可保存", async () => {
  const requested: string[] = [];
  const remote = fixture();
  const service = new MetadataService(env, async (input, init) => {
    const params = new URL(input instanceof Request ? input.url : input).searchParams;
    requested.push(params.get("page") + ":" + params.get("limit"));
    return remote(input, init);
  });
  const counts = [12, 11, 0, 12, 12, 4];
  for (let page = 0; page < counts.length; page++) {
    const result = await service.preview("a", "steamgriddb", coverGallery.id, page);
    assert.equal(result.items.length, counts[page]);
    assert.deepEqual(result.pagination, { page, pageSize: 12, totalPages: 6, hasNext: page < 5 });
  }
  const lastPage = await service.preview("b", "steamgriddb", coverGallery.id, 5);
  const previous = await service.preview("b", "steamgriddb", coverGallery.id, 4);
  assert.deepEqual(requested, ["0:12", "1:12", "2:12", "3:12", "4:12", "5:12"]);
  assert.notEqual(lastPage.items[0].candidate.externalId, previous.items[0].candidate.externalId);
  const last = lastPage.items.at(-1)!;
  assert.equal(last.candidate.externalId, "260163");
  assert.equal(service.resolve("b", [{ token: last.token, fields: ["coverUrl"] }]).coverUrl?.value, coverGallery.grids.at(-1)!.url);
  assert.throws(() => service.resolve("a", [{ token: last.token, fields: ["coverUrl"] }]), (e: MetadataError) => e.status === 409);
});
test("SteamGridDB 缺少页数时按原始行数判断下一页；预览只允许封面用非负整数页码", async () => {
  const remote = fixture();
  const service = new MetadataService(env, async (input, init) => {
    const { data } = await (await remote(input, init)).json();
    return Response.json({ success: true, data });
  });
  const empty = await service.preview("a", "steamgriddb", coverGallery.id, 2);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.pagination, { page: 2, pageSize: 12, totalPages: null, hasNext: true });
  assert.equal((await service.preview("a", "steamgriddb", coverGallery.id, 5)).pagination?.hasNext, false);
  const base = { provider: "steamgriddb", id: coverGallery.id };
  assert.equal(previewInput.safeParse({ ...base, page: 0 }).success, true);
  for (const page of [-1, 1.5, "1", 2147483648]) assert.equal(previewInput.safeParse({ ...base, page }).success, false);
  assert.equal(previewInput.safeParse({ provider: "rawg", id: "201", page: 0 }).success, false);
});
test("重复查询共用缓存；候选令牌绑定会话用户，不能伪造、跨用户或重复字段", async () => {
  const calls: string[] = [];
  const service = new MetadataService(env, fixture({ log: (value: string) => calls.push(value) }) as typeof fetch);
  await Promise.all([service.search("a", "rawg", title), service.search("b", "rawg", title)]);
  const { items: [first] } = await service.preview("a", "rawg", "201");
  const { items: [second] } = await service.preview("b", "rawg", "201");
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

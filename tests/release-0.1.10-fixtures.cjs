// Test-only transport router. The QA server has no route to real providers.
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");
const { fixture } = require("./metadata-fixtures.cjs");

const geminiKey = "qa-gemini-key-not-a-secret";
const description = "Explore the Lantern Sea. Collect clues and return to the harbour.\n\nThe tides change each night.";
const translations = {
  "zh-CN": "探索灯笼海，收集线索后返回港口。\n\n潮汐每晚变化。",
  ja: "ランタンの海を探索し、手がかりを集めて港に戻ろう。\n\n潮は毎晩変わります。",
  en: description
};
const title = "QA 灯笼海";
module.exports = { geminiKey, description, translations, title };

if (process.env.GAMESHELF_QA_RELEASE_LOG) {
  const realFetch = globalThis.fetch;
  require("./steam-preview-fixture.cjs");
  const steamFetch = globalThis.fetch;
  assert.notEqual(steamFetch, realFetch);
  const record = value => appendFileSync(process.env.GAMESHELF_QA_RELEASE_LOG, value + "\n");
  const metadataFetch = fixture({ log: record });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return realFetch(input, init);
    if (url.hostname === "api.steampowered.com") return steamFetch(input, init);
    if (url.hostname !== "generativelanguage.googleapis.com") return metadataFetch(input, init);
    assert.equal(url.href, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), geminiKey);
    const req = JSON.parse(init.body);
    assert.deepEqual(Object.keys(req).sort(), ["contents", "generationConfig", "store", "systemInstruction"]);
    assert.equal(req.store, false);
    const source = req.contents[0]?.parts[0]?.text;
    assert.deepEqual(req.contents, [{ role: "user", parts: [{ text: source }] }]);
    const locale = req.systemInstruction.parts[0]?.text.match(/\((zh-CN|ja|en)\)/)?.[1];
    assert.ok(locale);
    record("gemini:" + locale);
    if (source === "QA blocked") return Response.json({ promptFeedback: { blockReason: "SAFETY" } });
    if (source === "QA quota") return new Response(geminiKey, { status: 429, headers: { "Retry-After": "15" } });
    assert.equal(source, description);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: translations[locale] }] } }] });
  };
}

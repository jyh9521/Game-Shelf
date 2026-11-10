import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GEMINI_MODEL, translateDescription } from "../src/lib/gemini-translation";
import { MAX_GAME_DESCRIPTION } from "../src/lib/domain";

const input = { text: "Explore the Lantern Sea.\n\nReturn to the harbour.", target: "zh-CN" };
const key = "qa-gemini-key";
const env = { NODE_ENV: "test", GEMINI_API_KEY: key } as const;
const noFetch: typeof fetch = async () => assert.fail("translation should not call upstream");
const complete = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });

test("Gemini 翻译：未配置、空简介、无效语言、超长输入或无效模型不出站", async () => {
  await assert.rejects(translateDescription(input, { NODE_ENV: "test", GEMINI_API_KEY: "" }, noFetch), { status: 503 });
  for (const draft of [{ ...input, text: " \n " }, { ...input, text: "x".repeat(MAX_GAME_DESCRIPTION + 1) },
    { ...input, target: "unknown" }, { ...input, memo: "do not send" }]) {
    await assert.rejects(translateDescription(draft, env, noFetch), { name: "ZodError" });
  }
  await assert.rejects(translateDescription(input, { ...env, GEMINI_MODEL: "https://wrong.invalid" }, noFetch), { status: 503 });
});

test("Gemini 翻译：只发送当前简介，密钥仅在请求头，译文保留段落并忽略思考字段", async () => {
  const fetcher: typeof fetch = async (value, init) => {
    assert.equal(String(value), "https://generativelanguage.googleapis.com/v1beta/models/" + DEFAULT_GEMINI_MODEL + ":generateContent");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), key);
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: input.text }] }]);
    assert.match(request.systemInstruction.parts[0].text, /Simplified Chinese/);
    assert.equal(request.store, false);
    assert.ok(!String(init?.body).includes(key));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "not a translation", thought: true }, { text: "探索灯笼海。\n\n" }, { text: "返回港口。" }
    ] } }] });
  };
  assert.deepEqual(await translateDescription(input, env, fetcher), { text: "探索灯笼海。\n\n返回港口。" });
});

test("Gemini 翻译：支持运行时模型和日语目标", async () => {
  const fetcher: typeof fetch = async (value, init) => {
    assert.match(String(value), /\/models\/gemini-3.5-flash:generateContent$/);
    assert.match(JSON.parse(String(init?.body)).systemInstruction.parts[0].text, /Japanese/);
    return complete("港へ戻ろう。");
  };
  assert.deepEqual(await translateDescription({ ...input, target: "ja" }, { ...env, GEMINI_MODEL: " gemini-3.5-flash " }, fetcher),
    { text: "港へ戻ろう。" });
});

test("Gemini 翻译：被阻止、不完整、空译文或超长译文不会作为预览返回", async () => {
  for (const payload of [{ promptFeedback: { blockReason: "SAFETY" } }, { candidates: [{ finishReason: "MAX_TOKENS" }] }])
    await assert.rejects(translateDescription(input, env, async () => Response.json(payload)), { status: 422 });
  for (const text of [" ", "译".repeat(MAX_GAME_DESCRIPTION + 1)])
    await assert.rejects(translateDescription(input, env, async () => complete(text)), { status: 502 });
  await assert.rejects(translateDescription(input, env, async () => Response.json({ candidates: [] })), { status: 502 });
});

test("Gemini 翻译：限流、无效密钥、超时和错误响应不泄漏上游内容", async () => {
  for (const [upstream, status] of [[429, 429], [403, 502], [404, 502]]) {
    await assert.rejects(translateDescription(input, env,
      async () => new Response(key, { status: upstream, headers: { "Retry-After": "12" } })), err => {
      assert.equal((err as { status: number }).status, status);
      assert.ok(!String(err).includes(key));
      if (status === 429) assert.ok((err as { retryAt: number }).retryAt > Date.now());
      return true;
    });
  }
  await assert.rejects(translateDescription(input, env, async () => { throw new DOMException(key, "TimeoutError"); }), { status: 504 });
});

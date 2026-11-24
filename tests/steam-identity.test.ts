import test from "node:test";
import assert from "node:assert/strict";
import { steamLoginUrl, verifySteamIdentity } from "../src/lib/steam-identity";
import { steamImportInput, sourceSeconds } from "../src/lib/steam-import-domain";

const returnTo = "https://shelf.example/steam/callback?state=abc";
const now = Date.parse("2026-11-24T01:00:00Z");
function assertion() {
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001",
    "openid.identity": "https://steamcommunity.com/openid/id/76561198000000001",
    "openid.return_to": returnTo, "openid.response_nonce": "2026-11-24T00:59:59Ztest",
    "openid.assoc_handle": "test", "openid.sig": "test",
    "openid.signed": "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle"
  });
}
const valid = (async () => new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n")) as typeof fetch;
test("Steam identity uses only the fixed provider and exact return URL", async () => {
  const url = new URL(steamLoginUrl(returnTo));
  assert.equal(url.origin, "https://steamcommunity.com");
  assert.equal(url.searchParams.get("openid.return_to"), returnTo);
  assert.equal(await verifySteamIdentity(assertion(), returnTo, valid, now), "76561198000000001");
});
test("Steam assertion rejects tampering, unsigned fields, stale/future nonce and negative verification", async () => {
  for (const [key, value] of [
    ["openid.op_endpoint", "https://evil.example/"], ["openid.identity", "https://steamcommunity.com/openid/id/76561198000000002"],
    ["openid.claimed_id", "https://evil.example/openid/id/76561198000000001"], ["openid.return_to", returnTo + "x"],
    ["openid.signed", "claimed_id,identity"], ["openid.response_nonce", "2026-11-23T00:59:59Ztest"],
    ["openid.response_nonce", "2026-11-25T00:59:59Ztest"], ["openid.mode", "cancel"]
  ]) {
    const data = assertion(); data.set(key, value);
    await assert.rejects(verifySteamIdentity(data, returnTo, valid, now));
  }
  const duplicate = assertion(); duplicate.append("openid.identity", duplicate.get("openid.identity")!);
  await assert.rejects(verifySteamIdentity(duplicate, returnTo, valid, now));
  await assert.rejects(verifySteamIdentity(assertion(), returnTo, (async () => new Response("is_valid:false\n")) as typeof fetch, now));
  await assert.rejects(verifySteamIdentity(assertion(), returnTo, (async () => new Response("is_valid:true\n", {status: 500})) as typeof fetch, now));
});
test("import choices require explicit confirmation, unique AppIDs, bounded batch and no client metadata", () => {
  const input = { token: "a".repeat(64), confirmed: true, choices: [{ appid: 10, gameId: null }] };
  assert.equal(steamImportInput.parse(input).choices[0].gameId, null);
  for (const value of [{...input, confirmed:false}, {...input, choices:[]}, {...input, choices:[input.choices[0], input.choices[0]]},
    {...input, choices:[{appid:10,gameId:null,title:"spoofed"}]}, {...input, choices:Array.from({length:101},(_,i)=>({appid:i+1,gameId:null}))}])
    assert.equal(steamImportInput.safeParse(value).success, false);
  assert.equal(sourceSeconds(null), null); assert.equal(sourceSeconds(0), 0); assert.equal(sourceSeconds(61), 3660);
  assert.equal(sourceSeconds(0xffffffff), null);
});

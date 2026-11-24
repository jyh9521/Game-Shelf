import { MetadataError } from "./metadata-http";

const endpoint = "https://steamcommunity.com/openid/login";
const namespace = "http://specs.openid.net/auth/2.0";
const identity = "http://specs.openid.net/auth/2.0/identifier_select";
export function steamLoginUrl(returnTo: string) {
  const url = new URL(endpoint);
  Object.entries({ ns: namespace, mode: "checkid_setup", identity, claimed_id: identity,
    return_to: returnTo, realm: new URL(returnTo).origin + "/" })
    .forEach(([key, value]) => url.searchParams.set("openid." + key, value));
  return url.href;
}
export async function verifySteamIdentity(params: URLSearchParams, returnTo: string, fetcher = fetch, now = Date.now()) {
  const fail = () => new MetadataError(400, "Steam 身份验证失败或已过期，请重新连接。");
  const get = (key: string) => params.get("openid." + key) ?? "";
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw fail();
  const id = /^https:\/\/steamcommunity\.com\/openid\/id\/([1-9][0-9]{16})$/.exec(get("claimed_id"))?.[1];
  const nonceTime = Date.parse(get("response_nonce").slice(0, 20));
  const signed = get("signed").split(",");
  if (get("ns") !== namespace || get("mode") !== "id_res" || get("op_endpoint") !== endpoint || !id ||
    get("identity") !== get("claimed_id") || get("return_to") !== returnTo || !get("sig") || !get("assoc_handle") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z.+$/.test(get("response_nonce")) || !Number.isFinite(nonceTime) ||
    now - nonceTime > 600000 || nonceTime - now > 60000 ||
    ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"].some(key => !signed.includes(key))) throw fail();
  // Steam owns both the pinned HTTPS identifier namespace and OP endpoint.
  // Never perform discovery or verification against callback-supplied hosts.
  const body = new URLSearchParams([...params].filter(([key]) => key.startsWith("openid.")));
  body.set("openid.mode", "check_authentication");
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "POST", body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
  } catch { throw new MetadataError(502, "Steam 验证服务暂时不可用，请重新连接。"); }
  const text = await response.text();
  if (!response.ok || text.length > 10000 || text.split(/\r?\n/).filter(line => line === "is_valid:true").length !== 1 ||
    text.split(/\r?\n/).filter(line => line.startsWith("is_valid:")).length !== 1) throw fail();
  return id;
}

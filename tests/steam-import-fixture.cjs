require("./release-0.1.10-fixtures.cjs");
require("./steam-preview-fixture.cjs");
const real = globalThis.fetch;
if (process.env.GAMESHELF_QA_STEAM_LOG) globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://steamcommunity.com") return real(input, init);
  if (url.pathname !== "/openid/login" || init?.method !== "POST" || init?.redirect !== "error") throw Error("Unexpected OpenID request");
  const body = new URLSearchParams(init.body);
  if (body.get("openid.mode") !== "check_authentication") throw Error("Not direct verification");
  return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:" + (body.get("openid.sig") === "qa-valid" ? "true" : "false") + "\n");
};

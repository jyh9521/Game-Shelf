// Synthetic responses exercise the public wire shapes; no real credentials,
// catalogue rows, account information or media are included.
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");

const env = {
  IGDB_CLIENT_ID: "QA-fixture-igdb-id",
  IGDB_CLIENT_SECRET: "QA-fixture-igdb-secret",
  RAWG_API_KEY: "QA-fixture-rawg-key",
  THEGAMESDB_API_KEY: "QA-fixture-tgdb-key",
  SCREENSCRAPER_DEV_ID: "QA-fixture-ss-dev",
  SCREENSCRAPER_DEV_PASSWORD: "QA-fixture-ss-secret",
  SCREENSCRAPER_USERNAME: "QA-fixture-ss-account",
  SCREENSCRAPER_PASSWORD: "QA-fixture-ss-password",
  SCREENSCRAPER_SOFTNAME: "GameShelf QA",
  STEAMGRIDDB_API_KEY: "QA-fixture-sgdb-key"
};
const coverUrl = "https://cdn.steamgriddb.com/grid/fixture-portrait.png";
const thumbUrl = "https://cdn.steamgriddb.com/thumb/fixture-portrait.png";
const title = "QA 星港远航";
// Public artwork URL shape observed for game 21202 / grid 787839. The
// fixtures and browser tests do not download any artwork or use a real key.
const zelda = {
  title: "The Legend of Zelda: Ocarina of Time", id: "21202", grid: "787839",
  cover: "https://cdn2.steamgriddb.com/grid/8fff7c872b733893a1a891be7c26c18c.png",
  thumb: "https://cdn2.steamgriddb.com/thumb/8fff7c872b733893a1a891be7c26c18c.jpg"
};
const ports = { PC: "PC", SS: "Sega Saturn", PS5: "PlayStation 5" };

/** @param {{ revokeOnce?: boolean, log?: (path: string) => void }} [options] */
function fixture({ revokeOnce = false, log = () => {} } = {}) {
  let tokens = 0;
  return async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const json = value => Response.json(value);
    const notFound = () => new Response(null, { status: 404 });
    const params = u.searchParams;
    const check = (name, key) => assert.equal(params.get(name), env[key]);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(u.protocol, "https:");
    log(u.hostname + u.pathname);
    if (u.hostname === "id.twitch.tv") {
      assert.equal(u.pathname, "/oauth2/token");
      assert.equal(init?.method, "POST");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("client_id"), env.IGDB_CLIENT_ID);
      assert.equal(body.get("client_secret"), env.IGDB_CLIENT_SECRET);
      assert.equal(body.get("grant_type"), "client_credentials");
      return json({ access_token: "QA-fixture-igdb-token-" + ++tokens, expires_in: 3600 });
    }
    if (u.hostname === "api.igdb.com") {
      assert.equal(u.pathname, "/v4/games");
      assert.equal(init?.method, "POST");
      assert.equal(headers.get("Client-ID"), env.IGDB_CLIENT_ID);
      assert.equal(headers.get("Authorization"), "Bearer QA-fixture-igdb-token-" + tokens);
      if (revokeOnce && tokens === 1) return new Response("QA-fixture-igdb-token-1", { status: 401 });
      const g = { id: 101, name: title, first_release_date: 1710720000, platforms: [{ name: ports.PS5 }], game_type: { type: "Main Game" } };
      if (String(init.body).startsWith("search ")) {
        assert.match(String(init.body), /^search "[^"\\;]*"; fields [a-z_.,]+; limit 12;$/i);
        return json([g, { ...g, id: 102, first_release_date: 978307200 }]);
      }
      assert.match(String(init.body), /where id = 101; limit 1;$/);
      return json([{ ...g, summary: "IGDB 的来源简介", genres: [{ name: "RPG" }],
        involved_companies: [{ developer: true, company: { name: "IGDB QA Studio" } }, { publisher: true, company: { name: "IGDB QA Press" } }] }]);
    }
    if (u.hostname === "api.rawg.io") {
      check("key", "RAWG_API_KEY");
      if (u.pathname === "/api/games") {
        assert.equal(params.get("page_size"), "12");
        const q = params.get("search");
        if (q === "quota") return new Response("do not expose " + env.RAWG_API_KEY, { status: 429, headers: { "Retry-After": "3" } });
        if (q === "bad-json") return new Response("do not expose " + env.RAWG_API_KEY);
        if (q === "missing") return json({ results: [] });
        if (q === "timeout") throw new DOMException("test upstream timeout", "TimeoutError");
        if (q === "oversize") return new Response("irrelevant", { headers: { "Content-Length": "5242880" } });
        return json({ results: [{ id: 201, name: title, released: "2024-03-18", platforms: [{ platform: { name: ports.PC } }] }] });
      }
      if (u.pathname !== "/api/games/201" && u.pathname !== "/api/games/202") return notFound();
      return json({ id: Number(u.pathname.split("/").pop()), name: title, name_original: "スター・ハーバー",
        description_raw: u.pathname.endsWith("202") ? "RAWG 的新版来源简介" : "RAWG 的来源简介",
        genres: [{ name: "Adventure" }], developers: [{ name: "RAWG QA Studio" }], publishers: [{ name: "RAWG QA Press" }],
        background_image: "https://media.rawg.io/ignored.png" });
    }
    if (u.hostname === "api.thegamesdb.net") {
      check("apikey", "THEGAMESDB_API_KEY");
      const g = { id: 301, game_title: title, release_date: "1997", platform: 20 };
      if (u.pathname === "/v1.1/Games/ByGameName") {
        assert.equal(params.get("include"), "platform");
        return json({ code: 200, data: { games: [g] }, include: { platform: { data: { 20: { name: ports.SS } } } } });
      }
      if (u.pathname === "/v1/Games/ByGameID") {
        assert.equal(params.get("id"), "301");
        assert.equal(params.get("fields"), "overview,genres,publishers,developers");
        return json({ code: 200, data: { games: [{ ...g, overview: "TheGamesDB 的来源简介", genres: [7], developers: [8], publishers: [9] }] } });
      }
      if (u.pathname === "/v1/Genres") return json({ code: 200, data: { genres: { 7: { name: "Strategy" } } } });
      if (u.pathname === "/v1/Developers") return json({ code: 200, data: { developers: { 8: { name: "TGDB QA Studio" } } } });
      if (u.pathname === "/v1/Publishers") return json({ code: 200, data: { publishers: { 9: { name: "TGDB QA Press" } } } });
    }
    if (u.hostname === "api.screenscraper.fr") {
      check("devid", "SCREENSCRAPER_DEV_ID"); check("devpassword", "SCREENSCRAPER_DEV_PASSWORD");
      check("ssid", "SCREENSCRAPER_USERNAME"); check("sspassword", "SCREENSCRAPER_PASSWORD");
      check("softname", "SCREENSCRAPER_SOFTNAME"); assert.equal(params.get("output"), "json");
      const g = { id: "401", noms: [{ region: "ss", text: title }], systeme: { id: "22", nom: ports.SS },
        dates: [{ region: "us", text: "1997-11" }], developpeur: { text: "SS QA Studio" }, editeur: { text: "SS QA Press" },
        synopsis: [{ langue: "fr", text: "ScreenScraper QA FR" }, { langue: "en", text: "ScreenScraper QA EN" }],
        genres: [{ noms: [{ langue: "en", text: "Action" }] }], medias: [{ url: "https://api.screenscraper.fr/ignored?devpassword=" + env.SCREENSCRAPER_DEV_PASSWORD }] };
      if (u.pathname === "/api2/jeuRecherche.php") return params.get("recherche") === "missing" ? notFound() : json({ response: { jeux: [g] } });
      assert.equal(u.pathname, "/api2/jeuInfos.php");
      assert.equal(params.get("gameid"), "401");
      return json({ response: { jeu: g } });
    }
    if (u.hostname === "www.steamgriddb.com") {
      assert.equal(headers.get("Authorization"), "Bearer " + env.STEAMGRIDDB_API_KEY);
      if (u.pathname.startsWith("/api/v2/search/autocomplete/")) {
        if (decodeURIComponent(u.pathname.split("/").at(-1)) === zelda.title) {
          return json({ success: true, data: [{ id: 21202, name: zelda.title }, { id: 5532594, name: zelda.title }] });
        }
        return json({ success: true, data: [{ id: 501, name: title, verified: true }] });
      }
      assert.ok(["/api/v2/grids/game/501", "/api/v2/grids/game/21202", "/api/v2/grids/game/5532594"].includes(u.pathname));
      assert.equal(params.get("types"), "static"); assert.equal(params.get("nsfw"), "false");
      assert.equal(params.get("epilepsy"), "false"); assert.equal(params.get("humor"), "false");
      assert.equal(params.get("dimensions"), "600x900,342x482,660x930");
      if (u.pathname.endsWith("/5532594")) return json({ success: true, data: [] });
      if (u.pathname.endsWith("/21202")) return json({ success: true, data: [
        { id: 787839, width: 600, height: 900, url: zelda.cover, thumb: zelda.thumb },
        { id: 787840, width: 600, height: 900, url: zelda.cover.replace("steamgriddb.com", "steamgriddb.com.invalid") },
        { id: 787841, width: 600, height: 900, url: zelda.cover + "?token=do-not-return" }
      ] });
      return json({ success: true, data: [
        { id: 600, width: 920, height: 430, url: coverUrl },
        { id: 601, width: 600, height: 900, url: coverUrl, thumb: thumbUrl },
        { id: 602, url: "https://evil.invalid/grid/test.png" },
        { id: 603, url: coverUrl + "?token=do-not-return" },
        { id: 604, url: coverUrl.replace("portrait", "second") },
        { id: 605, url: coverUrl, nsfw: true }
      ] });
    }
    throw new Error("Unexpected fixture request");
  };
}

if (process.env.GAMESHELF_QA_PROVIDER_LOG) {
  const remote = fixture({ log: value => appendFileSync(process.env.GAMESHELF_QA_PROVIDER_LOG, value + "\n") });
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, init);
    return remote(input, init);
  };
}
module.exports = { fixture, env, title, coverUrl, thumbUrl, zelda };

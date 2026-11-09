import { date } from "./domain";
import { fieldValue, isGridImage, type CoverPagination, type Metadata, type Provider, type SearchHit } from "./metadata-domain";
import { invalidResponse, MetadataError, ProviderHttp, upstreamError } from "./metadata-http";

export type Detail = { id: string; fields: Partial<Metadata>; image?: { thumbnail: string; width?: number; height?: number } };
export type DetailPage = { items: Detail[]; pagination?: CoverPagination };
type Adapter = { search(query: string): Promise<SearchHit[]>; preview(id: string, page: number): Promise<DetailPage> };
type Row = Record<string, unknown>;
const row = (x: unknown): Row => x && typeof x === "object" && !Array.isArray(x) ? x as Row : {};
const rows = (x: unknown) => Array.isArray(x) ? x.map(row) : Object.values(row(x)).map(row);
const text = (x: unknown) => typeof x === "string" ? x.trim() : "";
const numericId = (x: unknown) => typeof x === "number" || typeof x === "string" ? String(x).match(/^[1-9]\d{0,14}$/)?.[0] ?? "" : "";
const names = (xs: unknown[]) => [...new Set(xs.map(text).filter(Boolean))].slice(0, 24);
const nameList = (xs: unknown) => names(rows(xs).map(x => x.name));
const join = (xs: unknown[]) => names(xs).join(" / ");
const releaseDate = (x: unknown) => {
  const d = text(x);
  return d && date.safeParse(d).success ? d : undefined;
};
const unixDate = (x: unknown) =>
  typeof x === "number" && Number.isInteger(x) && Math.abs(x) < 253402300799
    ? releaseDate(new Date(x * 1000).toISOString().slice(0, 10)) : undefined;
function fields(value: Partial<Metadata>) {
  return Object.fromEntries(Object.entries(value).filter(([field, v]) =>
    v && fieldValue(field as keyof Metadata, v))) as Partial<Metadata>;
}
function hits(provider: Provider, data: unknown, parse: (x: Row) => SearchHit): SearchHit[] {
  if (!Array.isArray(data)) throw invalidResponse(provider);
  const unique = new Map<string, SearchHit>();
  for (const entry of data) {
    const hit = parse(row(entry));
    if (hit.id && hit.title && !unique.has(hit.id)) unique.set(hit.id, hit);
    if (unique.size >= 12) break;
  }
  if (data.length && !unique.size) throw invalidResponse(provider);
  return [...unique.values()];
}
function queryUrl(base: string, params: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url;
}
function details(id: string, input: Partial<Metadata>): DetailPage {
  const result = fields(input);
  return { items: Object.keys(result).length ? [{ id, fields: result }] : [] };
}

function igdb(http: ProviderHttp, clientId: string, clientSecret: string): Adapter {
  let access: { token: string; expiresAt: number } | undefined;
  const obtainToken = async () => {
    if (access && access.expiresAt > Date.now()) return access.token;
    const response = row(await http.json("igdb", "https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" })
    }));
    const token = text(response.access_token), expires = response.expires_in;
    if (!token || typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) throw invalidResponse("igdb");
    access = { token, expiresAt: Date.now() + Math.max(0, expires - 60) * 1000 };
    return token;
  };
  const games = async (body: string) => {
    const request = (token: string) => http.json("igdb", "https://api.igdb.com/v4/games", {
      method: "POST", headers: { "Client-ID": clientId, Authorization: "Bearer " + token, "Content-Type": "text/plain" }, body
    });
    const token = await obtainToken();
    try { return await request(token); }
    catch (error) {
      // A revoked app token can be replaced once. Do not retry a quota or
      // transport failure; the local form remains independent.
      if (!(error instanceof MetadataError && error.status === 502 && error.upstreamStatus === 401)) throw error;
      access = undefined;
      return request(await obtainToken());
    }
  };
  const summary = "name,first_release_date,platforms.name,game_type.type";
  return {
    async search(query) {
      // Treat query only as literal text in the Apicalypse expression.
      const safeQuery = query.replace(/["\\;\p{Cc}]/gu, " ").trim();
      if (!safeQuery) return [];
      const data = await games('search "' + safeQuery + '"; fields ' + summary + '; limit 12;');
      return hits("igdb", data, g => ({
        id: numericId(g.id), title: text(g.name), date: unixDate(g.first_release_date),
        platforms: nameList(g.platforms), kind: text(row(g.game_type).type) || undefined
      }));
    },
    async preview(id) {
      const data = await games("fields name,summary,genres.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name; where id = " + id + "; limit 1;");
      if (!Array.isArray(data)) throw invalidResponse("igdb");
      const g = data.map(row).find(item => numericId(item.id) === id);
      if (!g) return { items: [] };
      const companies = rows(g.involved_companies);
      return details(id, {
        title: text(g.name), description: text(g.summary), genre: join(nameList(g.genres)),
        developer: join(companies.filter(c => c.developer === true).map(c => row(c.company).name)),
        publisher: join(companies.filter(c => c.publisher === true).map(c => row(c.company).name))
      });
    }
  };
}

function rawg(http: ProviderHttp, key: string): Adapter {
  const request = (path: string, params: Record<string, string> = {}, notFound = false) =>
    http.json("rawg", queryUrl("https://api.rawg.io/api/games" + path, { key, ...params }), {}, notFound);
  return {
    async search(query) {
      const data = row(await request("", { search: query, page_size: "12" }));
      return hits("rawg", data.results, g => ({
        id: numericId(g.id), title: text(g.name), date: releaseDate(g.released),
        platforms: names(rows(g.platforms).map(p => row(p.platform).name))
      }));
    },
    async preview(id) {
      const g = row(await request("/" + id, {}, true));
      if (numericId(g.id) !== id) return { items: [] };
      const description = text(g.description_raw) ||
        text(g.description).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
      return details(id, {
        title: text(g.name), originalTitle: text(g.name_original), description,
        genre: join(nameList(g.genres)), developer: join(nameList(g.developers)), publisher: join(nameList(g.publishers))
      });
    }
  };
}

function thegamesdb(http: ProviderHttp, key: string): Adapter {
  const provider = "thegamesdb";
  const request = async (path: string, params: Record<string, string> = {}, notFound = false) => {
    const data = await http.json(provider, queryUrl("https://api.thegamesdb.net/" + path, { apikey: key, ...params }), {}, notFound);
    if (data === null) return null;
    const result = row(data);
    const code = Number(result.code);
    if (code && code !== 200) {
      if (code === 404 && notFound) return null;
      throw upstreamError(provider, code);
    }
    return result;
  };
  const dictionaries = new Map<string, { expiresAt: number; values: Row }>();
  async function lookup(path: "Genres" | "Developers" | "Publishers", ids: unknown) {
    if (!Array.isArray(ids) || !ids.length) return "";
    let cached = dictionaries.get(path);
    if (!cached || cached.expiresAt <= Date.now()) {
      const data = row((await request("v1/" + path))?.data);
      const values = row(data[path.toLowerCase()]);
      if (!Object.keys(values).length && data.count !== 0) throw invalidResponse(provider);
      cached = { expiresAt: Date.now() + 3600000, values };
      dictionaries.set(path, cached);
    }
    return join(ids.map(id => row(cached.values[numericId(id)]).name));
  }
  return {
    async search(query) {
      const r = await request("v1.1/Games/ByGameName", { name: query, include: "platform" }, true);
      if (!r) return [];
      const platforms = row(row(row(r.include).platform).data);
      return hits(provider, row(r.data).games, g => ({
        id: numericId(g.id), title: text(g.game_title), date: releaseDate(g.release_date),
        platforms: names([row(platforms[numericId(g.platform)]).name])
      }));
    },
    async preview(id) {
      const r = await request("v1/Games/ByGameID", { id, fields: "overview,genres,publishers,developers" }, true);
      if (!r) return { items: [] };
      const g = rows(row(r.data).games).find(item => numericId(item.id) === id);
      if (!g) return { items: [] };
      const [genre, developer, publisher] = await Promise.all([
        lookup("Genres", g.genres), lookup("Developers", g.developers), lookup("Publishers", g.publishers)
      ]);
      return details(id, { title: text(g.game_title), description: text(g.overview), genre, developer, publisher });
    }
  };
}

function screenscraper(http: ProviderHttp, credentials: Record<string, string>): Adapter {
  const provider = "screenscraper";
  const request = async (path: string, params: Record<string, string>) => {
    const data = await http.json(provider, queryUrl("https://api.screenscraper.fr/api2/" + path + ".php", { ...credentials, ...params, output: "json" }), {}, true);
    if (data === null) return null;
    const response = row(row(data).response);
    if (!Object.keys(response).length) throw invalidResponse(provider);
    return response;
  };
  const entry = (x: unknown) => text(x) || text(row(x).text);
  const localized = (value: unknown, key: "region" | "langue", order: string[], prefix: string) => {
    const options = rows(value);
    for (const code of order) {
      const match = options.find(option => option[key] === code && entry(option));
      const found = entry(match) || entry(row(value)[prefix + "_" + code]);
      if (found) return found;
    }
    return entry(options.find(option => entry(option))) || entry(Object.values(row(value))[0]);
  };
  const regions = ["ss", "wor", "us", "eu", "jp"];
  const languages = ["zh", "en", "fr"];
  const title = (g: Row) => entry(g.nom) || localized(g.noms, "region", regions, "nom");
  const synopsis = (g: Row) => localized(g.synopsis, "langue", languages, "synopsis");
  function genres(g: Row) {
    if (!Array.isArray(g.genres)) {
      const translated = row(g.genres);
      for (const lang of languages) {
        const list = translated["genres_" + lang];
        if (Array.isArray(list)) return join(list.map(v => entry(v) || entry(row(v)["genre_" + lang])));
      }
    }
    return join(rows(g.genres).map(v => localized(v.noms, "langue", languages, "nom") || entry(v.nom) || entry(v)));
  }
  return {
    async search(query) {
      const r = await request("jeuRecherche", { recherche: query });
      if (!r) return [];
      return hits(provider, r.jeux, g => {
        const dateValue = localized(g.dates, "region", regions, "date");
        const region = text(rows(g.dates).find(d => entry(d) === dateValue)?.region);
        return {
          id: numericId(g.id), title: title(g), date: releaseDate(dateValue),
          platforms: names([entry(row(g.systeme).nom)]), region: region || undefined
        };
      });
    },
    async preview(id) {
      const r = await request("jeuInfos", { gameid: id });
      if (!r) return { items: [] };
      const g = row(r.jeu);
      if (numericId(g.id) !== id) return { items: [] };
      return details(id, {
        title: title(g), description: synopsis(g), developer: entry(g.developpeur), publisher: entry(g.editeur), genre: genres(g)
      });
    }
  };
}

function steamgriddb(http: ProviderHttp, key: string): Adapter {
  const provider = "steamgriddb";
  const pageSize = 12;
  const integer = (value: unknown) => {
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const request = async (path: string, params: Record<string, string> = {}): Promise<Row & { data: unknown[] }> => {
    const data = await http.json(provider, queryUrl("https://www.steamgriddb.com/api/v2/" + path, params),
      { headers: { Authorization: "Bearer " + key } }, true);
    if (data === null) return { data: [] };
    const r = row(data);
    if (r.success !== true || !Array.isArray(r.data)) throw invalidResponse(provider);
    return { ...r, data: r.data };
  };
  return {
    async search(query) {
      const { data } = await request("search/autocomplete/" + encodeURIComponent(query));
      return hits(provider, data, g => ({ id: numericId(g.id), title: text(g.name), date: unixDate(g.release_date), platforms: [] }));
    },
    async preview(gameId, page) {
      const response = await request("grids/game/" + gameId, {
        dimensions: "600x900,342x482,660x930", types: "static", nsfw: "false", humor: "false", epilepsy: "false",
        limit: String(pageSize), page: String(page)
      });
      const { data } = response;
      if (data.length > pageSize || (response.page !== undefined && integer(response.page) !== page) ||
        (response.limit !== undefined && integer(response.limit) !== pageSize)) throw invalidResponse(provider);
      // Page boundaries come from upstream, not the number of usable cards
      // remaining after validating URLs, dimensions and content tags.
      const total = integer(response.total);
      const totalPages = total !== null && (!data.length || total >= page * pageSize + data.length)
        ? Math.max(1, Math.ceil(total / pageSize)) : null;
      const covers = new Map<string, Detail>();
      for (const g of data.map(row)) {
        const id = numericId(g.id), coverUrl = text(g.url), thumbnail = text(g.thumb);
        const width = Number(g.width), height = Number(g.height);
        const hasDimensions = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
        if (!id || !isGridImage(coverUrl) || (hasDimensions && height <= width) ||
          g.nsfw === true || g.humor === true || g.epilepsy === true) continue;
        covers.set(id, { id, fields: { coverUrl }, image: {
          ...(hasDimensions ? { width, height } : {}), thumbnail: isGridImage(thumbnail) ? thumbnail : coverUrl
        } });
      }
      return { items: [...covers.values()], pagination: { page, pageSize, totalPages,
        hasNext: totalPages === null ? data.length === pageSize : page + 1 < totalPages } };
    }
  };
}

export function makeAdapters(env: Readonly<Record<string, string | undefined>>, http: ProviderHttp): Partial<Record<Provider, Adapter>> {
  const val = (name: string) => env[name]?.trim() ?? "";
  const adapters: Partial<Record<Provider, Adapter>> = {};
  const clientId = val("IGDB_CLIENT_ID"), clientSecret = val("IGDB_CLIENT_SECRET");
  if (clientId && clientSecret) adapters.igdb = igdb(http, clientId, clientSecret);
  const rawgKey = val("RAWG_API_KEY");
  if (rawgKey) adapters.rawg = rawg(http, rawgKey);
  const tgdbKey = val("THEGAMESDB_API_KEY");
  if (tgdbKey) adapters.thegamesdb = thegamesdb(http, tgdbKey);
  const devid = val("SCREENSCRAPER_DEV_ID"), devpassword = val("SCREENSCRAPER_DEV_PASSWORD");
  const ssid = val("SCREENSCRAPER_USERNAME"), sspassword = val("SCREENSCRAPER_PASSWORD");
  if (devid && devpassword && !!ssid === !!sspassword) {
    adapters.screenscraper = screenscraper(http, { devid, devpassword, softname: val("SCREENSCRAPER_SOFTNAME") || "GameShelf",
      ...(ssid ? { ssid, sspassword } : {}) });
  }
  const sgdbKey = val("STEAMGRIDDB_API_KEY");
  if (sgdbKey) adapters.steamgriddb = steamgriddb(http, sgdbKey);
  return adapters;
}

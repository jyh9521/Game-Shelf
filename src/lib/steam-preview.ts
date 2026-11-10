import { z } from "zod";
import { invalidResponse, MetadataError, ProviderHttp } from "./metadata-http";

type SteamGame = { appid: number; title: string; playtimeMinutes: number | null };
export type SteamPreview = { state: "listed"; items: SteamGame[]; skipped: number }
  | { state: "no_visible_games" };

const request = z.object({
  steamId: z.string().trim().regex(/^[1-9][0-9]{16}$/, "SteamID64 应为 17 位数字")
}).strict();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function readSteamPreview(payload: unknown): SteamPreview {
  if (!object(payload) || !object(payload.response)) throw invalidResponse("steam");
  const { games, game_count: count } = payload.response;
  if (count !== undefined && !uint32(count)) throw invalidResponse("steam");
  if (games === undefined && (count === 0 || Object.keys(payload.response).length === 0))
    return { state: "no_visible_games" };
  if (!Array.isArray(games) || (count === 0 && games.length > 0) || (count && games.length === 0))
    throw invalidResponse("steam");
  if (!games.length) return { state: "no_visible_games" };
  const unique = new Map<number, SteamGame>();
  for (const game of games) {
    if (!object(game) || !uint32(game.appid) || game.appid === 0 || unique.has(game.appid)) continue;
    const title = typeof game.name === "string" ? game.name.trim().slice(0, 500) : "";
    unique.set(game.appid, {
      appid: game.appid, title: title || "AppID " + game.appid,
      playtimeMinutes: uint32(game.playtime_forever) ? game.playtime_forever : null
    });
  }
  if (!unique.size) throw invalidResponse("steam");
  return { state: "listed", items: [...unique.values()].sort((a, b) => a.appid - b.appid), skipped: games.length - unique.size };
}

export const steamPreviewConfigured = () => Boolean(process.env.STEAM_WEB_API_KEY?.trim());

export async function previewSteamLibrary(input: unknown, key = process.env.STEAM_WEB_API_KEY, fetcher = fetch): Promise<SteamPreview> {
  const { steamId } = request.parse(input);
  const apiKey = key?.trim();
  if (!apiKey) throw new MetadataError(503, "Steam 预览未配置。请在服务器设置 STEAM_WEB_API_KEY。");
  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  // Steam expects a uint64 JSON number. The validated digit string must not
  // pass through Number, which rounds these IDs above MAX_SAFE_INTEGER.
  url.searchParams.set("input_json", `{"steamid":${steamId},"include_appinfo":true,"include_played_free_games":true}`);
  return readSteamPreview(await new ProviderHttp(fetcher).json("steam", url, { headers: { "x-webapi-key": apiKey } }));
}

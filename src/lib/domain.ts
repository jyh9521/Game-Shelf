import { z } from "zod";
export const statuses = ["UNPLAYED", "PLAYING", "CLEARED", "COMPLETED", "ON_HOLD", "DROPPED", "BACKLOG"] as const;
export const mediaTypes = ["PHYSICAL", "DIGITAL", "OTHER", "UNKNOWN"] as const;
export const acquisitions = ["PURCHASE", "GIFT", "FREE", "SUBSCRIPTION", "FAMILY_SHARED", "BORROWED", "OTHER", "UNKNOWN"] as const;
export const accessStatuses = ["ACTIVE", "EXPIRED", "RETURNED", "REVOKED", "UNKNOWN"] as const;
export const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const text = (max = 500) => z.string().max(max);
export const date = text(10).refine(v => {
  if (!v) return true;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return false;
  const [y,m,d] = v.split("-").map(Number);
  if (y < 1 || y > 9999 || (m !== undefined && (m < 1 || m > 12))) return false;
  const days = m === 2 ? ((y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28) : ([4,6,9,11].includes(m) ? 30 : 31);
  return d === undefined || (d > 0 && d <= days);
}, "发行日期须为有效的年、年月或年月日");
export const ownershipInput = z.object({
  platformId: text(80).min(1), storeId: text(80).nullable().default(null),
  releaseDate: date.default(""), region: text(80).default(""), edition: text(120).default(""),
  mediaType: z.enum(mediaTypes).default("DIGITAL"), acquisitionType: z.enum(acquisitions).default("PURCHASE"),
  accessStatus: z.enum(accessStatuses).default("ACTIVE"),
  manualTotalOverride: z.number().int().min(0).max(2147483647).nullable().default(null),
  manualExtraSeconds: z.number().int().min(0).max(2147483647).default(0)
}).strict();
export const gameInput = z.object({
  title: text().trim().min(1), originalTitle: text().default(""), localizedTitle: text().default(""),
  description: text(20000).default(""), developer: text().default(""), publisher: text().default(""),
  genre: text().default(""), coverUrl: text(2000).refine(v => !v || /^https?:\/\//.test(v), "封面须为 http(s) 地址").default(""),
  status: z.enum(statuses).default("UNPLAYED"), rating: z.number().int().min(1).max(5).nullable().default(null),
  favorite: z.boolean().default(false), memo: text(20000).default("")
}).strict();
export const releaseInput=ownershipInput.pick({platformId:true,releaseDate:true,region:true,edition:true});
export const createInput = gameInput.extend({ ownership: ownershipInput });
export function effectiveSeconds(item: { sourceTotalSeconds: number | null; manualTotalOverride: number | null; manualExtraSeconds: number }) {
  const base = item.manualTotalOverride ?? item.sourceTotalSeconds;
  return base === null ? null : base + item.manualExtraSeconds;
}
export const defaultPlatforms = [
  ["PC", "PC"], ["NS1", "Nintendo Switch"], ["NS2", "Nintendo Switch 2"],
  ["PS1", "PlayStation"], ["PS2", "PlayStation 2"], ["PS3", "PlayStation 3"], ["PS4", "PlayStation 4"], ["PS5", "PlayStation 5"],
  ["XBOX", "Xbox"], ["XBOX360", "Xbox 360"], ["XBOXONE", "Xbox One"], ["XBOXSERIES", "Xbox Series X|S"],
  ["GC", "GameCube"], ["GBA", "Game Boy Advance"], ["NDS", "Nintendo DS"], ["OTHER", "其他 / 未确认"]
];
export const defaultStores = [["STEAM","Steam"],["GOG","GOG"],["EPIC","Epic Games Store"],["NINTENDO","Nintendo eShop"],["PSN","PlayStation Store"],["XBOX","Xbox Store"],["PHYSICAL","实体渠道"]];

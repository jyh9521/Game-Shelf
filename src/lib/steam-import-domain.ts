import { z } from "zod";
export const steamIdSchema = z.string().regex(/^[1-9][0-9]{16}$/);
export const appidSchema = z.number().int().min(1).max(0xffffffff);
export const steamImportInput = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
  choices: z.array(z.object({ appid: appidSchema, gameId: z.string().min(1).max(100).nullable() }).strict()).min(1).max(100)
}).strict().refine(value => new Set(value.choices.map(c => c.appid)).size === value.choices.length, "AppID 重复");
export const steamLinkRecord = z.object({
  id: z.string().min(1).max(100), steamId: steamIdSchema, appid: appidSchema,
  gameId: z.string().min(1).max(100), libraryItemId: z.string().min(1).max(100), createdAt: z.iso.datetime()
}).strict();
export const sourceSeconds = (minutes: number | null) =>
  minutes !== null && Number.isInteger(minutes) && minutes >= 0 && minutes * 60 <= 2147483647 ? minutes * 60 : null;

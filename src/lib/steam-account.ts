import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { hashToken } from "./auth";
import { MetadataError } from "./metadata-http";
import { steamLoginUrl, verifySteamIdentity } from "./steam-identity";

export const steamAccount = (userId: string) => db.steamAccount.findUnique({ where: { userId }, select: { steamId: true, verifiedAt: true } });
export function steamAppOrigin() {
  try {
    const url = new URL(process.env.APP_URL ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error();
    return url.origin;
  } catch { throw new MetadataError(503, "连接 Steam 前请设置 APP_URL 为浏览器访问本站的完整地址（不含路径）。"); }
}
export async function startSteamConnection(userId: string, session: string) {
  const origin = steamAppOrigin(), state = randomBytes(32).toString("hex");
  const returnTo = origin + "/steam/callback?state=" + state;
  await db.$transaction(async tx => {
    await tx.steamAuthAttempt.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
    await tx.steamAuthAttempt.create({ data: { stateHash: hashToken(state), userId, sessionHash: hashToken(session), returnTo,
      expiresAt: new Date(Date.now() + 600000) } });
  });
  return { url: steamLoginUrl(returnTo) };
}
export async function completeSteamConnection(userId: string, session: string, input: unknown) {
  const { query } = z.object({ query: z.string().max(16000) }).strict().parse(input);
  const params = new URLSearchParams(query), state = params.get("state");
  if (!state || !/^[a-f0-9]{64}$/.test(state)) throw new MetadataError(400, "Steam 验证请求无效。");
  const attempt = await db.steamAuthAttempt.findUnique({ where: { stateHash: hashToken(state) } });
  if (!attempt || attempt.userId !== userId || attempt.sessionHash !== hashToken(session) || attempt.expiresAt.getTime() < Date.now())
    throw new MetadataError(400, "验证已过期或登录会话已变化，请重新连接 Steam。");
  const steamId = await verifySteamIdentity(params, attempt.returnTo);
  return db.$transaction(async tx => {
    const used = await tx.steamAuthAttempt.deleteMany({ where: { stateHash: attempt.stateHash, expiresAt: { gt: new Date() } } });
    if (!used.count) throw new MetadataError(409, "验证请求已经使用，请重新连接。");
    await tx.steamImportPreview.deleteMany({ where: { userId } });
    return tx.steamAccount.upsert({ where: { userId }, create: { userId, steamId, verifiedAt: new Date() }, update: { steamId, verifiedAt: new Date() } });
  });
}
export async function disconnectSteam(userId: string) {
  await db.$transaction(async tx => {
    await tx.steamAuthAttempt.deleteMany({ where: { userId } });
    await tx.steamImportPreview.deleteMany({ where: { userId } });
    await tx.steamAccount.deleteMany({ where: { userId } });
  });
  return { ok: true };
}

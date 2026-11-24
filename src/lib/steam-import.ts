import { randomBytes, randomUUID } from "node:crypto";
import { db } from "./db";
import { hashToken } from "./auth";
import { MetadataError } from "./metadata-http";
import { previewSteamLibrary } from "./steam-preview";
import { compareSteamLibraryForUser } from "./steam-library-service";
import { type SteamComparison } from "./steam-library-match";
import { sourceSeconds, steamImportInput } from "./steam-import-domain";
import { addOwnership } from "./library";
import { gameInput, ownershipInput } from "./domain";
import { metadataOf, searchTextOf } from "./metadata-domain";

export async function prepareSteamImport(userId: string) {
  const account = await db.steamAccount.findUnique({ where: { userId } });
  if (!account) throw new MetadataError(409, "请先通过 Steam 登录验证账号。");
  const comparison = await compareSteamLibraryForUser(userId, await previewSteamLibrary({ steamId: account.steamId }));
  if (comparison.state !== "listed") return comparison;
  const token = randomBytes(32).toString("hex"), expiresAt = new Date(Date.now() + 600000);
  return db.$transaction(async tx => {
    const current = await tx.steamAccount.findUnique({ where: { userId } });
    if (!current || current.steamId !== account.steamId || current.verifiedAt.getTime() !== account.verifiedAt.getTime())
      throw new MetadataError(409, "账号连接已改变，请重新预览。");
    await tx.steamImportPreview.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
    await tx.steamImportPreview.create({ data: { tokenHash: hashToken(token), userId, steamId: account.steamId,
      payloadJson: JSON.stringify(comparison), expiresAt } });
    const links = await tx.steamImportLink.findMany({ where: { userId, steamId: account.steamId }, select: { appid: true, gameId: true } });
    return { ...comparison, token, steamId: account.steamId, expiresAt: expiresAt.toISOString(), links: links.map(link => ({ ...link, appid: Number(link.appid) })) };
  });
}
export async function importSteamGames(userId: string, raw: unknown) {
  const input = steamImportInput.parse(raw);
  return db.$transaction(async tx => {
    const preview = await tx.steamImportPreview.findUnique({ where: { tokenHash: hashToken(input.token) } });
    const account = await tx.steamAccount.findUnique({ where: { userId } });
    if (!preview || preview.userId !== userId || preview.expiresAt.getTime() < Date.now() || !account || account.steamId !== preview.steamId)
      throw new MetadataError(409, "导入预览已失效，请重新预览已验证账号。");
    const comparison = JSON.parse(preview.payloadJson) as Extract<SteamComparison, { state: "listed" }>;
    const rows = new Map(comparison.items.map(row => [row.appid, row]));
    let created = 0, duplicate = 0;
    const items: { appid: number; gameId: string; libraryItemId: string }[] = [];
    for (const choice of input.choices) {
      const row = rows.get(choice.appid);
      if (!row) throw new MetadataError(400, "所选 AppID 不在本次可见清单中。");
      const key = { userId, steamId: account.steamId, appid: BigInt(choice.appid) };
      const existing = await tx.steamImportLink.findUnique({ where: { userId_steamId_appid: key } });
      if (existing) {
        if (choice.gameId && choice.gameId !== existing.gameId) throw new MetadataError(409, "AppID 已关联其他作品，请勿重复关联。");
        items.push({ appid: Number(existing.appid), gameId: existing.gameId, libraryItemId: existing.libraryItemId }); duplicate++; continue;
      }
      let gameId = choice.gameId;
      if (gameId) {
        if (!await tx.userGameProfile.findUnique({ where: { userId_gameId: { userId, gameId } } }))
          throw new MetadataError(404, "选择的本人作品已不存在，请重新预览。");
      } else {
        if (!row.titleAvailable) throw new MetadataError(400, "缺少 Steam 标题，请选择本人已有作品。");
        gameId = randomUUID();
        const values = metadataOf(gameInput.parse({ title: row.title })), searchText = searchTextOf(values), now = new Date();
        await tx.game.create({ data: { id: gameId, ...values, searchText } });
        await tx.userGameProfile.create({ data: { id: randomUUID(), userId, gameId,
          metadata: { create: { ...values, searchText, updatedAt: now } } } });
      }
      // Catalogue IDs may have been renamed; never silently reuse a non-PC ID.
      const platform = await tx.platform.findUnique({ where: { name: "PC" } });
      const store = await tx.store.findUnique({ where: { name: "Steam" } });
      if (!platform || !store) throw new MetadataError(409, "请先在目录中保留名为 PC 的平台和 Steam 商店，再导入。");
      const item = await addOwnership(tx, userId, gameId, ownershipInput.parse({ platformId: platform.id, storeId: store.id,
        mediaType: "DIGITAL", acquisitionType: "UNKNOWN", accessStatus: "ACTIVE" }));
      await tx.libraryItem.update({ where: { id: item.id }, data: { sourceTotalSeconds: sourceSeconds(row.playtimeMinutes) } });
      await tx.steamImportLink.create({ data: { id: randomUUID(), ...key, gameId, libraryItemId: item.id } });
      items.push({ appid: choice.appid, gameId, libraryItemId: item.id }); created++;
    }
    return { created, duplicate, items };
  }, { timeout: 30000 });
}

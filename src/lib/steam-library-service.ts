import { db } from "./db";
import { compareSteamLibrary } from "./steam-library-match";
import type { SteamPreview } from "./steam-preview";

export async function compareSteamLibraryForUser(userId: string, preview: SteamPreview) {
  if (preview.state !== "listed") return preview;
  const titles = { title: true, originalTitle: true, localizedTitle: true } as const;
  const profiles = await db.userGameProfile.findMany({
    where: { userId }, select: {
      gameId: true, metadata: { select: titles },
      game: { select: { ...titles, releases: {
        where: { contents: { some: { item: { userId } } } }, select: { platform: { select: { name: true } } }
      } } }
    }
  });
  return compareSteamLibrary(preview, profiles.map(p => {
    const { title, originalTitle, localizedTitle } = p.metadata ?? p.game;
    return { gameId: p.gameId, title, originalTitle, localizedTitle,
      platforms: p.game.releases.map(r => r.platform.name) };
  }));
}

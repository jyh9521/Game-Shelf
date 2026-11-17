import type { SteamGame, SteamPreview } from "./steam-preview";

export const titleFields = ["title", "originalTitle", "localizedTitle"] as const;
export type TitleField = typeof titleFields[number];
export type LocalSteamCandidate = Record<TitleField, string> & { gameId: string; platforms: string[] };
export type SteamCandidate = LocalSteamCandidate & { matchedFields: TitleField[] };
export const matchStates = ["single_candidate", "multiple_candidates", "no_candidate", "missing_title"] as const;
export type MatchState = typeof matchStates[number];
export const matchLabels: Record<MatchState, string> = {
  single_candidate: "单候选 · 待确认", multiple_candidates: "多候选 · 待确认",
  no_candidate: "未找到候选", missing_title: "缺少标题"
};
export const titleFieldLabels: Record<TitleField, string> = {
  title: "标题", originalTitle: "原名", localizedTitle: "本地化标题"
};
export const candidateLimit = 5;
export type ComparedSteamGame = SteamGame & {
  match: { state: MatchState; candidateCount: number; candidates: SteamCandidate[] }
};
export type SteamComparison = { state: "no_visible_games" } | {
  state: "listed"; skipped: number; items: ComparedSteamGame[]; summary: Record<MatchState, number>
};

// Only normalize presentation: do not remove punctuation, edition/remake words,
// numerals or accents. Even an exact title is a candidate, never an identity.
export const normalizeSteamTitle = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function compareSteamLibrary(preview: SteamPreview, library: LocalSteamCandidate[]): SteamComparison {
  if (preview.state !== "listed") return preview;
  const index = new Map<string, Map<string, SteamCandidate>>();
  for (const game of library) {
    for (const field of titleFields) {
      const title = normalizeSteamTitle(game[field]);
      if (!title) continue;
      let entries = index.get(title);
      if (!entries) index.set(title, entries = new Map());
      const previous = entries.get(game.gameId);
      if (previous) { if (!previous.matchedFields.includes(field)) previous.matchedFields.push(field); }
      else entries.set(game.gameId, { ...game, platforms: [...new Set(game.platforms)].sort(), matchedFields: [field] });
    }
  }
  // Bound each response row even when a local library contains many homonyms.
  const candidates = new Map([...index].map(([title, entries]) => [title, {
    count: entries.size,
    items: [...entries.values()].sort((a, b) => a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0).slice(0, candidateLimit)
  }]));
  const summary: Record<MatchState, number> = { single_candidate: 0, multiple_candidates: 0, no_candidate: 0, missing_title: 0 };
  const items = preview.items.map(game => {
    const found = game.titleAvailable ? candidates.get(normalizeSteamTitle(game.title)) : undefined;
    const count = found?.count ?? 0;
    const state: MatchState = !game.titleAvailable ? "missing_title" : count > 1 ? "multiple_candidates" : count === 1 ? "single_candidate" : "no_candidate";
    summary[state]++;
    return { ...game, match: { state, candidateCount: count, candidates: found?.items ?? [] } };
  });
  return { ...preview, items, summary };
}

// Filtering is local: it must not re-request Steam or silently change the total.
export function filterSteamComparisons(items: ComparedSteamGame[], query: string, state: MatchState | "all") {
  const q = normalizeSteamTitle(query);
  return items.filter(game => (state === "all" || game.match.state === state) && (!q ||
    [String(game.appid), game.title, ...game.match.candidates.flatMap(c => titleFields.map(field => c[field]))]
      .some(value => normalizeSteamTitle(value).includes(q))));
}

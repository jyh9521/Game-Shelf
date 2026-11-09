import { z } from "zod";
import { gameInput, createInput, normalize } from "./domain";

export const metadataFields = ["title", "originalTitle", "localizedTitle", "developer", "publisher", "genre", "description", "coverUrl"] as const;
export type MetadataField = typeof metadataFields[number];
export type Metadata = Record<MetadataField, string>;
export const fieldLabels: Record<MetadataField, string> = {
  title: "游戏标题", originalTitle: "原始标题", localizedTitle: "本地化标题", developer: "开发商",
  publisher: "发行商", genre: "类型", description: "简介", coverUrl: "封面"
};
export const providers = ["igdb", "rawg", "thegamesdb", "screenscraper", "steamgriddb"] as const;
export type Provider = typeof providers[number];
export const providerLabels: Record<Provider, string> = {
  igdb: "IGDB", rawg: "RAWG", thegamesdb: "TheGamesDB", screenscraper: "ScreenScraper", steamgriddb: "SteamGridDB"
};
export function providerLink(provider: Provider, id?: string): string {
  switch (provider) {
    case "igdb": return "https://www.igdb.com/";
    case "rawg": return "https://rawg.io/";
    case "thegamesdb": return id ? "https://thegamesdb.net/game.php?id=" + encodeURIComponent(id) : "https://thegamesdb.net/";
    case "screenscraper": return id ? "https://www.screenscraper.fr/gameinfos.php?gameid=" + encodeURIComponent(id) : "https://www.screenscraper.fr/";
    case "steamgriddb": return id ? "https://www.steamgriddb.com/grid/" + encodeURIComponent(id) : "https://www.steamgriddb.com/";
  }
}
const gridImageOrigins = new Set(["https://cdn.steamgriddb.com", "https://cdn2.steamgriddb.com"]);
export function isGridImage(value: string) {
  try {
    const url = new URL(value);
    return gridImageOrigins.has(url.origin) && !url.username && !url.password &&
      !url.search && !url.hash && /^\/(?:grid|thumb)\/[a-zA-Z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(url.pathname);
  } catch { return false; }
}

const field = z.enum(metadataFields);
const provider = z.enum(providers);
const externalId = z.string().regex(/^[1-9]\d{0,14}$/);
const revision = z.number().int().min(0).max(2147483647);
const chosen = z.object({ token: z.uuid(), fields: z.array(field).min(1).max(metadataFields.length) }).strict();
const selectionInput = {
  candidates: z.array(chosen).max(metadataFields.length).default([]),
  manualFields: z.array(field).max(metadataFields.length).default([])
};
export const createGameInput = createInput.extend(selectionInput);
export const updateGameInput = gameInput.extend({ ...selectionInput, revision: revision.optional() });
export const unlockInput = z.object({ field, revision }).strict();
export const searchInput = z.object({ provider, query: z.string().trim().min(1).max(150) }).strict();
export const previewInput = z.object({ provider, id: externalId }).strict();
export type Selection = z.infer<typeof chosen>;

export const sourceRecord = z.object({
  provider, externalId, value: z.string().min(1).max(20000), collectedAt: z.iso.datetime()
}).strict();
export type Source = z.infer<typeof sourceRecord>;
export const fieldActions = ["MANUAL", "SOURCE", "UNLOCK"] as const;
export type FieldAction = typeof fieldActions[number];
export function fieldValue(field: MetadataField, value: unknown): value is string {
  // Defaults are permitted on game input, not on individual values or history.
  if (typeof value !== "string") return false;
  const parsed = gameInput.shape[field].safeParse(value);
  return parsed.success && parsed.data === value;
}
export const fieldEventRecord = z.object({
  id: z.string().min(1).max(100), gameId: z.string().min(1).max(100), field, revision: revision.min(1),
  action: z.enum(fieldActions), previousValue: z.string().max(20000).nullable(), value: z.string().max(20000),
  locked: z.boolean(), source: sourceRecord.nullable(), createdAt: z.iso.datetime()
}).strict().superRefine((event, ctx) => {
  const fail = (path: string) => ctx.addIssue({ code: "custom", path: [path], message: "字段历史与候选资料不一致" });
  if (!fieldValue(event.field, event.value)) fail("value");
  if (event.previousValue !== null && !fieldValue(event.field, event.previousValue)) fail("previousValue");
  const source = event.source;
  if (source && (!fieldValue(event.field, source.value) || source.collectedAt > event.createdAt ||
    (source.provider === "steamgriddb" ? event.field !== "coverUrl" || !isGridImage(source.value) : event.field === "coverUrl"))) fail("source");
  if (event.action === "SOURCE" && !source) fail("source");
  if ((event.action === "MANUAL" && !event.locked) || (event.action === "UNLOCK" && (event.locked || event.previousValue === null))) fail("locked");
  if (!event.locked && source && event.value !== source.value) fail("value");
  if (event.action === "UNLOCK" && !source && event.value !== event.previousValue) fail("value");
});
export type FieldEvent = z.infer<typeof fieldEventRecord>;
export type FieldSources = Partial<Record<MetadataField, Source>>;
export type FieldState = { field: MetadataField; value: string; locked: boolean; source: Source | null };
export type FieldReport = { revision: number; fields: FieldState[]; history: FieldEvent[] };
export type SearchHit = { id: string; title: string; platforms: string[]; date?: string; kind?: string; region?: string };
export type Candidate = { provider: Provider; externalId: string; fields: Partial<Metadata>; collectedAt: string };
export type Preview = { candidate: Candidate; token: string; image?: { thumbnail: string; width?: number; height?: number } };
export type ProviderStatus = { id: Provider; enabled: boolean };

export function metadataOf(value: Metadata): Metadata {
  return Object.fromEntries(metadataFields.map(key => [key, value[key]])) as Metadata;
}
export const searchTextOf = (m: Metadata) => normalize([m.title, m.originalTitle, m.localizedTitle, m.developer, m.publisher].join(" "));

export function lockedFields(json: string): Set<MetadataField> {
  try {
    const values = JSON.parse(json);
    return new Set(metadataFields.filter(key => values?.[key]?.mode === "MANUAL_OVERRIDE"));
  } catch { return new Set(); }
}
export function encodeLocks(locks: Set<MetadataField>, values: Metadata) {
  return JSON.stringify(Object.fromEntries(metadataFields.filter(field => locks.has(field)).map(field =>
    [field, { mode: "MANUAL_OVERRIDE", value: values[field] }])));
}
export function sameSource(a: Source | undefined | null, b: Source | undefined | null) {
  return !a && !b || !!a && !!b && a.provider === b.provider && a.externalId === b.externalId && a.value === b.value;
}

// Only an explicit field selection can set an automatic value. If the field
// was locked, accept the new candidate into history without applying it.
export function planMetadataSave(input: Metadata, before: Metadata | null, locks: Set<MetadataField>, sources: FieldSources,
  selected: FieldSources, manualFields: readonly MetadataField[] = []) {
  const values = metadataOf(input), nextLocks = new Set(locks);
  const events: Omit<FieldEvent, "id" | "gameId" | "revision" | "createdAt">[] = [];
  for (const field of metadataFields) {
    const previousValue = before?.[field] ?? null;
    const wasLocked = locks.has(field);
    const incoming = selected[field];
    const changedSource = !!incoming && !sameSource(incoming, sources[field]);
    const source = changedSource ? incoming : sources[field] ?? null;
    const value = input[field];
    if (!before) {
      if (incoming && incoming.value === value && !manualFields.includes(field)) nextLocks.delete(field);
      else if (value || incoming || manualFields.includes(field)) nextLocks.add(field);
    } else if (manualFields.includes(field) && (value !== previousValue || incoming)) {
      nextLocks.add(field);
    } else if (!wasLocked && incoming && value === previousValue) {
      values[field] = incoming.value;
    } else if (value !== previousValue && (wasLocked || !incoming || value !== incoming.value)) {
      nextLocks.add(field);
    }
    const locked = nextLocks.has(field);
    if (changedSource || (before ? values[field] !== previousValue || locked !== wasLocked : locked)) {
      events.push({ field, action: changedSource ? "SOURCE" : "MANUAL", previousValue, value: values[field], locked, source });
    }
  }
  return { values, locks: nextLocks, events };
}

export function validateFieldHistory(history: FieldEvent[], games: Map<string, Metadata>, profiles: Map<string, string>) {
  const latest = new Map<string, Map<MetadataField, FieldEvent>>();
  for (const event of [...history].sort((a, b) => a.revision - b.revision)) {
    if (!games.has(event.gameId) || !profiles.has(event.gameId)) throw new Error("字段历史缺少个人档案或作品");
    let fields = latest.get(event.gameId);
    if (!fields) latest.set(event.gameId, fields = new Map());
    const old = fields.get(event.field);
    if ((old && (old.revision === event.revision || old.value !== event.previousValue ||
      (event.action === "UNLOCK" && !old.locked))) ||
      (event.action === "SOURCE" ? sameSource(old?.source, event.source) :
        (!sameSource(old?.source, event.source) || old?.source?.collectedAt !== event.source?.collectedAt))) {
      throw new Error("字段历史重复或不连续");
    }
    fields.set(event.field, event);
  }
  for (const [gameId, fields] of latest) {
    const game = games.get(gameId)!;
    const locks = lockedFields(profiles.get(gameId)!);
    for (const e of fields.values()) {
      if (game[e.field] !== e.value || locks.has(e.field) !== e.locked) throw new Error("字段历史与当前资料或锁定状态不一致");
    }
  }
}

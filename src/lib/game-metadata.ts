import { randomUUID } from "node:crypto";
import type { Prisma, ProfileFieldHistory, UserGameProfile } from "@prisma/client";
import type { z } from "zod";
import { db } from "./db";
import { addOwnership } from "./library";
import { MetadataError } from "./metadata-http";
import { metadataService } from "./metadata-service";
import {
  createGameInput, updateGameInput, unlockInput, metadataFields, metadataOf, searchTextOf,
  lockedFields, encodeLocks, planMetadataSave, type Metadata, type FieldEvent, type FieldReport, type FieldSources
} from "./metadata-domain";

type Tx = Prisma.TransactionClient;
type Projection = Prisma.UserGameMetadataGetPayload<{}>;
export type PersonalProfile = UserGameProfile & { metadata: Projection | null };
type GameRow = Metadata & { id: string; updatedAt: Date; searchText: string };

export function effectiveGame<T extends GameRow>(game: T, profile: PersonalProfile) {
  const effective = profile.metadata ?? game;
  const { id, userId, gameId, status, rating, favorite, memo, overridesJson } = profile;
  return {
    ...game, ...metadataOf(effective), updatedAt: effective.updatedAt, searchText: effective.searchText,
    metadataRevision: profile.metadata?.revision ?? 0, rawgAttributed: profile.metadata?.rawgAttributed ?? false,
    profiles: [{ id, userId, gameId, status, rating, favorite, memo, overridesJson: encodeLocks(lockedFields(overridesJson), effective) }]
  };
}
export function serializeFieldEvent(event: ProfileFieldHistory, gameId: string): FieldEvent {
  const { profileId, sourceJson, createdAt, ...change } = event;
  return {
    ...change, gameId, field: change.field as FieldEvent["field"], action: change.action as FieldEvent["action"],
    createdAt: createdAt.toISOString(), source: sourceJson ? JSON.parse(sourceJson) : null
  };
}
export function fieldEventData(event: FieldEvent, profileId: string): Prisma.ProfileFieldHistoryCreateManyInput {
  const { gameId, source, createdAt, ...change } = event;
  return { ...change, profileId, sourceJson: source ? JSON.stringify(source) : null, createdAt: new Date(createdAt) };
}
async function latestSources(tx: Tx, profileId: string): Promise<FieldSources> {
  const latest = await tx.profileFieldHistory.groupBy({ by: ["field"], where: { profileId }, _max: { revision: true } });
  if (!latest.length) return {};
  const rows = await tx.profileFieldHistory.findMany({
    where: { profileId, OR: latest.map(r => ({ field: r.field, revision: r._max.revision! })) },
    select: { field: true, sourceJson: true }
  });
  return Object.fromEntries(rows.filter(row => row.sourceJson).map(row => [row.field, JSON.parse(row.sourceJson!)]));
}
async function getProfile(tx: Tx, userId: string, gameId: string) {
  const p = await tx.userGameProfile.findUnique({ where: { userId_gameId: { userId, gameId } }, include: { game: true, metadata: true } });
  if (!p) throw new MetadataError(404, "游戏不存在");
  return p;
}
function checkRevision(before: number, expected?: number) {
  if (expected !== undefined && before !== expected) throw new MetadataError(409, "作品资料已更新，请重新打开后再操作。");
}
function projection(values: Metadata, updatedAt: Date, revision: number, rawgAttributed: boolean) {
  return { ...values, searchText: searchTextOf(values), updatedAt, revision, rawgAttributed };
}
export async function createGame(userId: string, input: z.infer<typeof createGameInput>) {
  const selected = metadataService().resolve(userId, input.candidates);
  const plan = planMetadataSave(input, null, new Set(), {}, selected, input.manualFields);
  const { status, rating, favorite, memo, ownership } = input;
  return db.$transaction(async tx => {
    const id = randomUUID(), now = new Date(), revision = plan.events.length ? 1 : 0;
    const game = await tx.game.create({ data: { id, ...plan.values, searchText: searchTextOf(plan.values), createdAt: now, updatedAt: now } });
    const profile = await tx.userGameProfile.create({
      data: { id: randomUUID(), userId, gameId: id, status, rating, favorite, memo, overridesJson: encodeLocks(plan.locks, plan.values),
        metadata: { create: projection(plan.values, now, revision, plan.events.some(e => e.source?.provider === "rawg")) } },
      include: { metadata: true }
    });
    await tx.profileFieldHistory.createMany({ data: plan.events.map(e =>
      fieldEventData({ ...e, id: randomUUID(), gameId: id, revision, createdAt: now.toISOString() }, profile.id)) });
    await addOwnership(tx, userId, id, ownership);
    return effectiveGame(game, profile);
  });
}
export async function updateGame(userId: string, id: string, input: z.infer<typeof updateGameInput>) {
  if (input.candidates.length && input.revision === undefined) throw new MetadataError(400, "请重新打开编辑器后保存外部候选。");
  const selected = metadataService().resolve(userId, input.candidates);
  return db.$transaction(async tx => {
    const profile = await getProfile(tx, userId, id);
    const effective = profile.metadata ?? profile.game, oldRevision = profile.metadata?.revision ?? 0;
    checkRevision(oldRevision, input.revision);
    const sources = await latestSources(tx, profile.id);
    const plan = planMetadataSave(input, effective, lockedFields(profile.overridesJson), sources, selected, input.manualFields);
    const { status, rating, favorite, memo } = input;
    const changed = plan.events.length > 0, revision = oldRevision + Number(changed);
    const now = changed ? new Date() : effective.updatedAt;
    const data = projection(plan.values, now, revision, !!profile.metadata?.rawgAttributed || plan.events.some(e => e.source?.provider === "rawg"));
    const updated = await tx.userGameProfile.update({
      where: { id: profile.id },
      data: { status, rating, favorite, memo, overridesJson: encodeLocks(plan.locks, plan.values),
        ...(changed || !profile.metadata ? { metadata: { upsert: { create: data, update: data } } } : {}) },
      include: { metadata: true }
    });
    if (changed) await tx.profileFieldHistory.createMany({ data: plan.events.map(e =>
      fieldEventData({ ...e, id: randomUUID(), gameId: id, revision, createdAt: now.toISOString() }, profile.id)) });
    return effectiveGame(profile.game, updated);
  });
}
export async function reportFields(userId: string, id: string): Promise<FieldReport> {
  return db.$transaction(async tx => {
    const p = await getProfile(tx, userId, id);
    const values = p.metadata ?? p.game, locks = lockedFields(p.overridesJson), sources = await latestSources(tx, p.id);
    const history = await tx.profileFieldHistory.findMany({
      where: { profileId: p.id }, orderBy: [{ revision: "desc" }, { field: "asc" }], take: 40
    });
    return { revision: p.metadata?.revision ?? 0, history: history.map(e => serializeFieldEvent(e, id)),
      fields: metadataFields.map(field => ({ field, value: values[field], locked: locks.has(field), source: sources[field] ?? null })) };
  });
}
export async function unlockField(userId: string, id: string, input: z.infer<typeof unlockInput>) {
  return db.$transaction(async tx => {
    const p = await getProfile(tx, userId, id), { field } = input;
    const oldRevision = p.metadata?.revision ?? 0;
    checkRevision(oldRevision, input.revision);
    const locks = lockedFields(p.overridesJson);
    if (!locks.delete(field)) return { ok: true, revision: oldRevision };
    const values = metadataOf(p.metadata ?? p.game);
    const source = (await latestSources(tx, p.id))[field] ?? null;
    const previousValue = values[field];
    values[field] = source?.value ?? previousValue;
    const now = new Date(), revision = oldRevision + 1;
    const data = projection(values, now, revision, !!p.metadata?.rawgAttributed);
    await tx.userGameProfile.update({
      where: { id: p.id },
      data: { overridesJson: encodeLocks(locks, values), metadata: { upsert: { create: data, update: data } } }
    });
    await tx.profileFieldHistory.create({ data: fieldEventData({
      id: randomUUID(), gameId: id, field, revision, action: "UNLOCK", previousValue, value: values[field], source,
      locked: false, createdAt: now.toISOString()
    }, p.id) });
    return { ok: true, revision };
  });
}

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { db } from "./db";
import { RelationError, relationInput, relationEditInput, validateRelationGraph } from "./relation-domain";

async function requireGames(tx: Prisma.TransactionClient, userId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (await tx.userGameProfile.count({ where: { userId, gameId: { in: unique } } }) !== unique.length) {
    throw new RelationError("游戏不存在", 404);
  }
}
export async function listRelations(userId: string, gameId: string) {
  return db.$transaction(async tx => {
    await requireGames(tx, userId, [gameId]);
    const where = { userId, OR: [{ sourceGameId: gameId }, { targetGameId: gameId }],
      source: { profiles: { some: { userId } } }, target: { profiles: { some: { userId } } } };
    const relations = await tx.gameRelation.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const history = await tx.gameRelationEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { revision: "desc" }, { id: "asc" }], take: 100 });
    const ids = [...new Set([...relations, ...history].flatMap(r => [r.sourceGameId, r.targetGameId]))];
    const titleFields = { title: true, localizedTitle: true } as const;
    const profiles = await tx.userGameProfile.findMany({
      where: { userId, gameId: { in: ids } }, select: { gameId: true, game: { select: titleFields }, metadata: { select: titleFields } }
    });
    const titles = new Map(profiles.map(p => [p.gameId, { id: p.gameId, ...(p.metadata ?? p.game) }]));
    const attach = <T extends { sourceGameId: string; targetGameId: string }>(r: T) =>
      ({ ...r, source: titles.get(r.sourceGameId)!, target: titles.get(r.targetGameId)! });
    return { relations: relations.map(attach), history: history.map(attach) };
  });
}
export async function createRelation(userId: string, sourceGameId: string, input: z.infer<typeof relationInput>) {
  return db.$transaction(async tx => {
    await requireGames(tx, userId, [sourceGameId, input.targetGameId]);
    const edges = await tx.gameRelation.findMany({ where: { userId }, select: { sourceGameId: true, targetGameId: true } });
    validateRelationGraph([...edges, { sourceGameId, targetGameId: input.targetGameId }]);
    const now = new Date(), id = randomUUID();
    const data = { userId, sourceGameId, ...input, revision: 1 };
    const relation = await tx.gameRelation.create({ data: { id, ...data, createdAt: now, updatedAt: now } });
    await tx.gameRelationEvent.create({ data: { id: randomUUID(), relationId: id, ...data, action: "CREATE", createdAt: now } });
    return relation;
  });
}
export async function changeRelation(userId: string, id: string, input: z.infer<typeof relationEditInput> | null) {
  return db.$transaction(async tx => {
    const relation = await tx.gameRelation.findFirst({ where: { id, userId } });
    if (!relation) throw new RelationError("作品关系不存在", 404);
    await requireGames(tx, userId, [relation.sourceGameId, relation.targetGameId]);
    if (input && input.type === relation.type && input.note === relation.note) return relation;
    const now = new Date(), revision = relation.revision + 1;
    await tx.gameRelationEvent.create({ data: {
      id: randomUUID(), userId, relationId: id, sourceGameId: relation.sourceGameId, targetGameId: relation.targetGameId,
      type: input?.type ?? relation.type, note: input?.note ?? relation.note, action: input ? "UPDATE" : "DELETE", revision, createdAt: now
    } });
    if (!input) { await tx.gameRelation.delete({ where: { id } }); return { ok: true }; }
    return tx.gameRelation.update({ where: { id }, data: { ...input, revision, updatedAt: now } });
  });
}

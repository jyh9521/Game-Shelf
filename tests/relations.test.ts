import test from "node:test";
import assert from "node:assert/strict";
import { backupSchema, validateReferences } from "../src/lib/backup";
import { relationInput, validateRelationGraph, validateRelationHistory, relationRecord, relationEventRecord } from "../src/lib/relation-domain";

const now = "2026-11-02T03:00:00.000Z";
const edge = (sourceGameId: string, targetGameId: string) => ({ sourceGameId, targetGameId });
const relation = relationRecord.parse({ id: "link", ...edge("remake", "original"), type: "REMAKE_OF", note: "人工确认独立重制作品", revision: 1, createdAt: now, updatedAt: now });
const event = relationEventRecord.parse({ id: "event", relationId: relation.id, ...edge("remake", "original"), type: relation.type, note: relation.note, revision: 1, action: "CREATE", createdAt: now });
const legacy = {
  format: "gameshelf", schema_version: 1, exportedAt: now, platforms: [], stores: [], releases: [], editions: [], items: [], contents: [],
  games: ["original", "remake"].map(id => ({ id, title: "同名作品", createdAt: now, updatedAt: now })),
  profiles: ["original", "remake"].map(id => ({ id: `p-${id}`, gameId: id, status: "UNPLAYED", rating: null, favorite: false, memo: "", overridesJson: "{}" }))
};
const current = () => backupSchema.parse({ ...legacy, schema_version: 2, relations: [relation], relationHistory: [event] });

test("作品关系只接受两种类型、明确方向和非空判定依据", () => {
  assert.equal(relationInput.safeParse({ targetGameId: "a", type: "REMAKE_OF", note: "依据" }).success, true);
  for (const bad of [{ type: "EDITION" }, { note: "  " }, { targetGameId: "" }, { userId: "other" }, { note: "x".repeat(2001) }]) {
    assert.equal(relationInput.safeParse({ targetGameId: "a", type: "REMASTER_OF", note: "依据", ...bad }).success, false);
  }
});
test("关系拒绝自身、重复方向、反向及间接循环", () => {
  for (const edges of [[edge("a", "a")], [edge("a", "b"), edge("a", "b")], [edge("a", "b"), edge("b", "a")], [edge("a", "b"), edge("b", "c"), edge("c", "a")]]) {
    assert.throws(() => validateRelationGraph(edges));
  }
  validateRelationGraph([edge("a", "b"), edge("c", "b"), edge("d", "a"), edge("d", "c")]);
  validateRelationGraph(Array.from({ length: 10000 }, (_, i) => edge(String(i), String(i + 1))));
});
test("v1 无损迁移到 v2，不推测同名作品关系", () => {
  const migrated = backupSchema.parse(legacy);
  assert.equal(migrated.schema_version, 2); assert.deepEqual(migrated.relations, []); assert.deepEqual(migrated.relationHistory, []);
  assert.deepEqual(migrated.games.map(g => g.id), ["original", "remake"]); validateReferences(migrated);
});
test("v2 要求显式关系和历史，拒绝未知字段与未来版本", () => {
  for (const bad of [{ ...legacy, schema_version: 2 }, { ...current(), schema_version: 3 }, { ...current(), token: "secret" }, { ...current(), relations: [{ ...relation, userId: "other" }] }]) {
    assert.equal(backupSchema.safeParse(bad).success, false);
  }
  validateReferences(current());
});
test("备份拒绝悬空、跨个人档案、重复关系和重复历史 ID", () => {
  const invalid = [
    { ...current(), games: [] }, { ...current(), profiles: [] },
    { ...current(), relations: [relation, { ...relation, id: "duplicate" }] },
    { ...current(), relationHistory: [event, event] },
    { ...current(), relations: [{ ...relation, sourceGameId: relation.targetGameId }] }
  ];
  for (const backup of invalid) assert.throws(() => validateReferences(backup));
});
test("判定历史覆盖建立、修改、解除，保留旧依据且允许文件乱序", () => {
  const edited = { ...relation, type: "REMASTER_OF" as const, note: "经人工核对是复刻", revision: 2 };
  const update = { ...event, id: "e2", type: edited.type, note: edited.note, revision: 2, action: "UPDATE" as const };
  const removed = { ...update, id: "e3", revision: 3, action: "DELETE" as const };
  validateRelationHistory([edited], [update, event]);
  validateRelationHistory([], [removed, event, update]);
  assert.equal(event.note, "人工确认独立重制作品");
  for (const events of [[update], [event, { ...update, revision: 3 }], [event, { ...update, targetGameId: "wrong" }], [event, { ...update, action: "CREATE" as const }]]) {
    assert.throws(() => validateRelationHistory([edited], events));
  }
  assert.throws(() => validateRelationHistory([relation], []));
  assert.throws(() => validateRelationHistory([], [event]));
  assert.throws(() => validateRelationHistory([edited], [event, update, removed]));
  assert.throws(() => validateRelationHistory([], [event, update, { ...removed, note: "tampered" }]));
});

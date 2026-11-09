import test from "node:test";
import assert from "node:assert/strict";
import { backupSchema, validateReferences } from "../src/lib/backup";
import { gameInput } from "../src/lib/domain";
import { encodeLocks, fieldEventRecord, lockedFields, metadataOf, planMetadataSave, type FieldEvent, type Source } from "../src/lib/metadata-domain";

const now = "2026-11-09T00:00:00.000Z";
const value = metadataOf(gameInput.parse({ title: "自定义标题", description: "" }));
const source: Source = { provider: "rawg", externalId: "123", value: "外部简介", collectedAt: now };

test("带来源的字段保持自动值；未触碰的新空字段不是手动覆盖", () => {
  const newValues = { ...value, description: source.value };
  const result = planMetadataSave(newValues, null, new Set(), {}, { description: source });
  assert.deepEqual([...result.locks], ["title"]);
  assert.deepEqual(result.events.map(e => [e.field, e.action, e.locked]), [["title", "MANUAL", true], ["description", "SOURCE", false]]);
  assert.equal(result.events[1].previousValue, null);
  const noChange = planMetadataSave(result.values, result.values, result.locks, { description: source }, {});
  assert.equal(noChange.events.length, 0);
});
test("显式清空自动字段后保留空值；第二次来源候选不会覆盖锁定空值", () => {
  const older = { ...value, description: source.value };
  const clear = planMetadataSave(value, older, new Set(["title"]), { description: source }, {});
  assert.equal(clear.values.description, "");
  assert.equal(clear.locks.has("description"), true);
  assert.equal(clear.events[0].source?.value, source.value);
  const latest = { ...source, value: "更新的外部简介" };
  const refresh = planMetadataSave(value, value, clear.locks, { description: source }, { description: latest });
  assert.equal(refresh.values.description, "");
  assert.deepEqual(refresh.events.map(e => [e.action, e.locked, e.source?.value]), [["SOURCE", true, "更新的外部简介"]]);
  assert.equal(planMetadataSave(value, value, clear.locks, { description: latest }, { description: latest }).events.length, 0);
});
test("暂存后主动清回原空值，在首次登记和已有作品都记录锁定", () => {
  for (const previous of [null, value]) {
    const p = planMetadataSave(value, previous, new Set(), {}, { description: source }, ["description"]);
    assert.equal(p.locks.has("description"), true);
    assert.equal(p.values.description, "");
    assert.equal(p.events.find(e => e.field === "description")?.source?.value, source.value);
  }
});
test("历史支持同字段原始候选、锁定空值、恢复来源，且不把覆盖值混作候选", () => {
  const raw = { ...source, value: "外部候选" };
  const base = { gameId: "g", field: "description", source: raw, createdAt: now };
  const events = [
    { ...base, id: "1", revision: 1, action: "SOURCE", previousValue: null, value: raw.value, locked: false },
    { ...base, id: "2", revision: 2, action: "MANUAL", previousValue: raw.value, value: "", locked: true },
    { ...base, id: "3", revision: 3, action: "UNLOCK", previousValue: "", value: raw.value, locked: false }
  ].map(e => fieldEventRecord.parse(e));
  const record = { format: "gameshelf", schema_version: 3, exportedAt: now, platforms: [], stores: [],
    games: [{ ...value, id: "g", createdAt: now, updatedAt: now, description: raw.value }], releases: [], editions: [], items: [], contents: [],
    profiles: [{ id: "p", gameId: "g", status: "PLAYING", rating: 3, favorite: false, memo: "", overridesJson: "{}" }],
    relations: [], relationHistory: [], fieldHistory: events.toReversed() };
  validateReferences(backupSchema.parse(record));
  for (const fieldHistory of [
    [...events, events[0]],
    [events[0], { ...events[1], previousValue: "篡改" }, events[2]],
    [events[0], events[2]],
    [{ ...events[0], gameId: "alien" }, ...events.slice(1)],
    events.slice(0, 2)
  ]) assert.throws(() => validateReferences(backupSchema.parse({ ...record, fieldHistory })));
  assert.equal(backupSchema.safeParse({ ...record, profiles: [{ ...record.profiles[0], overridesJson: "not-json" }] }).success, false);
  assert.equal(backupSchema.safeParse({ ...record, profiles: [{ ...record.profiles[0], overridesJson: encodeLocks(new Set(["description"]), value) }] }).success, false);
});
test("来源角色、地址、历史时间及无候选的解除锁定均校验", () => {
  const clear: FieldEvent = { id: "event", gameId: "g", field: "description", revision: 1, action: "UNLOCK",
    previousValue: "", value: "", locked: false, source: null, createdAt: now };
  assert.ok(fieldEventRecord.safeParse(clear).success);
  for (const bad of [
    { ...clear, value: "伪造", source: null },
    { ...clear, action: "MANUAL" },
    { ...clear, source: { ...source, provider: "steamgriddb" } },
    { ...clear, source: { ...source, value: "", collectedAt: "2027-01-01T00:00:00.000Z" } },
    { ...clear, field: "coverUrl", action: "SOURCE", source: { ...source, provider: "steamgriddb", value: "https://not-cdn.invalid/test.png" } },
    { ...clear, token: "secret" }
  ]) assert.equal(fieldEventRecord.safeParse(bad).success, false);
});
test("v2 保留旧手动锁定但不推测来源；v3 必须显式包含历史", () => {
  const overridesJson = encodeLocks(new Set(["title", "description"]), value);
  const record = { format: "gameshelf", schema_version: 2, exportedAt: now, platforms: [], stores: [],
    games: [{ ...value, id: "g", createdAt: now, updatedAt: now }], releases: [], editions: [], items: [], contents: [],
    profiles: [{ id: "p", gameId: "g", status: "PLAYING", rating: 3, favorite: false, memo: "", overridesJson }],
    relations: [], relationHistory: [] };
  const v3 = backupSchema.parse(record);
  validateReferences(v3);
  assert.deepEqual(v3.fieldHistory, []); assert.equal(v3.schema_version, 3);
  assert.deepEqual([...lockedFields(v3.profiles[0].overridesJson)], ["title", "description"]);
  assert.equal(backupSchema.safeParse({ ...record, schema_version: 3 }).success, false);
  assert.equal(backupSchema.safeParse({ ...record, fieldHistory: [] }).success, false);
});

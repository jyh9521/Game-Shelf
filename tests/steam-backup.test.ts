import test from "node:test";
import assert from "node:assert/strict";
import { backupSchema, validateReferences } from "../src/lib/backup";
const legacy = {format:"gameshelf",schema_version:3,exportedAt:"2026-11-24T01:00:00Z",platforms:[],stores:[],games:[],releases:[],editions:[],items:[],contents:[],profiles:[],relations:[],relationHistory:[],fieldHistory:[]};
test("v3 migrates to portable v4 without trusting a Steam identity", () => {
  const backup = backupSchema.parse(legacy);
  assert.equal(backup.schema_version,4); assert.deepEqual(backup.steamLinks,[]);
  assert.equal(backupSchema.safeParse({...backup, steamAccount:{steamId:"76561198000000001"}}).success,false);
  validateReferences(backup);
});
test("v4 rejects orphan Steam links before writing any data", () => {
  const backup = backupSchema.parse({...legacy,schema_version:4,steamLinks:[{id:"link",steamId:"76561198000000001",appid:0xffffffff,gameId:"missing",libraryItemId:"missing",createdAt:legacy.exportedAt}]});
  assert.throws(()=>validateReferences(backup));
});

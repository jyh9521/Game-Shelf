import { z } from "zod";

export const relationTypes = ["REMAKE_OF", "REMASTER_OF"] as const;
export type RelationType = typeof relationTypes[number];
export const relationLabels: Record<RelationType, string> = { REMAKE_OF: "重制自", REMASTER_OF: "复刻自" };
export const inverseRelationLabels: Record<RelationType, string> = { REMAKE_OF: "重制作品", REMASTER_OF: "复刻作品" };
const id = z.string().min(1).max(100);
export const relationEditInput = z.object({
  type: z.enum(relationTypes),
  note: z.string().trim().min(1, "请填写判定依据").max(2000)
}).strict();
export const relationInput = relationEditInput.extend({ targetGameId: id });
export const relationRecord = relationEditInput.extend({
  id, sourceGameId: id, targetGameId: id, revision: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
}).strict();
export const relationEventRecord = relationEditInput.extend({
  id, relationId: id, sourceGameId: id, targetGameId: id,
  action: z.enum(["CREATE", "UPDATE", "DELETE"]), revision: z.number().int().positive(), createdAt: z.iso.datetime()
}).strict();

type Edge = { sourceGameId: string; targetGameId: string };
export class RelationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// A remake/remaster points to its original. Validate all types together, in O(V + E).
export function validateRelationGraph(relations: readonly Edge[]) {
  const seen = new Set<string>(), edges = new Map<string, string[]>(), degrees = new Map<string, number>();
  for (const { sourceGameId: source, targetGameId: target } of relations) {
    if (source === target) throw new RelationError("作品不能关联自身");
    const key = JSON.stringify([source, target]);
    if (seen.has(key)) throw new RelationError("作品关系重复，请编辑已有关系");
    seen.add(key);
    if (!degrees.has(source)) degrees.set(source, 0);
    degrees.set(target, (degrees.get(target) ?? 0) + 1);
    const next = edges.get(source) ?? []; next.push(target); edges.set(source, next);
  }
  const queue = [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    for (const target of edges.get(queue[i]) ?? []) {
      const degree = degrees.get(target)! - 1; degrees.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  if (queue.length !== degrees.size) throw new RelationError("作品关系形成循环，请确认原作方向");
}

export function validateRelationHistory(relations: z.infer<typeof relationRecord>[], events: z.infer<typeof relationEventRecord>[]) {
  const current = new Map(relations.map(r => [r.id, r]));
  const groups = new Map<string, typeof events>();
  for (const event of events) {
    if (event.sourceGameId === event.targetGameId) throw new RelationError("作品关系历史不能关联自身");
    const list = groups.get(event.relationId) ?? []; list.push(event); groups.set(event.relationId, list);
  }
  for (const [id, unsorted] of groups) {
    const list = [...unsorted].sort((a, b) => a.revision - b.revision), first = list[0], last = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      const event = list[i], previous = list[i - 1];
      if (event.revision !== i + 1 || event.action !== (i === 0 ? "CREATE" : event.action === "DELETE" && i === list.length - 1 ? "DELETE" : "UPDATE") ||
          event.sourceGameId !== first.sourceGameId || event.targetGameId !== first.targetGameId ||
          (previous && Date.parse(event.createdAt) < Date.parse(previous.createdAt))) {
        throw new RelationError("作品关系历史顺序或身份不一致");
      }
      if (event.action === "DELETE" && previous && (event.type !== previous.type || event.note !== previous.note)) {
        throw new RelationError("作品关系删除历史与原记录不一致");
      }
    }
    const relation = current.get(id);
    if (last.action === "DELETE" ? !!relation : !relation || relation.revision !== last.revision ||
        relation.sourceGameId !== last.sourceGameId || relation.targetGameId !== last.targetGameId ||
        relation.type !== last.type || relation.note !== last.note || relation.createdAt !== first.createdAt || relation.updatedAt !== last.createdAt) {
      throw new RelationError("作品关系与历史不一致");
    }
    current.delete(id);
  }
  if (current.size) throw new RelationError("作品关系缺少判定历史");
}

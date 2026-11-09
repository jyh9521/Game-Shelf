import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";

export const platformInput = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "平台代号须以字母或数字开头，只允许字母、数字、短横线和下划线")
    .transform(code => code.toUpperCase()).optional()
}).strict();
type PlatformInput = z.infer<typeof platformInput>;
type Tx = Prisma.TransactionClient;
export class PlatformError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function codeTaken(tx: Tx, code: string, except?: string) {
  // Existing backups can contain lowercase IDs. Compare ASCII codes without
  // case when allocating a new ID, without rewriting those existing IDs.
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Platform" WHERE "id" = ${code} COLLATE NOCASE`;
  return rows.some(row => row.id !== except);
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
async function generateCode(tx: Tx, name: string) {
  const stem = name.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-").replace(/^-+/, "").slice(0, 31).replace(/-+$/, "");
  if (stem && !await codeTaken(tx, stem)) return stem;
  return (stem || "PLAT") + "-" + suffix();
}
async function changeCatalog<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(work);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") throw new PlatformError(409, "平台名称或代号已存在");
      if (e.code === "P2003") throw new PlatformError(409, "平台仍有关联的拥有记录，请先修改发行平台");
    }
    throw e;
  }
}
export function createPlatform(input: PlatformInput) {
  return changeCatalog(async tx => {
    const id = input.code ?? await generateCode(tx, input.name);
    if (await codeTaken(tx, id)) throw new PlatformError(409, "平台代号已存在");
    return tx.platform.create({ data: { id, name: input.name } });
  });
}
export function updatePlatform(id: string, input: PlatformInput) {
  return changeCatalog(async tx => {
    const current = await tx.platform.findUnique({ where: { id } });
    if (!current) throw new PlatformError(404, "平台不存在");
    const nextId = input.code ?? current.id;
    if (nextId !== id && await codeTaken(tx, nextId, id)) throw new PlatformError(409, "平台代号已存在");
    // Release.platformId has ON UPDATE CASCADE. Release, Edition and
    // LibraryItemContent IDs are unchanged; no game data is recreated.
    return tx.platform.update({ where: { id }, data: { id: nextId, name: input.name } });
  });
}
export function removePlatform(id: string) {
  return changeCatalog(async tx => {
    if (!await tx.platform.findUnique({ where: { id } })) throw new PlatformError(404, "平台不存在");
    const inUse = await tx.libraryItemContent.count({ where: { release: { platformId: id } } });
    if (inUse) throw new PlatformError(409, "该平台仍有 " + inUse + " 份拥有记录引用。请先在游戏详情修改这些记录的发行平台，再删除。");
    // Editing an owned release can leave its old, unowned Release row. Remove
    // those rows with the platform; the FK still prevents deleting live data.
    const unused = await tx.release.deleteMany({ where: { platformId: id, contents: { none: {} } } });
    await tx.platform.delete({ where: { id } });
    return { ok: true, removedUnusedReleases: unused.count };
  });
}

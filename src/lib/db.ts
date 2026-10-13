import { PrismaClient } from "@prisma/client";
const globalDb = globalThis as unknown as { prisma?: PrismaClient; ready?: Promise<void> };
const url = process.env.DATABASE_URL;
export const db = globalDb.prisma ?? new PrismaClient(url ? { datasourceUrl: `${url}${url.includes("?")?"&":"?"}connection_limit=1&socket_timeout=5` } : undefined);
globalDb.prisma = db;
export async function ready() {
  globalDb.ready ??= (async () => {
    await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await db.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  })();
  await globalDb.ready;
}

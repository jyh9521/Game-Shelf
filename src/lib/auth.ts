import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db";
const derive = promisify(scrypt);
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hex] = encoded.split(":");
  const expected = Buffer.from(hex, "hex");
  const actual = await derive(password, salt, 64) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function secureCompare(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hashToken(a), "hex"), Buffer.from(hashToken(b), "hex"));
}
export function sessionToken(req: Request) {
  return /(?:^|;\s*)gameshelf_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get("cookie") ?? "")?.[1];
}
export async function currentUser(req: Request) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  return s && s.expiresAt.getTime() > Date.now() ? s.user : null;
}
export async function newSession(userId: string) {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString("hex");
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now()+7*86400000) } });
  return token;
}
export function cookie(token: string, logout = false) {
  return `gameshelf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : 604800}${process.env.SECURE_COOKIE === "true" ? "; Secure" : ""}`;
}

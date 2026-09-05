import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { loginSessions } from "../db/schema.ts";

export type LoginSessionRow = typeof loginSessions.$inferSelect;

export type LoginStatus =
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "confirmed"
  | "expired"
  | "failed";

export interface NewLoginSession {
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  now: number;
  ttlMs: number;
}

export async function createLoginSession(db: Db, s: NewLoginSession): Promise<LoginSessionRow> {
  return (await db
    .insert(loginSessions)
    .values({
      id: s.id,
      qrcode: s.qrcode,
      qrcodeUrl: s.qrcodeUrl,
      status: "wait",
      createdAt: s.now,
      expiresAt: s.now + s.ttlMs,
    })
    .returning()
    .get())!;
}

export async function getLoginSession(db: Db, id: string): Promise<LoginSessionRow | undefined> {
  return await db.select().from(loginSessions).where(eq(loginSessions.id, id)).get();
}

export async function updateLoginSession(db: Db, id: string, patch: Partial<Omit<LoginSessionRow, "id" | "createdAt">>): Promise<void> {
  await db.update(loginSessions).set(patch).where(eq(loginSessions.id, id)).run();
}

export async function deleteLoginSession(db: Db, id: string): Promise<void> {
  await db.delete(loginSessions).where(eq(loginSessions.id, id)).run();
}

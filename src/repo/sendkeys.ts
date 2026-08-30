import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { sendkeys } from "../db/schema.ts";

export type SendkeyRow = typeof sendkeys.$inferSelect;

export interface NewSendkey {
  keyHash: string;
  accountId: string;
  label?: string;
  now: number;
}

export function createSendkey(db: Db, k: NewSendkey): SendkeyRow {
  return db
    .insert(sendkeys)
    .values({ keyHash: k.keyHash, accountId: k.accountId, label: k.label ?? "", createdAt: k.now })
    .returning()
    .get()!;
}

export function findActiveSendkey(db: Db, keyHash: string): SendkeyRow | undefined {
  return db.select().from(sendkeys).where(and(eq(sendkeys.keyHash, keyHash), isNull(sendkeys.revokedAt))).get();
}

export function listSendkeys(db: Db, accountId: string): SendkeyRow[] {
  return db.select().from(sendkeys).where(eq(sendkeys.accountId, accountId)).all();
}

export function revokeSendkeys(db: Db, accountId: string, now: number): void {
  db.update(sendkeys).set({ revokedAt: now }).where(and(eq(sendkeys.accountId, accountId), isNull(sendkeys.revokedAt))).run();
}

export function touchSendkey(db: Db, id: number, now: number): void {
  db.update(sendkeys).set({ lastUsedAt: now }).where(eq(sendkeys.id, id)).run();
}

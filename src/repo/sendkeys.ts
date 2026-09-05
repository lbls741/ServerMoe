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

export async function createSendkey(db: Db, k: NewSendkey): Promise<SendkeyRow> {
  return (await db
    .insert(sendkeys)
    .values({ keyHash: k.keyHash, accountId: k.accountId, label: k.label ?? "", createdAt: k.now })
    .returning()
    .get())!;
}

export async function findActiveSendkey(db: Db, keyHash: string): Promise<SendkeyRow | undefined> {
  return await db.select().from(sendkeys).where(and(eq(sendkeys.keyHash, keyHash), isNull(sendkeys.revokedAt))).get();
}

export async function listSendkeys(db: Db, accountId: string): Promise<SendkeyRow[]> {
  return await db.select().from(sendkeys).where(eq(sendkeys.accountId, accountId)).all();
}

export async function revokeSendkeys(db: Db, accountId: string, now: number): Promise<void> {
  await db
    .update(sendkeys)
    .set({ revokedAt: now })
    .where(and(eq(sendkeys.accountId, accountId), isNull(sendkeys.revokedAt)))
    .run();
}

export async function touchSendkey(db: Db, id: number, now: number): Promise<void> {
  await db.update(sendkeys).set({ lastUsedAt: now }).where(eq(sendkeys.id, id)).run();
}

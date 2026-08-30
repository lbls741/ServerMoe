import { and, asc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { outbox } from "../db/schema.ts";

export type OutboxRow = typeof outbox.$inferSelect;

export interface OutboxEntry {
  sendkeyId?: number | null;
  accountId: string;
  peerUserId: string;
  title: string;
  desp?: string;
  now: number;
  ttlMs?: number;
}

export function enqueueOutbox(db: Db, e: OutboxEntry): OutboxRow {
  return db
    .insert(outbox)
    .values({
      sendkeyId: e.sendkeyId ?? null,
      accountId: e.accountId,
      peerUserId: e.peerUserId,
      title: e.title,
      desp: e.desp ?? "",
      createdAt: e.now,
      expiresAt: e.now + (e.ttlMs ?? 24 * 60 * 60 * 1000),
    })
    .returning()
    .get()!;
}

export function listPendingOutbox(db: Db, accountId: string, peerUserId: string): OutboxRow[] {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.accountId, accountId), eq(outbox.peerUserId, peerUserId), eq(outbox.status, "pending")))
    .orderBy(asc(outbox.id))
    .all();
}

export function markOutboxSent(db: Db, id: number): void {
  db.update(outbox).set({ status: "sent" }).where(eq(outbox.id, id)).run();
}

export function incrementOutboxAttempts(db: Db, id: number, attempts: number): void {
  db.update(outbox).set({ attempts }).where(eq(outbox.id, id)).run();
}

/** 到期未发的条目标记 expired（预热一直没发生）。 */
export function expireOutbox(db: Db, now: number): void {
  db.update(outbox).set({ status: "expired" }).where(and(eq(outbox.status, "pending"), lt(outbox.expiresAt, now))).run();
}

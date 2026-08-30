import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { accounts } from "../db/schema.ts";

export type AccountRow = typeof accounts.$inferSelect;
export type AccountStatus = "active" | "paused" | "rebind_needed";

export interface NewAccount {
  id: string; // ilink_bot_id
  tokenEnc: string;
  baseUrl: string;
  ownerUserId?: string;
  label?: string;
  now: number;
}

export function createAccount(db: Db, a: NewAccount): AccountRow {
  const row = {
    id: a.id,
    label: a.label ?? "",
    tokenEnc: a.tokenEnc,
    baseUrl: a.baseUrl,
    ownerUserId: a.ownerUserId ?? "",
    status: "active" as const,
    createdAt: a.now,
    updatedAt: a.now,
  };
  return db.insert(accounts).values(row).onConflictDoUpdate({ target: accounts.id, set: row }).returning().get()!;
}

export function listAccounts(db: Db): AccountRow[] {
  return db.select().from(accounts).all();
}

export function getAccount(db: Db, id: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export function updateAccountStatus(db: Db, id: string, status: AccountStatus, now: number, extra?: { pausedUntil?: number | null; lastError?: string | null }): void {
  db.update(accounts)
    .set({ status, updatedAt: now, pausedUntil: extra?.pausedUntil ?? null, lastError: extra?.lastError ?? null })
    .where(eq(accounts.id, id))
    .run();
}

export function setAccountSyncBuf(db: Db, id: string, syncBuf: string, now: number): void {
  db.update(accounts).set({ syncBuf, updatedAt: now }).where(eq(accounts.id, id)).run();
}

export function touchAccountInbound(db: Db, id: string, now: number): void {
  db.update(accounts).set({ lastInboundAt: now, updatedAt: now }).where(eq(accounts.id, id)).run();
}

export function deleteAccount(db: Db, id: string): void {
  db.delete(accounts).where(eq(accounts.id, id)).run();
}

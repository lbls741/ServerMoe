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

export async function createAccount(db: Db, a: NewAccount): Promise<AccountRow> {
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
  return (await db.insert(accounts).values(row).onConflictDoUpdate({ target: accounts.id, set: row }).returning().get())!;
}

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  return await db.select().from(accounts).all();
}

export async function getAccount(db: Db, id: string): Promise<AccountRow | undefined> {
  return await db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export async function updateAccountStatus(db: Db, id: string, status: AccountStatus, now: number, extra?: { pausedUntil?: number | null; lastError?: string | null }): Promise<void> {
  await db
    .update(accounts)
    .set({ status, updatedAt: now, pausedUntil: extra?.pausedUntil ?? null, lastError: extra?.lastError ?? null })
    .where(eq(accounts.id, id))
    .run();
}

export async function setAccountSyncBuf(db: Db, id: string, syncBuf: string, now: number): Promise<void> {
  await db.update(accounts).set({ syncBuf, updatedAt: now }).where(eq(accounts.id, id)).run();
}

export async function touchAccountInbound(db: Db, id: string, now: number): Promise<void> {
  await db.update(accounts).set({ lastInboundAt: now, updatedAt: now }).where(eq(accounts.id, id)).run();
}

/** 读取启用临期提醒且处于 active 状态的账号（提醒器的扫描输入）。 */
export async function listWarnEnabledAccounts(db: Db): Promise<AccountRow[]> {
  return await db.select().from(accounts).where(eq(accounts.warnEnabled, true)).all();
}

export interface WarnSettings {
  enabled: boolean;
  /** null = 恢复默认文案 */
  text: string | null;
  /** null = 恢复默认提前量 */
  leadSec: number | null;
}

export async function setWarnSettings(db: Db, id: string, s: WarnSettings, now: number): Promise<void> {
  await db
    .update(accounts)
    .set({ warnEnabled: s.enabled, warnText: s.text, warnLeadSec: s.leadSec, updatedAt: now })
    .where(eq(accounts.id, id))
    .run();
}

/** 记录一次提醒已发送（无论成败，实现「每个静默窗口至多一条」）。 */
export async function markWarned(db: Db, id: string, now: number): Promise<void> {
  await db.update(accounts).set({ warnedAt: now, updatedAt: now }).where(eq(accounts.id, id)).run();
}

export async function deleteAccount(db: Db, id: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, id)).run();
}

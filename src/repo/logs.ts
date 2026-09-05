import { desc, lt } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { inboundLog, pushLog } from "../db/schema.ts";

export type PushLogRow = typeof pushLog.$inferSelect;
export type InboundLogRow = typeof inboundLog.$inferSelect;

export interface PushLogEntry {
  ts: number;
  sendkeyId?: number | null;
  accountId?: string | null;
  peerUserId?: string | null;
  title: string;
  desp?: string;
  short?: string | null;
  extra?: string | null;
  status: string;
  error?: string | null;
  clientId?: string | null;
  ip?: string | null;
}

export async function addPushLog(db: Db, e: PushLogEntry): Promise<number> {
  const row = await db
    .insert(pushLog)
    .values({
      ts: e.ts,
      sendkeyId: e.sendkeyId ?? null,
      accountId: e.accountId ?? null,
      peerUserId: e.peerUserId ?? null,
      title: e.title,
      desp: e.desp ?? "",
      short: e.short ?? null,
      extra: e.extra ?? null,
      status: e.status,
      error: e.error ?? null,
      clientId: e.clientId ?? null,
      ip: e.ip ?? null,
    })
    .returning({ id: pushLog.id })
    .get();
  return row!.id;
}

export interface InboundLogEntry {
  ts: number;
  accountId: string;
  fromUserId: string;
  text?: string;
  matchedKeywordId?: number | null;
  action: string;
  reply?: string | null;
}

export async function addInboundLog(db: Db, e: InboundLogEntry): Promise<void> {
  await db
    .insert(inboundLog)
    .values({
      ts: e.ts,
      accountId: e.accountId,
      fromUserId: e.fromUserId,
      text: e.text ?? "",
      matchedKeywordId: e.matchedKeywordId ?? null,
      action: e.action,
      reply: e.reply ?? null,
    })
    .run();
}

export async function gcLogs(db: Db, olderThanTs: number): Promise<void> {
  await db.delete(pushLog).where(lt(pushLog.ts, olderThanTs)).run();
  await db.delete(inboundLog).where(lt(inboundLog.ts, olderThanTs)).run();
}

export async function listRecentPush(db: Db, limit = 30): Promise<PushLogRow[]> {
  return await db.select().from(pushLog).orderBy(desc(pushLog.id)).limit(limit).all();
}

export async function listRecentInbound(db: Db, limit = 30): Promise<InboundLogRow[]> {
  return await db.select().from(inboundLog).orderBy(desc(inboundLog.id)).limit(limit).all();
}

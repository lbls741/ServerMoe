import { lt } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { inboundLog, pushLog } from "../db/schema.ts";

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

export function addPushLog(db: Db, e: PushLogEntry): number {
  const row = db
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

export function addInboundLog(db: Db, e: InboundLogEntry): void {
  db.insert(inboundLog)
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

export function gcLogs(db: Db, olderThanTs: number): void {
  db.delete(pushLog).where(lt(pushLog.ts, olderThanTs)).run();
  db.delete(inboundLog).where(lt(inboundLog.ts, olderThanTs)).run();
}

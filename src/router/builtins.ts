// 内置命令（保留字）。保留字是「用户输入恰好等于该词」时的最高优先级语义，
// 应用不得注册这四个词（注册 API 会拒绝）。

import type { AccountRow } from "../repo/accounts.ts";
import { count, gte } from "drizzle-orm";
import { pushLog } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { listPeers } from "../repo/peers.ts";
import { expireOutbox, listPendingOutbox } from "../repo/outbox.ts";
import type { KeywordRow } from "../repo/keywords.ts";

export const RESERVED_KEYWORDS = ["help", "status", "bind", "mail"] as const;

export interface BuiltinContext {
  account: AccountRow;
  db: Db;
  keywords: KeywordRow[];
}

export function isReserved(keyword: string): boolean {
  return (RESERVED_KEYWORDS as readonly string[]).includes(keyword.trim().toLowerCase());
}

export function builtinReply(cmd: string, ctx: BuiltinContext): string | null {
  switch (cmd) {
    case "help":
      return helpText(ctx);
    case "status":
      return statusText(ctx);
    default:
      return null; // bind/mail 后续里程碑实现
  }
}

function helpText(ctx: BuiltinContext): string {
  const lines: string[] = ["ServerMoe 指令", "", "help - 显示本帮助", "status - 网关与账号状态", ""];
  const enabled = ctx.keywords.filter((k) => k.enabled);
  if (enabled.length === 0) {
    lines.push("尚未注册关键词。", "应用可通过 POST /api/v1/keywords 注册「关键词 → 回调」路由。");
  } else {
    lines.push("已注册关键词：");
    for (const k of enabled) {
      lines.push(`  ${k.keyword} (${k.matchMode})`);
    }
  }
  return lines.join("\n");
}

function statusText(ctx: BuiltinContext): string {
  const now = Date.now();
  expireOutbox(ctx.db, now);
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const pushes24h = ctx.db.select({ n: count() }).from(pushLog).where(gte(pushLog.ts, dayAgo)).get()?.n ?? 0;
  const outboxPending = listPendingOutbox(ctx.db, ctx.account.id, ctx.account.ownerUserId).length;
  const lastInbound = ctx.account.lastInboundAt ? new Date(ctx.account.lastInboundAt).toLocaleString("zh-CN") : "无";
  return [
    `账号: ${ctx.account.id}`,
    `状态: ${ctx.account.status}`,
    `预热用户: ${listPeers(ctx.db, ctx.account.id).length}`,
    `关键词: ${ctx.keywords.filter((k) => k.enabled).length} 个`,
    `24h 推送: ${pushes24h} 条`,
    `待补发(预热队列): ${outboxPending} 条`,
    `最后入站: ${lastInbound}`,
  ].join("\n");
}

// 24h 推送窗口临期提醒（research/ilink-interface-and-serverless.md §9）：
// 用户最近一次发消息后 24h 内 bot 才可推送，且只有用户回复能重置窗口——bot 无法静默续期。
// 因此唯一能做的是「到期前提醒用户回复」：每个静默窗口至多一条提醒，用户回复后窗口重置、
// 计时自然重新开始（touchAccountInbound 刷新 last_inbound_at）。窗口一旦真正过期，提醒无法
// 自愈，只能等用户自发回消息（预热后 outbox 自动补发排队推送）。
import { PUSH_WINDOW_MS } from "../channels/wechat/ilink/constants.ts";
import type { SendResult } from "../channels/types.ts";
import type { Core } from "../core.ts";
import { listPeers } from "../repo/peers.ts";
import { getAccount, listWarnEnabledAccounts, markWarned as markWarnedRepo, updateAccountStatus } from "../repo/accounts.ts";

export const DEFAULT_WARN_LEAD_SEC = 30 * 60;
export const WARN_LEAD_MIN_SEC = 5 * 60;
export const WARN_LEAD_MAX_SEC = 12 * 60 * 60;

export const DEFAULT_WARN_TEXT =
  "⏰ 你已经快 24 小时没有给我发消息了，推送通道即将失效。回复任意内容即可续期，保持通知可达。";

export interface WarnTarget {
  accountId: string;
  peerUserId: string;
  /** 最近一次用户入站消息时刻（epoch ms）；null = 从未预热，不提醒（预热引导由 450/outbox 流程负责） */
  lastInboundAt: number | null;
  warnedAt: number | null;
  leadSec: number;
  text: string;
}

export type WarnSender = (accountId: string, peerUserId: string, text: string) => Promise<SendResult>;

/** 提前量钳位：5min–12h。 */
export function normalizeWarnLeadSec(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return null;
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n)) return null;
  return Math.min(WARN_LEAD_MAX_SEC, Math.max(WARN_LEAD_MIN_SEC, n));
}

/** 纯判定：是否到达「提醒时刻」（最后入站 + 窗口 − 提前量），且当前静默窗口内尚未提醒过。 */
export function isWarnDue(t: Pick<WarnTarget, "lastInboundAt" | "warnedAt" | "leadSec">, now: number): boolean {
  if (t.lastInboundAt == null) return false;
  if (t.warnedAt != null && t.warnedAt >= t.lastInboundAt) return false;
  const remindAt = t.lastInboundAt + PUSH_WINDOW_MS - t.leadSec * 1000;
  return now >= remindAt;
}

export interface WindowWarnerDeps {
  now?: () => number;
  send?: WarnSender;
  listTargets?: () => Promise<WarnTarget[]> | WarnTarget[];
  markWarned?: (accountId: string, now: number) => void | Promise<void>;
}

export function createWindowWarner(core: Core, deps: WindowWarnerDeps = {}) {
  const log = core.log.child({ mod: "warn" });
  const now = deps.now ?? (() => Date.now());
  const markWarned = deps.markWarned ?? ((accountId, at) => markWarnedRepo(core.db, accountId, at));
  const send: WarnSender =
    deps.send ??
    (async (accountId, peerUserId, text) => {
      const ch = core.channels.get("wechat");
      if (!ch) return { ok: false, reason: "ERROR", error: "channel wechat not registered" };
      return ch.send(accountId, peerUserId, text);
    });
  const listTargets =
    deps.listTargets ??
    (async (): Promise<WarnTarget[]> => {
      const enabled = await listWarnEnabledAccounts(core.db);
      return (await Promise.all(
        enabled
          .filter((a) => a.status === "active")
          .map(async (a) => {
            // ClawBot 仅绑定者一人可对话（官方约束），推送目标与 push.ts 一致取 ownerUserId；
            // 缺失时回退最近活跃 peer 兜底。
            const peers = await listPeers(core.db, a.id);
            const peerUserId =
              a.ownerUserId || peers.slice().sort((x, y) => y.updatedAt - x.updatedAt)[0]?.userId || "";
            return {
              accountId: a.id,
              peerUserId,
              lastInboundAt: a.lastInboundAt,
              warnedAt: a.warnedAt,
              leadSec: a.warnLeadSec ?? DEFAULT_WARN_LEAD_SEC,
              text: a.warnText || DEFAULT_WARN_TEXT,
            } satisfies WarnTarget;
          }),
      )).filter((t) => t.peerUserId !== "");
    });

  let timer: ReturnType<typeof setInterval> | null = null;

  /** 扫描一轮，返回已发出提醒的账号数。单账号异常不中断整轮。 */
  async function sweep(): Promise<number> {
    const at = now();
    let sent = 0;
    for (const t of await listTargets()) {
      if (!isWarnDue(t, at)) continue;
      try {
        const res = await send(t.accountId, t.peerUserId, t.text);
        if (res.ok) {
          log.info("window warn sent", { accountId: t.accountId, peer: t.peerUserId });
        } else if (res.reason === "TOKEN_EXPIRED") {
          // 与 push.ts 同语义：发送路径上的 -14 → 标记重扫
          if (await getAccount(core.db, t.accountId)) {
            await updateAccountStatus(core.db, t.accountId, "rebind_needed", at, {
              lastError: "errcode -14: bot_token 失效",
            });
          }
          log.warn("window warn failed: token expired", { accountId: t.accountId });
        } else {
          log.warn("window warn failed", { accountId: t.accountId, reason: res.reason, error: res.error });
        }
        // 除瞬时网络错误（ERROR）外都视为「本窗口已提醒」，避免逐轮重试刷屏；
        // 用户回复后 last_inbound_at 前移，判定自然为新窗口。
        if (res.ok || res.reason !== "ERROR") await markWarned(t.accountId, at);
        if (res.ok) sent += 1;
      } catch (err) {
        log.warn("window warn error", { accountId: t.accountId, err: String(err) });
      }
    }
    return sent;
  }

  function start(intervalMs = 60_000): void {
    if (timer) return;
    void sweep().catch((err) => log.warn("window warn sweep error", { err: String(err) }));
    timer = setInterval(() => {
      void sweep().catch((err) => log.warn("window warn sweep error", { err: String(err) }));
    }, intervalMs);
    timer.unref?.();
  }

  function shutdown(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { sweep, start, shutdown };
}

export type WindowWarner = ReturnType<typeof createWindowWarner>;

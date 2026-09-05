import { chunkText } from "../channels/wechat/chunk.ts";
import { filterForWechat } from "../channels/wechat/markdown.ts";
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_TTL_MS } from "../channels/wechat/ilink/constants.ts";
import type { SendResult } from "../channels/types.ts";
import type { Core } from "../core.ts";
import { getAccount, updateAccountStatus } from "../repo/accounts.ts";
import { addPushLog } from "../repo/logs.ts";
import { enqueueOutbox, expireOutbox, incrementOutboxAttempts, listPendingOutbox, markOutboxSent } from "../repo/outbox.ts";

export interface PushRequest {
  sendkeyId?: number | null;
  accountId: string;
  peerUserId: string;
  title: string;
  desp?: string;
  short?: string | null;
  extra?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface PushOutcome {
  code: 0 | 450 | 451 | 502;
  message: string;
  pushid?: string;
  reason?: "WARMUP_REQUIRED" | "TOKEN_EXPIRED" | "ERROR";
  error?: string;
  chunks?: number;
}

/** 组装推送文本：short 摘要 + title + desp(markdown 预过滤)。 */
export function composePushText(short: string | null | undefined, title: string, desp: string | undefined): string {
  const parts: string[] = [];
  if (short) parts.push(short);
  parts.push(title);
  if (desp) parts.push(filterForWechat(desp));
  return parts.join("\n\n");
}

export interface PushServiceOptions {
  /**
   * 方案3（按需收割）钩子：首次发送遇 WARMUP_REQUIRED 时调用。
   * 返回 true 表示收割到了用户近期消息（context_token 可能已刷新），推送链路会重试一轮；
   * 失败/未开启则按原语义入 outbox 排队（450）。
   */
  onWarmupHarvest?: (accountId: string, peerUserId: string) => Promise<boolean>;
}

export function createPushService(core: Core, opts: PushServiceOptions = {}) {
  async function pushOne(accountId: string, peerUserId: string, text: string): Promise<SendResult> {
    const ch = core.channels.get("wechat");
    if (!ch) return { ok: false, reason: "ERROR", error: "channel wechat not registered" };
    return ch.send(accountId, peerUserId, text);
  }

  async function logPush(req: PushRequest, status: string, error?: string | null, clientId?: string | null): Promise<number> {
    return addPushLog(core.db, {
      ts: Date.now(),
      sendkeyId: req.sendkeyId ?? null,
      accountId: req.accountId,
      peerUserId: req.peerUserId,
      title: req.title,
      desp: req.desp ?? "",
      short: req.short ?? null,
      extra: req.extra ? JSON.stringify(req.extra) : null,
      status,
      error: error ?? null,
      clientId: clientId ?? null,
      ip: req.ip ?? null,
    });
  }

  /** 推送主链路：校验 → 组装 → 分块 → 逐块发送 → 落日志/出箱。 */
  async function push(req: PushRequest): Promise<PushOutcome> {
    const account = await getAccount(core.db, req.accountId);
    if (!account) {
      await logPush(req, "failed", "account missing");
      return { code: 502, message: "推送账号不存在", reason: "ERROR" };
    }
    if (account.status === "rebind_needed") {
      return { code: 451, message: "通道凭据已失效，请重新扫码绑定", reason: "TOKEN_EXPIRED" };
    }

    const text = composePushText(req.short, req.title, req.desp);
    const chunks = chunkText(text, core.cfg.textChunkLimit);
    let sent = 0;
    let clientId: string | undefined;
    let lastFail: SendResult | null = null;
    for (const chunk of chunks) {
      const res = await pushOne(req.accountId, req.peerUserId, chunk);
      if (res.ok) {
        sent += 1;
        clientId = res.clientId;
        continue;
      }
      lastFail = res;
      break;
    }

    if (!lastFail) {
      const pushid = await logPush(req, "sent", null, clientId);
      return { code: 0, message: "", pushid: String(pushid), chunks: chunks.length };
    }

    // 方案3（按需收割）：未预热时先收割一次腾讯侧缓冲的用户消息，再重试一轮
    if (lastFail.reason === "WARMUP_REQUIRED" && sent === 0 && opts.onWarmupHarvest) {
      const harvested = await opts.onWarmupHarvest(req.accountId, req.peerUserId).catch(() => false);
      if (harvested) {
        sent = 0;
        clientId = undefined;
        lastFail = null;
        for (const chunk of chunks) {
          const res = await pushOne(req.accountId, req.peerUserId, chunk);
          if (res.ok) {
            sent += 1;
            clientId = res.clientId;
            continue;
          }
          lastFail = res;
          break;
        }
      }
      if (!lastFail) {
        const pushid = await logPush(req, "sent", null, clientId);
        return { code: 0, message: "", pushid: String(pushid), chunks: chunks.length };
      }
    }

    if (lastFail.reason === "WARMUP_REQUIRED" && sent === 0) {
      await enqueueOutbox(core.db, {
        sendkeyId: req.sendkeyId ?? null,
        accountId: req.accountId,
        peerUserId: req.peerUserId,
        title: req.title,
        desp: req.desp ?? "",
        now: Date.now(),
        ttlMs: OUTBOX_TTL_MS,
      });
      await logPush(req, "queued", "warmup required");
      return {
        code: 450,
        message: "请先在微信中给 ClawBot 发送任意一条消息以激活推送；已排队，激活后自动送达",
        reason: "WARMUP_REQUIRED",
        chunks: chunks.length,
      };
    }

    if (lastFail.reason === "TOKEN_EXPIRED") {
      await updateAccountStatus(core.db, req.accountId, "rebind_needed", Date.now(), { lastError: "errcode -14: bot_token 失效" });
      await logPush(req, "failed", "token expired");
      return { code: 451, message: "通道凭据已失效，请重新扫码绑定", reason: "TOKEN_EXPIRED" };
    }

    await logPush(req, "failed", lastFail.error ?? "unknown");
    return { code: 502, message: `通道发送失败: ${lastFail.error ?? "unknown"}`, reason: "ERROR", error: lastFail.error, chunks: chunks.length };
  }

  /** 预热自愈：某 peer 的新 context_token 捕获后，重发其 outbox 中的排队推送。 */
  async function flushOutbox(accountId: string, peerUserId: string): Promise<void> {
    await expireOutbox(core.db, Date.now());
    const pending = await listPendingOutbox(core.db, accountId, peerUserId);
    for (const item of pending) {
      if (item.attempts >= OUTBOX_MAX_ATTEMPTS) continue;
      const text = composePushText(null, item.title, item.desp);
      const chunks = chunkText(text, core.cfg.textChunkLimit);
      let ok = true;
      for (const chunk of chunks) {
        const res = await pushOne(accountId, peerUserId, chunk);
        if (res.ok) continue;
        ok = false;
        if (res.reason === "TOKEN_EXPIRED") {
          await updateAccountStatus(core.db, accountId, "rebind_needed", Date.now(), { lastError: "errcode -14: bot_token 失效" });
          return;
        }
        break;
      }
      if (ok) {
        await markOutboxSent(core.db, item.id);
        await addPushLog(core.db, {
          ts: Date.now(),
          sendkeyId: item.sendkeyId,
          accountId,
          peerUserId,
          title: item.title,
          desp: item.desp,
          status: "sent",
        });
      } else {
        await incrementOutboxAttempts(core.db, item.id, item.attempts + 1);
      }
    }
  }

  return { push, flushOutbox };
}

export type PushService = ReturnType<typeof createPushService>;

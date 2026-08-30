// iLink 长轮询收信循环。错误语义依据 recon.md §2.5：
// - errcode/-14 → bot_token 失效 → 熔断 1h（回调 onStale）
// - 其他错误 → 2s 重试，连续 3 次 → 30s 退避
// - 成功轮询 → 回调 onAlive（用于把 paused 账号标记回 active）

import { decryptString } from "../../crypto.ts";
import type { AccountRow } from "../../repo/accounts.ts";
import type { Logger } from "../../log.ts";
import { MessageItemType, MessageType, type GetUpdatesResp, type WeixinMessage } from "./ilink/types.ts";
import {
  BACKOFF_DELAY_MS,
  LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  STALE_PAUSE_MS,
  STALE_TOKEN_ERRCODE,
} from "./ilink/constants.ts";
import { getUpdates, notifyStart, notifyStop, type ApiCtx } from "./ilink/client.ts";

export interface MonitorCallbacks {
  onMessage: (account: AccountRow, msg: WeixinMessage, text: string) => void | Promise<void>;
  onCursor: (accountId: string, cursor: string) => void;
  onStale: (accountId: string) => void;
  onAlive: (accountId: string) => void;
}

export interface MonitorDeps {
  log: Logger;
  masterKey: Buffer;
  botAgent: string;
}

export interface MonitorHandle {
  accountId: string;
  stop(): Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** 提取消息文本：首个 TEXT item；语音带服务端转写时作为回退正文。 */
export function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item) return item.text_item.text;
  }
  for (const item of msg.item_list ?? []) {
    if (item.voice_item?.text) return item.voice_item.text;
  }
  return "";
}

export function startMonitor(deps: MonitorDeps, account: AccountRow, cb: MonitorCallbacks): MonitorHandle {
  const controller = new AbortController();
  const log = deps.log.child({ acct: account.id });
  const ctx: ApiCtx = {
    baseUrl: account.baseUrl,
    token: decryptString(deps.masterKey, account.tokenEnc),
    botAgent: deps.botAgent,
  };

  const task = (async () => {
    log.info("monitor started", { baseUrl: account.baseUrl });
    await notifyStart(ctx).catch((err) => log.warn("notifystart failed", { err: String(err) }));

    let cursor = account.syncBuf ?? "";
    let consecutive = 0;
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;
    let staleUntil = 0;
    // 防重复投递：同一 message_id 只处理一次（游标异常/服务端重发时兜底）
    const seenMsgIds = new Set<string>();

    while (!controller.signal.aborted) {
      if (Date.now() < staleUntil) {
        try {
          await sleep(staleUntil - Date.now(), controller.signal);
        } catch {
          break;
        }
        staleUntil = 0;
        continue;
      }
      try {
        const resp: GetUpdatesResp = await getUpdates(ctx, { get_updates_buf: cursor }, nextTimeoutMs, controller.signal);
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms;

        const errcode = resp.errcode ?? 0;
        const isErr = (resp.ret !== undefined && resp.ret !== 0) || errcode !== 0;
        if (isErr) {
          const code = errcode !== 0 ? errcode : resp.ret ?? 0;
          if (code === STALE_TOKEN_ERRCODE) {
            log.error("bot token stale, pausing 1h (errcode -14)");
            staleUntil = Date.now() + STALE_PAUSE_MS;
            consecutive = 0;
            cb.onStale(account.id);
            continue;
          }
          consecutive += 1;
          log.error("getUpdates failed", { ret: resp.ret, errcode, errmsg: resp.errmsg, attempt: consecutive });
          const delay = consecutive >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) consecutive = 0;
          try {
            await sleep(delay, controller.signal);
          } catch {
            break;
          }
          continue;
        }

        consecutive = 0;
        cb.onAlive(account.id);

        if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
          cursor = resp.get_updates_buf;
          cb.onCursor(account.id, cursor);
        }

        for (const msg of resp.msgs ?? []) {
          // 防回环 1：iLink 会在 getUpdates 里镜像 bot 自己发出的消息，跳过自身回显
          if (msg.from_user_id && msg.from_user_id === account.id) continue;
          // 防回环 2：只处理用户消息；message_type 缺失时按 USER 处理（真实报文兼容）
          if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
          // 防重复投递：同一 message_id 只处理一次
          const dedupeKey = msg.message_id != null ? String(msg.message_id) : "";
          if (dedupeKey) {
            if (seenMsgIds.has(dedupeKey)) continue;
            seenMsgIds.add(dedupeKey);
            if (seenMsgIds.size > 500) {
              for (const k of [...seenMsgIds].slice(0, 250)) seenMsgIds.delete(k);
            }
          }
          const text = extractText(msg);
          log.info("inbound message", { from: msg.from_user_id, len: text.length, hasCtx: Boolean(msg.context_token) });
          await cb.onMessage(account, msg, text);
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        consecutive += 1;
        log.error("getUpdates error", { err: String(err), attempt: consecutive });
        const delay = consecutive >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) consecutive = 0;
        try {
          await sleep(delay, controller.signal);
        } catch {
          break;
        }
      }
    }

    await notifyStop(ctx).catch(() => {});
    log.info("monitor stopped");
  })();

  return {
    accountId: account.id,
    stop: async () => {
      controller.abort();
      await task;
    },
  };
}

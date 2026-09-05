// 单次收割：一次 getupdates 长轮询 + 消息处理 + 游标落库。
// 自部署常驻 monitor（while 循环）与 Workers 的三种入站策略（Cron 定时轮询 / Durable Object
// alarm 链 / 按需收割）共用同一条收割代码路径——「换驱动器，不动协议层」。
// 错误语义依据 recon.md §2.5 与 ilink-interface-and-serverless.md §5：
// - errcode -14 → bot_token 失效（回调 onStale，由调用方决定熔断/标记重绑）
// - 其他错误 → outcome="error"，由调用方决定重试节奏（常驻 2s/30s 退避；cron 跳过下一拍）

import { decryptString } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import type { AccountRow } from "../../repo/accounts.ts";
import type { Logger } from "../../log.ts";
import { MessageItemType, MessageType, type GetUpdatesResp, type WeixinMessage } from "./ilink/types.ts";
import { LONG_POLL_TIMEOUT_MS, STALE_TOKEN_ERRCODE } from "./ilink/constants.ts";
import { getUpdates, type ApiCtx } from "./ilink/client.ts";

export interface HarvestCallbacks {
  onMessage: (account: AccountRow, msg: WeixinMessage, text: string) => void | Promise<void>;
  onCursor: (accountId: string, cursor: string) => void | Promise<void>;
  onStale: (accountId: string) => void | Promise<void>;
  onAlive: (accountId: string) => void | Promise<void>;
}

export interface HarvestDeps {
  log: Logger;
  masterKey: Buffer;
  botAgent: string;
  db: Db;
  cb: HarvestCallbacks;
}

export interface HarvestOptions {
  /** 上游长轮询挂起上限；默认服务端 ~35s。cron/按需收割传更短的 hold 提前返回。 */
  holdMs?: number;
  /** 防重复投递（进程内存活期间有效；游标是权威去重，此集合兜底服务端重发） */
  seenMsgIds?: Set<string>;
  external?: AbortSignal;
}

export type HarvestOutcome = "ok" | "error" | "stale" | "aborted";

export interface HarvestResult {
  outcome: HarvestOutcome;
  /** 本次处理（含跳过）的消息条数 */
  messages: number;
  cursorAdvanced: boolean;
  /** 服务端建议的下次长轮询时长（resp.longpolling_timeout_ms），仅 outcome=ok 时可能存在 */
  serverHoldMs?: number;
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

export async function harvestOnce(deps: HarvestDeps, account: AccountRow, opts: HarvestOptions = {}): Promise<HarvestResult> {
  const log = deps.log.child({ acct: account.id });
  const ctx: ApiCtx = {
    baseUrl: account.baseUrl,
    token: decryptString(deps.masterKey, account.tokenEnc),
    botAgent: deps.botAgent,
  };
  const cursor = account.syncBuf ?? "";

  let resp: GetUpdatesResp;
  try {
    resp = await getUpdates(ctx, { get_updates_buf: cursor }, opts.holdMs ?? LONG_POLL_TIMEOUT_MS, opts.external);
  } catch (err) {
    if (opts.external?.aborted) return { outcome: "aborted", messages: 0, cursorAdvanced: false };
    log.error("getUpdates error", { err: String(err) });
    return { outcome: "error", messages: 0, cursorAdvanced: false };
  }

  const errcode = resp.errcode ?? 0;
  const isErr = (resp.ret !== undefined && resp.ret !== 0) || errcode !== 0;
  if (isErr) {
    const code = errcode !== 0 ? errcode : resp.ret ?? 0;
    if (code === STALE_TOKEN_ERRCODE) {
      log.error("bot token stale (errcode -14)");
      await deps.cb.onStale(account.id);
      return { outcome: "stale", messages: 0, cursorAdvanced: false };
    }
    log.error("getUpdates failed", { ret: resp.ret, errcode, errmsg: resp.errmsg });
    return { outcome: "error", messages: 0, cursorAdvanced: false };
  }

  await deps.cb.onAlive(account.id);

  let advanced = false;
  if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
    await deps.cb.onCursor(account.id, resp.get_updates_buf);
    advanced = true;
  }

  let count = 0;
  for (const msg of resp.msgs ?? []) {
    // 防回环 1：iLink 会在 getUpdates 里镜像 bot 自己发出的消息，跳过自身回显
    if (msg.from_user_id && msg.from_user_id === account.id) continue;
    // 防回环 2：只处理用户消息；message_type 缺失时按 USER 处理（真实报文兼容）
    if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
    // 防重复投递：同一 message_id 只处理一次
    const dedupeKey = msg.message_id != null ? String(msg.message_id) : "";
    if (dedupeKey && opts.seenMsgIds) {
      if (opts.seenMsgIds.has(dedupeKey)) continue;
      opts.seenMsgIds.add(dedupeKey);
      if (opts.seenMsgIds.size > 500) {
        for (const k of [...opts.seenMsgIds].slice(0, 250)) opts.seenMsgIds.delete(k);
      }
    }
    const text = extractText(msg);
    log.info("inbound message", { from: msg.from_user_id, len: text.length, hasCtx: Boolean(msg.context_token) });
    await deps.cb.onMessage(account, msg, text);
    count += 1;
  }

  return { outcome: "ok", messages: count, cursorAdvanced: advanced, serverHoldMs: resp.longpolling_timeout_ms };
}

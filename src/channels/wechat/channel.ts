import { decryptString } from "../../crypto.ts";
import type { Channel, ChannelAccountView, SendResult } from "../types.ts";
import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import type { Logger } from "../../log.ts";
import { getAccount, listAccounts, setAccountSyncBuf, touchAccountInbound, updateAccountStatus, type AccountRow } from "../../repo/accounts.ts";
import { addInboundLog } from "../../repo/logs.ts";
import { getPeerToken, upsertPeer } from "../../repo/peers.ts";
import { confirmLogin, getLoginView, startLogin as startLoginFlow, stopAllLoginDrivers, submitVerifyCode, type LoginDeps } from "./login.ts";
import { extractText, startMonitor, type MonitorHandle } from "./monitor.ts";
import { sendText } from "./sender.ts";
import type { ApiCtx } from "./ilink/client.ts";
import type { WeixinMessage } from "./ilink/types.ts";

export interface WechatChannelDeps {
  cfg: Config;
  log: Logger;
  db: Db;
  masterKey: Buffer;
  /** sendkey 哈希盐，与 core.salt 一致 */
  salt: string;
  /** 仅测试注入：覆盖登录默认入口 */
  ilinkBaseUrl?: string;
}

export interface WechatChannel extends Channel {
  /** 预热回调：某 peer 的新 context_token 捕获后触发（index.ts 里接到 push.flushOutbox）。 */
  onWarmup?: (accountId: string, peerUserId: string) => void | Promise<void>;
  /** 入站文本路由回调：token 已捕获，交由关键词路由器处理（index.ts 接线）。 */
  onInbound?: (accountId: string, fromUserId: string, text: string, msgId?: string) => void | Promise<void>;
}

export function createWechatChannel(deps: WechatChannelDeps): WechatChannel {
  const monitors = new Map<string, MonitorHandle>();
  const log = deps.log.child({ ch: "wechat" });
  const loginDeps: LoginDeps = {
    db: deps.db,
    masterKey: deps.masterKey,
    log,
    botAgent: deps.cfg.botAgent,
    salt: deps.salt,
    baseUrl: deps.ilinkBaseUrl,
  };

  function apiCtx(account: AccountRow): ApiCtx {
    return {
      baseUrl: account.baseUrl,
      token: decryptString(deps.masterKey, account.tokenEnc),
      botAgent: deps.cfg.botAgent,
    };
  }

  async function handleInbound(account: AccountRow, msg: WeixinMessage): Promise<void> {
    const from = msg.from_user_id ?? "";
    if (!from) return;
    const text = extractText(msg);
    const now = Date.now();
    touchAccountInbound(deps.db, account.id, now);
    if (msg.context_token) {
      upsertPeer(deps.db, account.id, from, msg.context_token, now);
      addInboundLog(deps.db, { ts: now, accountId: account.id, fromUserId: from, text, action: "warmup" });
      await channel.onWarmup?.(account.id, from);
    } else {
      addInboundLog(deps.db, { ts: now, accountId: account.id, fromUserId: from, text, action: "captured" });
    }
    if (text) {
      await channel.onInbound?.(account.id, from, text, msg.message_id != null ? String(msg.message_id) : undefined);
    }
  }

  const channel: WechatChannel = {
    id: "wechat",

    async startLogin() {
      return startLoginFlow(loginDeps);
    },

    async pollLogin(sessionId) {
      const row = getLoginView(loginDeps, sessionId);
      return { sessionId: row.id, status: row.status, qrcodeUrl: row.qrcodeUrl, message: row.message };
    },

    async submitVerifyCode(sessionId, code) {
      const row = submitVerifyCode(loginDeps, sessionId, code);
      return { sessionId: row.id, status: row.status, qrcodeUrl: row.qrcodeUrl, message: row.message };
    },

    async confirmLogin(sessionId) {
      return confirmLogin(loginDeps, sessionId);
    },

    async startAccount(accountId) {
      if (monitors.has(accountId)) return;
      const account = getAccount(deps.db, accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const handle = startMonitor(
        { log: deps.log, masterKey: deps.masterKey, botAgent: deps.cfg.botAgent },
        account,
        {
          onMessage: (acc, msg) => handleInbound(acc, msg),
          onCursor: (id, cursor) => setAccountSyncBuf(deps.db, id, cursor, Date.now()),
          onStale: (id) =>
            updateAccountStatus(deps.db, id, "paused", Date.now(), {
              pausedUntil: Date.now() + 60 * 60_000,
              lastError: "errcode -14: bot_token 失效",
            }),
          onAlive: (id) => {
            const a = getAccount(deps.db, id);
            if (a && a.status !== "active") updateAccountStatus(deps.db, id, "active", Date.now());
          },
        },
      );
      monitors.set(accountId, handle);
    },

    async stopAccount(accountId) {
      const handle = monitors.get(accountId);
      if (handle) {
        monitors.delete(accountId);
        await handle.stop();
      }
    },

    async send(accountId, peerUserId, text): Promise<SendResult> {
      const account = getAccount(deps.db, accountId);
      if (!account) return { ok: false, reason: "ERROR", error: `account ${accountId} not found` };
      const token = getPeerToken(deps.db, accountId, peerUserId);
      if (!token) return { ok: false, reason: "WARMUP_REQUIRED" };
      return sendText(apiCtx(account), peerUserId, text, token);
    },

    listStatuses(): ChannelAccountView[] {
      return listAccounts(deps.db).map((a) => ({
        accountId: a.id,
        label: a.label,
        status: a.status,
        lastInboundAt: a.lastInboundAt,
      }));
    },

    async shutdown() {
      stopAllLoginDrivers();
      for (const [id, handle] of [...monitors]) {
        monitors.delete(id);
        await handle.stop();
      }
    },
  };
  return channel;
}

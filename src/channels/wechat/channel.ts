import { decryptString } from "../../crypto.ts";
import type { Channel, ChannelAccountView, SendResult } from "../types.ts";
import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import type { Logger } from "../../log.ts";
import { deleteAccount, getAccount, listAccounts, setAccountSyncBuf, touchAccountInbound, updateAccountStatus, type AccountRow } from "../../repo/accounts.ts";
import { addInboundLog } from "../../repo/logs.ts";
import { deleteAccountKeywords } from "../../repo/keywords.ts";
import { deleteAccountPeers, getPeerToken, upsertPeer } from "../../repo/peers.ts";
import { revokeSendkeys } from "../../repo/sendkeys.ts";
import { confirmLogin, getLoginView, pollLoginOnce, startLogin as startLoginFlow, stopAllLoginDrivers, submitVerifyCode, type LoginDeps } from "./login.ts";
import { extractText, harvestOnce, type HarvestCallbacks, type HarvestResult } from "./harvest.ts";
import { startMonitor, type MonitorHandle } from "./monitor.ts";
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
  /**
   * 入站策略：resident（默认）= 进程内常驻 monitor 长轮询；
   * cron / do = 收割由外部驱动（Workers scheduled / Durable Object alarm），startAccount 不启动常驻循环。
   */
  monitorMode?: "resident" | "cron" | "do";
  /** 绑定状态机推进方式：driver（默认，常驻后台）| request（每次 pollLogin 推进一步，Workers）。 */
  pollMode?: "driver" | "request";
  /** 仅测试注入：覆盖登录默认入口 */
  ilinkBaseUrl?: string;
}

export interface WechatChannel extends Channel {
  /** 预热回调：某 peer 捕获（含刷新）context_token 后触发（index.ts 里接到 push.flushOutbox）。 */
  onWarmup?: (accountId: string, peerUserId: string) => void | Promise<void>;
  /** 入站文本路由回调：仅对已建联（此前已捕获 context_token）peer 的消息触发（index.ts 接线）。 */
  onInbound?: (accountId: string, fromUserId: string, text: string, msgId?: string) => void | Promise<void>;
}

export function createWechatChannel(deps: WechatChannelDeps): WechatChannel {
  const monitorMode = deps.monitorMode ?? "resident";
  const monitors = new Map<string, MonitorHandle>();
  const log = deps.log.child({ ch: "wechat" });
  const loginDeps: LoginDeps = {
    db: deps.db,
    masterKey: deps.masterKey,
    log,
    botAgent: deps.cfg.botAgent,
    salt: deps.salt,
    baseUrl: deps.ilinkBaseUrl,
    pollMode: deps.pollMode,
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
    // 建联判定：本条消息之前该 peer 是否已有 context_token。没有则通道对该 peer 尚未连接，
    // 本条消息只用于建联（捕获 token、补发排队推送），不进关键词路由——
    // 避免新用户绑定后按指引发送的首条消息被当成指令、收到「未识别的指令」回执。
    const connected = Boolean(await getPeerToken(deps.db, account.id, from));
    await touchAccountInbound(deps.db, account.id, now);
    if (msg.context_token) {
      await upsertPeer(deps.db, account.id, from, msg.context_token, now);
      await addInboundLog(deps.db, { ts: now, accountId: account.id, fromUserId: from, text, action: connected ? "captured" : "warmup" });
      await channel.onWarmup?.(account.id, from);
    } else {
      await addInboundLog(deps.db, { ts: now, accountId: account.id, fromUserId: from, text, action: "captured" });
    }
    if (text && connected) {
      await channel.onInbound?.(account.id, from, text, msg.message_id != null ? String(msg.message_id) : undefined);
    }
  }

  /** monitor 与外部驱动器（cron/DO/按需收割）共用的收割回调集。 */
  function harvestCallbacks(): HarvestCallbacks {
    return {
      onMessage: (acc, msg) => handleInbound(acc, msg),
      onCursor: (id, cursor) => setAccountSyncBuf(deps.db, id, cursor, Date.now()),
      onStale: (id) =>
        updateAccountStatus(deps.db, id, "paused", Date.now(), {
          pausedUntil: Date.now() + 60 * 60_000,
          lastError: "errcode -14: bot_token 失效",
        }),
      onAlive: async (id) => {
        const a = await getAccount(deps.db, id);
        if (a && a.status !== "active") await updateAccountStatus(deps.db, id, "active", Date.now());
      },
    };
  }

  const channel: WechatChannel = {
    id: "wechat",

    async startLogin() {
      return startLoginFlow(loginDeps);
    },

    async pollLogin(sessionId) {
      const row =
        (loginDeps.pollMode ?? "driver") === "request"
          ? await pollLoginOnce(loginDeps, sessionId)
          : await getLoginView(loginDeps, sessionId);
      return { sessionId: row.id, status: row.status, qrcodeUrl: row.qrcodeUrl, message: row.message };
    },

    async submitVerifyCode(sessionId, code) {
      const row = await submitVerifyCode(loginDeps, sessionId, code);
      return { sessionId: row.id, status: row.status, qrcodeUrl: row.qrcodeUrl, message: row.message };
    },

    async confirmLogin(sessionId) {
      const r = await confirmLogin(loginDeps, sessionId);
      // 同一用户重新绑定：清理同 userId 的旧账号（官方 clearStaleAccountsForUserId 语义），
      // 避免重复占用席位与产生歧义路由目标。
      if (r.ownerUserId) {
        for (const a of await listAccounts(deps.db)) {
          if (a.id !== r.accountId && a.ownerUserId === r.ownerUserId) {
            log.info("removing stale account for re-bound user", { stale: a.id, user: r.ownerUserId });
            await channel.removeAccount(a.id);
          }
        }
      }
      return r;
    },

    async startAccount(accountId) {
      if (monitorMode !== "resident") return; // cron/do 模式：收割由外部驱动
      if (monitors.has(accountId)) return;
      const account = await getAccount(deps.db, accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const handle = startMonitor(
        { log: deps.log, masterKey: deps.masterKey, botAgent: deps.cfg.botAgent, db: deps.db },
        account,
        harvestCallbacks(),
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

    async removeAccount(accountId) {
      await this.stopAccount(accountId, "removed");
      await revokeSendkeys(deps.db, accountId, Date.now());
      await deleteAccountKeywords(deps.db, accountId);
      await deleteAccountPeers(deps.db, accountId);
      await deleteAccount(deps.db, accountId);
      log.info("account removed", { accountId });
    },

    async send(accountId, peerUserId, text): Promise<SendResult> {
      const account = await getAccount(deps.db, accountId);
      if (!account) return { ok: false, reason: "ERROR", error: `account ${accountId} not found` };
      const token = await getPeerToken(deps.db, accountId, peerUserId);
      if (!token) return { ok: false, reason: "WARMUP_REQUIRED" };
      return sendText(apiCtx(account), peerUserId, text, token);
    },

    async harvest(accountId, opts): Promise<HarvestResult> {
      const account = await getAccount(deps.db, accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      return harvestOnce(
        { log: deps.log, masterKey: deps.masterKey, botAgent: deps.cfg.botAgent, db: deps.db, cb: harvestCallbacks() },
        account,
        opts,
      );
    },

    async listStatuses(): Promise<ChannelAccountView[]> {
      return (await listAccounts(deps.db)).map((a) => ({
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

// 装配层（平台无关）：把 config/db/crypto/通道/push/路由组装成完整应用。
// 平台边缘（Bun.serve、fs 引导、Workers scheduled/DO）留在各自入口文件——
// 自部署：src/index.ts；Workers：src/entries/worker.ts。

import type { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { Logger } from "../log.ts";
import type { Core } from "../core.ts";
import type { PushService } from "../core/push.ts";
import type { RateLimiter } from "../api/ratelimit.ts";
import type { UpdateChecker } from "../update/checker.ts";
import type { WechatChannel } from "../channels/wechat/channel.ts";
import type { MailService } from "../mail/service.ts";
import type { WindowWarner } from "../core/warn.ts";
import { createRegistry } from "../channels/registry.ts";
import { createWechatChannel } from "../channels/wechat/channel.ts";
import { createPushService } from "../core/push.ts";
import { createInboundRouter } from "../router/inbound.ts";
import { createWindowWarner } from "../core/warn.ts";
import { createRateLimiter, createD1RateLimiter } from "../api/ratelimit.ts";
import { createApp } from "../app.ts";
import { tryHarvestBeforeSend } from "../core/ingest.ts";

export interface AssembleOptions {
  cfg: Config;
  log: Logger;
  db: Db;
  masterKey: Buffer;
  salt: string;
  adminToken: string;
  /** "memory"（默认，自部署）| "d1"（Workers：多隔离体间内存不共享） */
  limiterKind?: "memory" | "d1";
  /**
   * 邮件桥工厂：仅自部署传入（index.ts 传 createMailService）。
   * 以注入代替静态 import——Workers 打包图里不出现 imapflow/nodemailer（TCP 长连接不可用）。
   */
  mailFactory?: (core: Core, push: PushService) => MailService;
  /** 注入可测试；缺省按 cfg 创建真实检测器（version 为空时惰性自短路） */
  updateChecker?: UpdateChecker;
}

export interface AssembledApp {
  core: Core;
  push: PushService;
  wechat: WechatChannel;
  limiter: RateLimiter;
  app: Hono;
  warner: WindowWarner;
  mail?: MailService;
}

export function assembleApp(opts: AssembleOptions): AssembledApp {
  const { cfg, log, db, masterKey, salt, adminToken } = opts;

  const channels = createRegistry();
  const wechat = createWechatChannel({
    cfg,
    log,
    db,
    masterKey,
    salt,
    monitorMode: cfg.ingestMode === "resident" ? "resident" : cfg.ingestMode,
    // 常驻形态绑定状态机由后台驱动推进；无常驻形态（Workers）由 pollLogin 请求驱动
    pollMode: cfg.ingestMode === "resident" ? "driver" : "request",
  });
  channels.register(wechat);

  const core: Core = { cfg, log, db, masterKey, salt, adminToken, channels };
  const push = createPushService(core, {
    // 方案3（按需收割）：非 resident 且开启时，推送前抢租约短收割刷新 context_token
    onWarmupHarvest:
      cfg.ondemandHarvest === "on" && cfg.ingestMode !== "resident"
        ? (accountId, peerUserId) => tryHarvestBeforeSend(core, wechat, accountId, peerUserId)
        : undefined,
  });
  // 预热自愈接线：入站消息捕获新 context_token → 重发该 peer 的排队推送
  wechat.onWarmup = (accountId, peerUserId) => push.flushOutbox(accountId, peerUserId);
  // 入站路由接线：内置命令 / 关键词转发 / 未命中提醒
  const inboundRouter = createInboundRouter(core);
  wechat.onInbound = (accountId, fromUserId, text, msgId) => inboundRouter.handle(accountId, fromUserId, text, msgId);

  let mail: MailService | undefined;
  if (opts.mailFactory) {
    // 邮件桥（M5，可选）：未配置账号时不产生任何轮询
    core.mail = opts.mailFactory(core, push);
    mail = core.mail;
  }

  // 24h 推送窗口临期提醒：常驻形态由入口定时器驱动；Workers 形态挂进 scheduled 唤醒
  const warner = createWindowWarner(core);
  const limiter =
    opts.limiterKind === "d1"
      ? createD1RateLimiter(db, cfg.sendRatePerHour, cfg.sendBurst)
      : createRateLimiter(cfg.sendRatePerHour, cfg.sendBurst);
  const app = createApp({ core, push, wechat, limiter, updateChecker: opts.updateChecker });

  return { core, push, wechat, limiter, app, warner, mail };
}

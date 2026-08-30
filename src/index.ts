// 启动边缘：fs/env/process 等运行时 API 集中在这里与 config/db/log 模块（dev-plan §1）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRegistry } from "./channels/registry.ts";
import { createWechatChannel } from "./channels/wechat/channel.ts";
import { loadConfig } from "./config.ts";
import { deriveKey } from "./crypto.ts";
import { closeDb, openDb } from "./db/index.ts";
import { createPushService } from "./core/push.ts";
import type { Core } from "./core.ts";
import { getSetting, setSetting } from "./repo/settings.ts";
import { expireOutbox } from "./repo/outbox.ts";
import { gcLogs } from "./repo/logs.ts";
import { listAccounts } from "./repo/accounts.ts";
import { createLogger } from "./log.ts";
import { createRateLimiter } from "./api/ratelimit.ts";
import { createApp } from "./app.ts";
import { createInboundRouter } from "./router/inbound.ts";
import { createMailService } from "./mail/service.ts";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel, { svc: "ssc" });

mkdirSync(cfg.dataDir, { recursive: true });
const db = openDb(cfg.dbPath);

// ---- 主密钥引导：优先 SSC_SECRET，否则生成 data/secret.key（随 data 卷持久化） ----
let salt = getSetting(db, "crypto_salt");
if (!salt) {
  salt = randomBytes(16).toString("base64");
  setSetting(db, "crypto_salt", salt);
}
let secret = cfg.secret;
if (!secret) {
  const keyFile = join(cfg.dataDir, "secret.key");
  if (existsSync(keyFile)) {
    secret = readFileSync(keyFile, "utf8").trim();
  } else {
    secret = randomBytes(32).toString("hex");
    writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
    log.warn("SSC_SECRET 未设置：已生成随机主密钥文件；丢弃 data 卷将导致已存凭据无法解密", { keyFile });
  }
}
const masterKey = deriveKey(secret, salt);

// ---- admin token 引导：优先 SSC_ADMIN_TOKEN，否则生成并打印一次 ----
let adminToken = cfg.adminToken ?? getSetting(db, "admin_token");
if (!adminToken) {
  adminToken = randomBytes(24).toString("hex");
  setSetting(db, "admin_token", adminToken);
  log.warn("SSC_ADMIN_TOKEN 未设置：已生成管理令牌，请立即保存", { adminToken });
}

// ---- 装配 ----
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey, salt });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey, salt, adminToken, channels };
const push = createPushService(core);
// 预热自愈接线：入站消息捕获新 context_token → 重发该 peer 的排队推送
wechat.onWarmup = (accountId, peerUserId) => push.flushOutbox(accountId, peerUserId);
// 入站路由接线：内置命令 / 关键词转发 / 未命中提醒
const inboundRouter = createInboundRouter(core);
wechat.onInbound = (accountId, fromUserId, text, msgId) => inboundRouter.handle(accountId, fromUserId, text, msgId);
// 邮件桥（M5，可选）：未配置账号时不产生任何轮询
core.mail = createMailService(core, push);
core.mail.startAll();

const limiter = createRateLimiter(cfg.sendRatePerHour, cfg.sendBurst);
const app = createApp({ core, push, wechat, limiter });

const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
log.info("gateway started", { port: server.port, host: cfg.host, dataDir: cfg.dataDir, channels: channels.ids() });

// ---- 启动已绑定账号的收信 monitor（rebind_needed 的需要重扫，不自动启动） ----
for (const account of listAccounts(db).filter((a) => a.status !== "rebind_needed")) {
  wechat
    .startAccount(account.id)
    .then(() => log.info("monitor resumed", { accountId: account.id }))
    .catch((err) => log.error("monitor resume failed", { accountId: account.id, err: String(err) }));
}

// ---- 周期维护：日志保留期 GC + outbox 过期 ----
const gcTimer = setInterval(
  () => {
    const now = Date.now();
    try {
      gcLogs(db, now - 30 * 24 * 60 * 60 * 1000);
      expireOutbox(db, now);
    } catch (err) {
      log.warn("gc failed", { err: String(err) });
    }
  },
  60 * 60 * 1000,
);
gcTimer.unref?.();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  clearInterval(gcTimer);
  await core.mail?.shutdown();
  await wechat.shutdown();
  server.stop(true);
  closeDb(db);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

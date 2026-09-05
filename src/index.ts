// 启动边缘（自部署 Bun 形态）：fs/env/process 等运行时 API 集中在这里与 config/db/log 模块
// （dev-plan §1）。Docker/裸机部署入口；Cloudflare Workers 入口见 src/entries/worker.ts。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { deriveKey } from "./crypto.ts";
import { closeDb, openDb } from "./db/index.ts";
import { listAccounts } from "./repo/accounts.ts";
import { expireOutbox } from "./repo/outbox.ts";
import { gcLogs } from "./repo/logs.ts";
import { createLogger } from "./log.ts";
import { createMailService } from "./mail/service.ts";
import { assembleApp } from "./runtime/assemble.ts";
import { ensureAdminToken, ensureSalt, ensureSecretSelfhosted } from "./runtime/bootstrap.ts";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel, { svc: "servermoe" });

// 自部署形态无常驻后端之外的全局单例，cron/do 两种入站策略仅 Workers 支持；回退并提示
if (cfg.ingestMode !== "resident") {
  log.warn("MOE_INGEST_MODE 仅在 Cloudflare Workers 形态生效；自部署保持 resident（常驻 monitor）", {
    requested: cfg.ingestMode,
  });
}

mkdirSync(cfg.dataDir, { recursive: true });
const db = openDb(cfg.dbPath);

// ---- 主密钥引导：优先 MOE_SECRET/SSC_SECRET，否则生成 data/secret.key（随 data 卷持久化） ----
const salt = await ensureSalt(db);
const { secret } = await ensureSecretSelfhosted(
  db,
  cfg.secret,
  (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : undefined),
  (p, content) => writeFileSync(p, content, { mode: 0o600 }),
  join(cfg.dataDir, "secret.key"),
  log,
);
const masterKey = deriveKey(secret, salt);
const adminToken = await ensureAdminToken(db, cfg.adminToken, log);

// ---- 装配 ----
const rt = assembleApp({ cfg, log, db, masterKey, salt, adminToken, limiterKind: "memory", mailFactory: createMailService });
const { core, wechat, app, warner, mail } = rt;

const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
log.info("gateway started", {
  port: server.port,
  host: cfg.host,
  dataDir: cfg.dataDir,
  channels: core.channels.ids(),
  ingestMode: cfg.ingestMode,
});

// ---- 邮件桥：启动已配置账号的轮询 ----
await mail?.startAll();

// ---- 启动已绑定账号的收信 monitor（rebind_needed 的需要重扫，不自动启动） ----
for (const account of (await listAccounts(db)).filter((a) => a.status !== "rebind_needed")) {
  wechat
    .startAccount(account.id)
    .then(() => log.info("monitor resumed", { accountId: account.id }))
    .catch((err) => log.error("monitor resume failed", { accountId: account.id, err: String(err) }));
}

// ---- 24h 窗口临期提醒 ----
warner.start();

// ---- 周期维护：日志保留期 GC + outbox 过期 ----
const gcTimer = setInterval(() => {
  const now = Date.now();
  void (async () => {
    try {
      await gcLogs(db, now - 30 * 24 * 60 * 60 * 1000);
      await expireOutbox(db, now);
    } catch (err) {
      log.warn("gc failed", { err: String(err) });
    }
  })();
}, 60 * 60 * 1000);
gcTimer.unref?.();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  clearInterval(gcTimer);
  warner.shutdown();
  await core.mail?.shutdown();
  await wechat.shutdown();
  server.stop(true);
  closeDb(db);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

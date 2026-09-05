// Workers 运行时构建与 per-isolate 缓存。worker.ts（默认导出）与 poller.ts（Durable Object）
// 同属一个 Worker 脚本，共享本模块的 memo——每个 isolate 只构建一次运行时。

import { loadConfig, type Config } from "../config.ts";
import { createLogger, type Logger } from "../log.ts";
import { openD1 } from "../db/d1.ts";
import { ensureSchema } from "../db/client.ts";
import { assembleApp, type AssembledApp } from "../runtime/assemble.ts";
import { ensureAdminToken, ensureSalt, ensureSecretInDb } from "../runtime/bootstrap.ts";
import { deriveKeyWorkers } from "../runtime/kdf.ts";

export interface Env {
  DB: D1Database;
  /** 方案2（do 模式）使用；wrangler.jsonc 配置 durable_objects 绑定后生效 */
  POLLER?: DurableObjectNamespace;
  [key: string]: unknown;
}

export interface Runtime extends AssembledApp {
  cfg: Config;
  log: Logger;
}

let runtimePromise: Promise<Runtime> | null = null;

/** 每 isolate 构建一次运行时（KDF/引导只付一次成本）；失败不缓存以便重试。 */
export function getRuntime(env: Env): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = buildRuntime(env).catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function buildRuntime(env: Env): Promise<Runtime> {
  // Workers 绑定对象混在 env 里，loadConfig 只读 MOE_*/SSC_* 字符串键
  const envVars = env as unknown as Record<string, string | undefined>;
  const parsed = loadConfig(envVars);
  // Workers 无常驻 isolate 生命周期，resident 不可用；回退 cron 并提示
  const cfg = parsed.ingestMode === "resident" ? { ...parsed, ingestMode: "cron" as const } : parsed;
  const log = createLogger(cfg.logLevel, { svc: "servermoe", platform: "workers" });
  if (parsed.ingestMode === "resident") {
    log.warn("MOE_INGEST_MODE=resident 在 Workers 上不可用，已回退 cron", { requested: parsed.ingestMode });
  }

  const db = openD1(env.DB);
  await ensureSchema(db);

  const salt = await ensureSalt(db);
  const { secret, generated } = await ensureSecretInDb(db, cfg.secret, log);
  const masterKey = await deriveKeyWorkers(secret, salt, generated);
  const adminToken = await ensureAdminToken(db, cfg.adminToken, log);

  const rt = assembleApp({ cfg, log, db, masterKey, salt, adminToken, limiterKind: "d1" });
  log.info("worker runtime ready", { ingestMode: cfg.ingestMode, pollIntervalDefault: cfg.pollIntervalSec });
  return { ...rt, cfg, log };
}

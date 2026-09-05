import { z } from "zod";

const envSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  host: z.string().default("0.0.0.0"),
  dataDir: z.string().default("data"),
  dbPath: z.string().optional(),
  secret: z.string().optional(),
  adminToken: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  botAgent: z.string().default("ServerMoe"),
  textChunkLimit: z.coerce.number().int().min(500).max(4000).default(3000),
  sendRatePerHour: z.coerce.number().int().min(1).default(60),
  sendBurst: z.coerce.number().int().min(1).default(10),
  seatLimit: z.coerce.number().int().min(1).default(5),
  /** 构建期注入的版本号（官方镜像由 release workflow 传 tag）。缺省 = 自构建，跳过更新检测 */
  version: z.string().optional(),
  /** 更新检测指向的 GitHub 仓库（fork 可改指自己的镜像仓库） */
  updateRepo: z.string().default("lbls741/ServerMoe"),
  /**
   * 入站收割策略（「微信→本项目」方向）：
   * - resident（默认）：进程内常驻 monitor 长轮询（Docker/裸机形态）；
   * - cron：Workers Cron Trigger 定时唤醒收割（方案1，频率经 settings.poll_interval_sec 可调）；
   * - do：Durable Object alarm 链收割（方案2）。
   */
  ingestMode: z.enum(["resident", "cron", "do"]).default("resident"),
  /** 定时轮询间隔默认值（秒）；实际生效值以 settings.poll_interval_sec（管理页可改）优先 */
  pollIntervalSec: z.coerce.number().int().min(10).max(86400).default(300),
  /** 按需收割（方案3）：推送前抢租约做一次短收割刷新 context_token。resident 模式忽略。 */
  ondemandHarvest: z.enum(["on", "off"]).default("off"),
});

export type Config = z.infer<typeof envSchema> & { dbPath: string };

function envGet(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function envToInput(env: Record<string, string | undefined>) {
  // 变量前缀 MOE_；SSC_ 为改名前的旧前缀，继续兼容已部署环境
  return {
    port: envGet(env, "MOE_PORT", "SSC_PORT"),
    host: envGet(env, "MOE_HOST", "SSC_HOST"),
    dataDir: envGet(env, "MOE_DATA_DIR", "SSC_DATA_DIR"),
    dbPath: envGet(env, "MOE_DB_PATH", "SSC_DB_PATH"),
    secret: envGet(env, "MOE_SECRET", "SSC_SECRET"),
    adminToken: envGet(env, "MOE_ADMIN_TOKEN", "SSC_ADMIN_TOKEN"),
    logLevel: envGet(env, "MOE_LOG_LEVEL", "SSC_LOG_LEVEL"),
    botAgent: envGet(env, "MOE_BOT_AGENT", "SSC_BOT_AGENT"),
    textChunkLimit: envGet(env, "MOE_TEXT_CHUNK_LIMIT", "SSC_TEXT_CHUNK_LIMIT"),
    sendRatePerHour: envGet(env, "MOE_SEND_RATE_PER_HOUR", "SSC_SEND_RATE_PER_HOUR"),
    sendBurst: envGet(env, "MOE_SEND_BURST", "SSC_SEND_BURST"),
    seatLimit: envGet(env, "MOE_SEAT_LIMIT", "SSC_SEAT_LIMIT"),
    version: envGet(env, "MOE_VERSION", "SSC_VERSION"),
    updateRepo: envGet(env, "MOE_UPDATE_REPO", "SSC_UPDATE_REPO"),
    ingestMode: envGet(env, "MOE_INGEST_MODE", "SSC_INGEST_MODE"),
    pollIntervalSec: envGet(env, "MOE_POLL_INTERVAL_SEC", "SSC_POLL_INTERVAL_SEC"),
    ondemandHarvest: envGet(env, "MOE_ONDEMAND_HARVEST", "SSC_ONDEMAND_HARVEST"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(envToInput(env));
  return { ...parsed, dbPath: parsed.dbPath ?? `${parsed.dataDir}/gateway.db` };
}

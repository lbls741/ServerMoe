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
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(envToInput(env));
  return { ...parsed, dbPath: parsed.dbPath ?? `${parsed.dataDir}/gateway.db` };
}

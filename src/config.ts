import { z } from "zod";

const envSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  host: z.string().default("0.0.0.0"),
  dataDir: z.string().default("data"),
  dbPath: z.string().optional(),
  secret: z.string().optional(),
  adminToken: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  botAgent: z.string().default("SuperServerChan"),
  textChunkLimit: z.coerce.number().int().min(500).max(4000).default(3000),
  sendRatePerHour: z.coerce.number().int().min(1).default(60),
  sendBurst: z.coerce.number().int().min(1).default(10),
  seatLimit: z.coerce.number().int().min(1).default(5),
});

export type Config = z.infer<typeof envSchema> & { dbPath: string };

function envToInput(env: Record<string, string | undefined>) {
  return {
    port: env.SSC_PORT,
    host: env.SSC_HOST,
    dataDir: env.SSC_DATA_DIR,
    dbPath: env.SSC_DB_PATH,
    secret: env.SSC_SECRET,
    adminToken: env.SSC_ADMIN_TOKEN,
    logLevel: env.SSC_LOG_LEVEL,
    botAgent: env.SSC_BOT_AGENT,
    textChunkLimit: env.SSC_TEXT_CHUNK_LIMIT,
    sendRatePerHour: env.SSC_SEND_RATE_PER_HOUR,
    sendBurst: env.SSC_SEND_BURST,
    seatLimit: env.SSC_SEAT_LIMIT,
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(envToInput(env));
  return { ...parsed, dbPath: parsed.dbPath ?? `${parsed.dataDir}/gateway.db` };
}

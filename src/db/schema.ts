import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** status: active=正常 | paused=熔断中(-14) | rebind_needed=token 失效需重扫 */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), // ilink_bot_id
  label: text("label").notNull().default(""),
  tokenEnc: text("token_enc").notNull(),
  baseUrl: text("base_url").notNull(),
  ownerUserId: text("owner_user_id").notNull().default(""),
  status: text("status").notNull().default("active"),
  pausedUntil: integer("paused_until"),
  lastError: text("last_error"),
  lastInboundAt: integer("last_inbound_at"),
  /** 24h 推送窗口临期提醒（core/warn.ts）：开关 / 自定义文案 / 提前量秒（null=默认） */
  warnEnabled: integer("warn_enabled", { mode: "boolean" }).notNull().default(false),
  warnText: text("warn_text"),
  warnLeadSec: integer("warn_lead_sec"),
  /** 当前静默窗口内最近一次提醒时刻；与 last_inbound_at 比较实现「每窗口至多一条」 */
  warnedAt: integer("warned_at"),
  syncBuf: text("sync_buf").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 每个 (账号, 对端用户) 只保留最新 context_token；无 TTL，失效靠发送 ret=-2 被动发现。 */
export const peers = sqliteTable(
  "peers",
  {
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    contextToken: text("context_token").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] })],
);

export const sendkeys = sqliteTable(
  "sendkeys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    keyHash: text("key_hash").notNull().unique(),
    accountId: text("account_id").notNull(),
    label: text("label").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("sendkeys_account_idx").on(t.accountId)],
);

export const keywords = sqliteTable(
  "keywords",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id").notNull(),
    keyword: text("keyword").notNull(),
    matchMode: text("match_mode", { enum: ["exact", "prefix", "contains", "regex"] }).notNull(),
    url: text("url").notNull(),
    secretEnc: text("secret_enc"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("keywords_account_keyword_uq").on(t.accountId, t.keyword)],
);

/** status: sent | warmup_required | queued | failed | rate_limited */
export const pushLog = sqliteTable(
  "push_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    sendkeyId: integer("sendkey_id"),
    accountId: text("account_id"),
    peerUserId: text("peer_user_id"),
    title: text("title").notNull(),
    desp: text("desp").notNull().default(""),
    short: text("short"),
    extra: text("extra"), // JSON: tags/channel/openid/noip 等接受但暂不使用的参数
    status: text("status").notNull(),
    error: text("error"),
    clientId: text("client_id"),
    ip: text("ip"),
  },
  (t) => [index("push_log_ts_idx").on(t.ts)],
);

/** action: forwarded | no_match | builtin | error */
export const inboundLog = sqliteTable(
  "inbound_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    accountId: text("account_id").notNull(),
    fromUserId: text("from_user_id").notNull(),
    text: text("text").notNull().default(""),
    matchedKeywordId: integer("matched_keyword_id"),
    action: text("action").notNull(),
    reply: text("reply"),
  },
  (t) => [index("inbound_log_ts_idx").on(t.ts)],
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at").notNull(),
    sendkeyId: integer("sendkey_id"),
    accountId: text("account_id").notNull(),
    peerUserId: text("peer_user_id").notNull(),
    title: text("title").notNull(),
    desp: text("desp").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending | sent | expired
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("outbox_pending_idx").on(t.status, t.expiresAt)],
);

/** 绑定向导会话：iLink 二维码绑定流程的状态暂存 */
export const loginSessions = sqliteTable("login_sessions", {  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  status: text("status").notNull(), // wait|scaned|need_verifycode|verify_code_blocked|confirmed|expired|failed
  qrcode: text("qrcode").notNull(),
  qrcodeUrl: text("qrcode_url").notNull(),
  refreshCount: integer("refresh_count").notNull().default(0),
  pollHost: text("poll_host"), // IDC 迁移后的轮询域名
  /** 请求驱动轮询（Workers，login.ts pollLoginOnce）的上游防抖时间戳；driver 模式不使用 */
  lastPollAt: integer("last_poll_at"),
  verifyCode: text("verify_code"),
  botId: text("bot_id"),
  tokenEnc: text("token_enc"),
  baseUrl: text("base_url"),
  userId: text("user_id"),
  message: text("message"),
});

/** 邮件桥配置（每账号一份）。imap/smtp 凭据整体 AES 加密存储。 */
export const mailConfigs = sqliteTable("mail_configs", {
  accountId: text("account_id").primaryKey(),
  imapEnc: text("imap_enc").notNull(),
  smtpEnc: text("smtp_enc").notNull(),
  from: text("from"),
  pollSec: integer("poll_sec").notNull().default(60),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  uidValidity: text("uid_validity"),
  lastUid: integer("last_uid"),
  lastPollAt: integer("last_poll_at"),
  lastError: text("last_error"),
});

/**
 * 每 sendkey 令牌桶的持久化形态（api/ratelimit.ts 的 D1 实现）。
 * 自部署用内存实现即可；Workers 多隔离体间内存不共享，落到 DB 做原子扣减。
 */
export const rateBuckets = sqliteTable("rate_buckets", {
  key: text("key").primaryKey(),
  tokens: real("tokens").notNull(),
  last: integer("last").notNull(),
});

/**
 * 按需收割租约（core/ingest 方案3）：发送前抢租约做一次短收割，
 * 与 cron/DO 收割互斥，守住 iLink「同一 bot_token 同一时间只允许一个 getupdates 消费者」约束。
 */
export const ingestLeases = sqliteTable("ingest_leases", {
  accountId: text("account_id").primaryKey(),
  /** 租约到期时刻（epoch ms）；早于 now 可抢 */
  leasedUntil: integer("leased_until").notNull(),
  lastPollAt: integer("last_poll_at"),
});

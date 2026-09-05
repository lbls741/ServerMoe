// 平台中立的 DB 客户端层：统一 Db 类型（bun:sqlite 同步驱动与 D1 异步驱动的公共基类）
// 与 Workers 用的幂等建表 DDL。bun:sqlite 与 D1 驱动分别隔离在 db/index.ts 与 db/d1.ts。

import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

/** 业务层统一 DB 类型：bun:sqlite（同步）与 D1（异步）驱动的公共基类。查询结果为 T[] | Promise<T[]>，业务层一律 await。 */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

/**
 * Workers 专用幂等建表（CREATE TABLE IF NOT EXISTS），与 src/db/migrations/ 的最终形态一致。
 * drizzle 的 migrate() 依赖文件系统读取迁移目录，Workers 上不可用；D1 由本函数负责建表。
 * 自部署路径不使用（openDb 内的 drizzle migrate 为准）。新增表/列时必须同步维护此 DDL。
 */
export const SCHEMA_DDL: readonly string[] = [
  // 0000 + 0003（accounts 含 warn 列）
  `CREATE TABLE IF NOT EXISTS accounts (
    id text PRIMARY KEY NOT NULL,
    label text DEFAULT '' NOT NULL,
    token_enc text NOT NULL,
    base_url text NOT NULL,
    owner_user_id text DEFAULT '' NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    paused_until integer,
    last_error text,
    last_inbound_at integer,
    warn_enabled integer DEFAULT false NOT NULL,
    warn_text text,
    warn_lead_sec integer,
    warned_at integer,
    sync_buf text DEFAULT '' NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbound_log (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    ts integer NOT NULL,
    account_id text NOT NULL,
    from_user_id text NOT NULL,
    text text DEFAULT '' NOT NULL,
    matched_keyword_id integer,
    action text NOT NULL,
    reply text
  )`,
  `CREATE INDEX IF NOT EXISTS inbound_log_ts_idx ON inbound_log (ts)`,
  `CREATE TABLE IF NOT EXISTS keywords (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    account_id text NOT NULL,
    keyword text NOT NULL,
    match_mode text NOT NULL,
    url text NOT NULL,
    secret_enc text,
    enabled integer DEFAULT true NOT NULL,
    created_at integer NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS keywords_account_keyword_uq ON keywords (account_id, keyword)`,
  // 0000 + 0001（login_sessions 含 refresh_count/poll_host/last_poll_at）
  `CREATE TABLE IF NOT EXISTS login_sessions (
    id text PRIMARY KEY NOT NULL,
    created_at integer NOT NULL,
    expires_at integer NOT NULL,
    status text NOT NULL,
    qrcode text NOT NULL,
    qrcode_url text NOT NULL,
    refresh_count integer DEFAULT 0 NOT NULL,
    poll_host text,
    last_poll_at integer,
    verify_code text,
    bot_id text,
    token_enc text,
    base_url text,
    user_id text,
    message text
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    created_at integer NOT NULL,
    sendkey_id integer,
    account_id text NOT NULL,
    peer_user_id text NOT NULL,
    title text NOT NULL,
    desp text DEFAULT '' NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    expires_at integer NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS peers (
    account_id text NOT NULL,
    user_id text NOT NULL,
    context_token text NOT NULL,
    updated_at integer NOT NULL,
    PRIMARY KEY(account_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS push_log (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    ts integer NOT NULL,
    sendkey_id integer,
    account_id text,
    peer_user_id text,
    title text NOT NULL,
    desp text DEFAULT '' NOT NULL,
    short text,
    extra text,
    status text NOT NULL,
    error text,
    client_id text,
    ip text
  )`,
  `CREATE INDEX IF NOT EXISTS push_log_ts_idx ON push_log (ts)`,
  `CREATE TABLE IF NOT EXISTS sendkeys (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    key_hash text NOT NULL,
    account_id text NOT NULL,
    label text DEFAULT '' NOT NULL,
    created_at integer NOT NULL,
    last_used_at integer,
    revoked_at integer
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sendkeys_key_hash_unique ON sendkeys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS sendkeys_account_idx ON sendkeys (account_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY NOT NULL,
    value text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_configs (
    account_id text PRIMARY KEY NOT NULL,
    imap_enc text NOT NULL,
    smtp_enc text NOT NULL,
    from text,
    poll_sec integer DEFAULT 60 NOT NULL,
    enabled integer DEFAULT true NOT NULL,
    uid_validity text,
    last_uid integer,
    last_poll_at integer,
    last_error text
  )`,
  // 0004
  `CREATE TABLE IF NOT EXISTS ingest_leases (
    account_id text PRIMARY KEY NOT NULL,
    leased_until integer NOT NULL,
    last_poll_at integer
  )`,
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    key text PRIMARY KEY NOT NULL,
    tokens real NOT NULL,
    last integer NOT NULL
  )`,
];

export async function ensureSchema(db: Db): Promise<void> {
  for (const stmt of SCHEMA_DDL) {
    await db.run(sql.raw(stmt));
  }
}

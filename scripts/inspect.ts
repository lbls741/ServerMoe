// 调试工具：只读检视网关数据库的关键状态。
// 用法: bun scripts/inspect.ts [db路径]
import { Database } from "bun:sqlite";

const path = process.argv[2] ?? "data/gateway.db";
const db = new Database(path, { readonly: true });

const rows = (sql: string): unknown[] => db.query(sql).all() as unknown[];

console.log(
  JSON.stringify(
    {
      login_sessions: rows("select id, status, message, verify_code, bot_id, base_url, user_id, poll_host, refresh_count, created_at, expires_at from login_sessions"),
      accounts: rows("select id, label, status, paused_until, owner_user_id, base_url, last_inbound_at, last_error, length(sync_buf) as sync_buf_len from accounts"),
      peers: rows("select account_id, user_id, length(context_token) as ctx_len, updated_at from peers"),
      sendkeys: rows("select id, account_id, label, created_at, last_used_at, revoked_at from sendkeys"),
      inbound_log: rows("select ts, account_id, from_user_id, substr(text,1,40) as text, action from inbound_log order by id desc limit 10"),
      push_log: rows("select ts, account_id, title, status, error from push_log order by id desc limit 10"),
      outbox: rows("select id, account_id, peer_user_id, title, status, attempts from outbox order by id desc limit 10"),
      settings: rows("select key from settings"),
    },
    null,
    2,
  ),
);
db.close();

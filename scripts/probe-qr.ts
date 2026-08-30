// 调试工具：用数据库中最新的登录会话 qrcode 向 iLink 探测一次真实状态（只读轮询）。
// 用法: bun scripts/probe-qr.ts [db路径]
import { Database } from "bun:sqlite";
import { pollQrStatus } from "../src/channels/wechat/ilink/client.ts";
import { ILINK_DEFAULT_BASE_URL } from "../src/channels/wechat/ilink/constants.ts";

const path = process.argv[2] ?? "data/gateway.db";
const db = new Database(path, { readonly: true });
const row = db
  .query("select qrcode, status, created_at, expires_at from login_sessions order by created_at desc limit 1")
  .get() as { qrcode: string; status: string; created_at: number; expires_at: number };
db.close();

if (!row) {
  console.log("no login session");
  process.exit(0);
}

console.log("stored status:", row.status, "| age_s:", Math.round((Date.now() - row.created_at) / 1000), "| expired_by_our_ttl:", Date.now() > row.expires_at);
const resp = await pollQrStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, botAgent: "SuperServerChan/0.1.0" }, row.qrcode);
console.log("ilink live status:", JSON.stringify(resp));

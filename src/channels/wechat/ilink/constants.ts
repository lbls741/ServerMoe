import pkg from "../../../../package.json";

// iLink Bot API 协议常量。全部事实依据 docs/recon.md §2（官方插件源码 + README 协议章节）。
export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_APP_ID = "bot";
export const ILINK_BOT_TYPE = "3";

export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const CONFIG_TIMEOUT_MS = 10_000;
export const QR_POLL_TIMEOUT_MS = 35_000;

export const LOGIN_TOTAL_TTL_MS = 8 * 60_000; // 官方登录总超时 480s
export const QR_REFRESH_LIMIT = 3;

export const STALE_TOKEN_ERRCODE = -14; // bot_token 失效 → 熔断 1h，需重扫
export const WARMUP_RET = -2; // ret=-2 prepare failed → 缺 context_token
export const STALE_PAUSE_MS = 60 * 60_000;

export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

export const APP_VERSION: string = pkg.version;

/** iLink-App-ClientVersion: uint32 编码 major<<16 | minor<<8 | patch。 */
function encodeClientVersion(version: string): number {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  return ((parts[0] ?? 0) & 0xff) << 16 | ((parts[1] ?? 0) & 0xff) << 8 | (parts[2] ?? 0) & 0xff;
}

export const APP_CLIENT_VERSION = encodeClientVersion(APP_VERSION);

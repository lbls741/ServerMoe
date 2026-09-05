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
/** 请求驱动轮询（Workers pollLoginOnce）对上游 get_qrcode_status 的防抖间隔 */
export const LOGIN_POLL_DEBOUNCE_MS = 4_000;
/** 请求驱动轮询的单次上游挂起上限（短于服务端 35s hold，超时视为 wait） */
export const LOGIN_POLL_HOLD_MS = 20_000;

export const STALE_TOKEN_ERRCODE = -14; // bot_token 失效 → 熔断 1h，需重扫
export const WARMUP_RET = -2; // ret=-2 prepare failed → 缺 context_token
export const STALE_PAUSE_MS = 60 * 60_000;

export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 服务端推送窗口（社区多方实测、官方未文档化，见 research/ilink-interface-and-serverless.md §9）：
 * 用户最近一次发给 bot 的消息后 24h 内可主动推送，且无法由 bot 静默续期，仅用户回复可重置。
 * 属可变服务端策略而非协议常量，故仅作提醒依据（临期提醒，core/warn.ts），不参与发送判定。
 */
export const PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

export const APP_VERSION: string = pkg.version;

/** iLink-App-ClientVersion: uint32 编码 major<<16 | minor<<8 | patch。 */
function encodeClientVersion(version: string): number {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  return ((parts[0] ?? 0) & 0xff) << 16 | ((parts[1] ?? 0) & 0xff) << 8 | (parts[2] ?? 0) & 0xff;
}

export const APP_CLIENT_VERSION = encodeClientVersion(APP_VERSION);

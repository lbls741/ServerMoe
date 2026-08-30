import { randomId, decryptString, encryptString, generateSendkey, sha256Hex } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import type { Logger } from "../../log.ts";
import { createAccount, listAccounts } from "../../repo/accounts.ts";
import {
  createLoginSession,
  getLoginSession,
  updateLoginSession,
  deleteLoginSession,
  type LoginSessionRow,
} from "../../repo/loginSessions.ts";
import { revokeSendkeys, createSendkey } from "../../repo/sendkeys.ts";
import {
  ILINK_BOT_TYPE,
  ILINK_DEFAULT_BASE_URL,
  LOGIN_TOTAL_TTL_MS,
  QR_REFRESH_LIMIT,
} from "./ilink/constants.ts";
import { fetchQrCode, pollQrStatus, type ApiCtx } from "./ilink/client.ts";
import type { QrStatusResp } from "./ilink/types.ts";

export interface LoginDeps {
  db: Db;
  masterKey: Buffer;
  log: Logger;
  botAgent: string;
  /** sendkey 哈希盐（settings.crypto_salt），显式注入保证与推送层一致 */
  salt: string;
  /** 默认登录/API 入口；仅测试注入 mock，生产固定 ilinkai.weixin.qq.com */
  baseUrl?: string;
}

export class LoginError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// 每个登录会话一个服务端驱动（进程单例）。浏览器/API 只读写 DB，绝不直接驱动 iLink。
const loginDrivers = new Map<string, AbortController>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function qrCtx(deps: LoginDeps, baseUrl: string): ApiCtx {
  return { baseUrl, botAgent: deps.botAgent };
}

function defaultBaseUrl(deps: LoginDeps): string {
  return deps.baseUrl ?? ILINK_DEFAULT_BASE_URL;
}

function localTokenList(deps: LoginDeps): string[] {
  const rows = listAccounts(deps.db);
  const tokens: string[] = [];
  for (let i = rows.length - 1; i >= 0 && tokens.length < 10; i--) {
    const row = rows[i];
    if (!row) continue;
    try {
      tokens.push(decryptString(deps.masterKey, row.tokenEnc));
    } catch {
      // 解密失败的旧凭据不参与上送
    }
  }
  return tokens;
}

async function refreshQr(deps: LoginDeps, row: LoginSessionRow): Promise<void> {
  const ctx = qrCtx(deps, row.pollHost ? `https://${row.pollHost}` : defaultBaseUrl(deps));
  const qr = await fetchQrCode(ctx, ILINK_BOT_TYPE, localTokenList(deps));
  updateLoginSession(deps.db, row.id, {
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    refreshCount: row.refreshCount + 1,
    status: "wait",
    message: "二维码已刷新，请重新扫描",
  });
}

/** 发起绑定：取二维码落库并启动服务端驱动。返回会话 id 与二维码内容（URL，由上层渲染 SVG）。 */
export async function startLogin(deps: LoginDeps): Promise<{ sessionId: string; qrcodeUrl: string }> {
  const ctx = qrCtx(deps, defaultBaseUrl(deps));
  const qr = await fetchQrCode(ctx, ILINK_BOT_TYPE, localTokenList(deps));
  const id = randomId();
  createLoginSession(deps.db, {
    id,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    now: Date.now(),
    ttlMs: LOGIN_TOTAL_TTL_MS,
  });
  driveLogin(deps, id);
  deps.log.info("login session started", { sessionId: id });
  return { sessionId: id, qrcodeUrl: qr.qrcode_img_content };
}

export function stopLoginDriver(sessionId: string): void {
  loginDrivers.get(sessionId)?.abort();
  loginDrivers.delete(sessionId);
}

export function stopAllLoginDrivers(): void {
  for (const c of loginDrivers.values()) c.abort();
  loginDrivers.clear();
}

/**
 * 服务端驱动：唯一的状态轮询消费者。长轮询 iLink → 更新 DB → 处理刷新/迁移/配对码，
 * 直到 confirmed/failed/超时。浏览器轮询接口只读本表，因此前端故障不影响绑定推进。
 */
function driveLogin(deps: LoginDeps, sessionId: string): void {
  const controller = new AbortController();
  loginDrivers.set(sessionId, controller);
  const log = deps.log.child({ sessionId: sessionId.slice(0, 8) });

  void (async () => {
    const deadline = Date.now() + LOGIN_TOTAL_TTL_MS;
    while (!controller.signal.aborted && Date.now() < deadline) {
      const row = getLoginSession(deps.db, sessionId);
      if (!row) break;
      if (row.status === "confirmed" || row.status === "failed") break;
      // 配对码门控：need_verifycode 且用户尚未提交数字时挂起等待（避免无谓轮询）
      if (row.status === "need_verifycode" && !row.verifyCode) {
        await sleep(400, controller.signal).catch(() => null);
        continue;
      }
      let resp: QrStatusResp;
      try {
        resp = await pollQrStatus(
          qrCtx(deps, row.pollHost ? `https://${row.pollHost}` : defaultBaseUrl(deps)),
          row.qrcode,
          row.verifyCode ?? undefined,
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) break;
        log.warn("qr poll error", { err: String(err).slice(0, 160) });
        await sleep(2000, controller.signal).catch(() => null);
        continue;
      }
      if (controller.signal.aborted) break;

      const before = row.status;
      const action = await applyQrStatus(deps, row, resp);
      if (action === "stop") break;
      // 状态未变化时空转保护（长轮询会挂起，此分支覆盖 need_verifycode 等快速返回态）
      const after = getLoginSession(deps.db, sessionId);
      if (after && after.status === before) {
        await sleep(1000, controller.signal).catch(() => null);
      }
    }
  })()
    .catch((err) => log.error("login driver crashed", { err: String(err) }))
    .finally(() => loginDrivers.delete(sessionId));
}

type ApplyResult = "continue" | "stop";

async function applyQrStatus(deps: LoginDeps, row: LoginSessionRow, resp: QrStatusResp): Promise<ApplyResult> {
  const patch: Partial<LoginSessionRow> = {};
  switch (resp.status) {
    case "wait":
      break;
    case "scaned":
      patch.status = "scaned";
      if (row.verifyCode) patch.verifyCode = null;
      break;
    case "need_verifycode":
      patch.status = "need_verifycode";
      patch.message = "请在微信中输入配对数字后提交";
      break;
    case "verify_code_blocked":
      patch.status = "verify_code_blocked";
      patch.verifyCode = null;
      patch.message = "配对码多次错误，已刷新二维码，请重新扫描";
      await refreshQr(deps, row);
      break;
    case "expired":
      if (row.refreshCount < QR_REFRESH_LIMIT) {
        patch.message = "二维码已过期，正在刷新";
        await refreshQr(deps, row);
      } else {
        patch.status = "failed";
        patch.message = "二维码多次失效，绑定已终止，请重新发起";
      }
      break;
    case "scaned_but_redirect":
      if (resp.redirect_host) {
        patch.pollHost = resp.redirect_host;
        patch.message = `服务端迁移至 ${resp.redirect_host}，继续绑定`;
      }
      break;
    case "binded_redirect":
      patch.status = "failed";
      patch.message = "该微信 bot 已绑定过本网关，无需重复绑定";
      break;
    case "confirmed": {
      if (!resp.ilink_bot_id || !resp.bot_token) {
        patch.status = "failed";
        patch.message = "登录失败：服务端未返回完整凭据";
        break;
      }
      patch.status = "confirmed";
      patch.botId = resp.ilink_bot_id;
      patch.tokenEnc = encryptString(deps.masterKey, resp.bot_token);
      patch.baseUrl = resp.baseurl || defaultBaseUrl(deps);
      patch.userId = resp.ilink_user_id ?? "";
      patch.message = "绑定成功";
      deps.log.info("login confirmed", { botId: resp.ilink_bot_id });
      updateLoginSession(deps.db, row.id, patch);
      return "stop";
    }
  }
  if (Object.keys(patch).length > 0) updateLoginSession(deps.db, row.id, patch);
  return "continue";
}

/** 只读视图：登录会话当前状态（供 API 轮询，毫秒级返回）。 */
export function getLoginView(deps: LoginDeps, sessionId: string): LoginSessionRow {
  const row = getLoginSession(deps.db, sessionId);
  if (!row) throw new LoginError(404, "登录会话不存在");
  return row;
}

/** 提交手机上显示的配对数字；服务端驱动会在下一轮携带该码继续绑定。 */
export function submitVerifyCode(deps: LoginDeps, sessionId: string, code: string): LoginSessionRow {
  const row = getLoginView(deps, sessionId);
  if (row.status === "confirmed" || row.status === "failed") {
    throw new LoginError(409, `登录已结束（${row.status}）`);
  }
  updateLoginSession(deps.db, sessionId, { verifyCode: code });
  return getLoginSession(deps.db, sessionId)!;
}

export interface ConfirmResult {
  accountId: string;
  sendkey: string;
  baseUrl: string;
  ownerUserId: string;
}

/** 用已 confirmed 的登录会话落库账号并签发 sendkey（明文仅此一次返回）。 */
export function confirmLogin(deps: LoginDeps, sessionId: string): ConfirmResult {
  const row = getLoginView(deps, sessionId);
  if (row.status !== "confirmed" || !row.botId || !row.tokenEnc) {
    throw new LoginError(409, `登录会话未确认（当前状态: ${row.status}）`);
  }
  stopLoginDriver(sessionId);
  const now = Date.now();
  createAccount(deps.db, {
    id: row.botId,
    tokenEnc: row.tokenEnc,
    baseUrl: row.baseUrl ?? defaultBaseUrl(deps),
    ownerUserId: row.userId ?? "",
    now,
  });
  // 同一账号重新绑定：轮换 sendkey
  revokeSendkeys(deps.db, row.botId, now);
  const key = generateSendkey();
  createSendkey(deps.db, { keyHash: sha256Hex(deps.salt + ":" + key), accountId: row.botId, now });
  deleteLoginSession(deps.db, sessionId);
  deps.log.info("account bound", { accountId: row.botId, baseUrl: row.baseUrl });
  return { accountId: row.botId, sendkey: key, baseUrl: row.baseUrl ?? defaultBaseUrl(deps), ownerUserId: row.userId ?? "" };
}

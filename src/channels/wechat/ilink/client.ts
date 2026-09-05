import { randomWechatUinB64 } from "../../../crypto.ts";
import {
  API_TIMEOUT_MS,
  APP_CLIENT_VERSION,
  APP_VERSION,
  CONFIG_TIMEOUT_MS,
  ILINK_APP_ID,
  LONG_POLL_TIMEOUT_MS,
  QR_POLL_TIMEOUT_MS,
} from "./constants.ts";
import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  QrCodeResp,
  QrStatusResp,
  SendTypingReq,
  SendMessageReq,
  SendMessageResp,
} from "./types.ts";

export interface ApiCtx {
  baseUrl: string;
  token?: string;
  botAgent: string;
}

export type IlinkErrorKind = "http" | "network" | "api";

export class IlinkApiError extends Error {
  constructor(
    public readonly kind: IlinkErrorKind,
    public readonly status?: number,
    public readonly ret?: number,
    public readonly errcode?: number,
    public readonly errmsg?: string,
    message?: string,
  ) {
    super(message ?? `ilink ${kind} error${status ? ` status=${status}` : ""}${ret ? ` ret=${ret}` : ""}`);
  }
}

function baseInfo(ctx: ApiCtx): BaseInfo {
  return { channel_version: APP_VERSION, bot_agent: ctx.botAgent };
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(APP_CLIENT_VERSION),
  };
}

function authHeaders(ctx: ApiCtx): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUinB64(),
    ...commonHeaders(),
  };
  if (ctx.token?.trim()) h.Authorization = `Bearer ${ctx.token.trim()}`;
  return h;
}

const ensureSlash = (u: string): string => (u.endsWith("/") ? u : `${u}/`);

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function networkKind(err: unknown): IlinkErrorKind {
  const s = String((err as Error)?.cause ?? err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) return "network";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(s)) return "network";
  return "network";
}

async function postJson<T>(ctx: ApiCtx, endpoint: string, body: unknown, timeoutMs: number, external?: AbortSignal): Promise<T> {
  const url = ensureSlash(ctx.baseUrl) + endpoint;
  const signal = external ? AbortSignal.any([AbortSignal.timeout(timeoutMs), external]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: authHeaders(ctx), body: JSON.stringify(body), signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new IlinkApiError(networkKind(err), undefined, undefined, undefined, undefined, `${endpoint}: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new IlinkApiError("http", res.status, undefined, undefined, undefined, `${endpoint} ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IlinkApiError("http", res.status, undefined, undefined, undefined, `${endpoint}: invalid JSON response`);
  }
}

async function getJson<T>(ctx: ApiCtx, endpoint: string, timeoutMs: number, external?: AbortSignal): Promise<T> {
  const url = ensureSlash(ctx.baseUrl) + endpoint;
  const signal = external ? AbortSignal.any([AbortSignal.timeout(timeoutMs), external]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: commonHeaders(), signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new IlinkApiError(networkKind(err), undefined, undefined, undefined, undefined, `${endpoint}: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new IlinkApiError("http", res.status, undefined, undefined, undefined, `${endpoint} ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

/** 取绑定二维码。local_token_list 上送本地已有 token，服务端识别已绑定 → binded_redirect。 */
export async function fetchQrCode(ctx: ApiCtx, botType: string, localTokenList: string[]): Promise<QrCodeResp> {
  return postJson(ctx, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, { local_token_list: localTokenList }, API_TIMEOUT_MS);
}

/** 长轮询绑定状态（服务端最多挂起 ~35s）。客户端超时/外部中止返回 wait。 */
export async function pollQrStatus(
  ctx: ApiCtx,
  qrcode: string,
  verifyCode?: string,
  external?: AbortSignal,
  holdMs: number = QR_POLL_TIMEOUT_MS + 5_000,
): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await getJson<QrStatusResp>(ctx, endpoint, holdMs, external);
  } catch (err) {
    if (isAbort(err)) return { status: "wait" };
    // 网关超时（如 Cloudflare 524）或瞬时网络错误：视为等待，由上层 deadline 兜底
    return { status: "wait" };
  }
}

/** 长轮询收信。客户端超时返回空响应（游标原样回传）以便继续轮询；外部中止时抛出。 */
export async function getUpdates(ctx: ApiCtx, req: GetUpdatesReq, timeoutMs = LONG_POLL_TIMEOUT_MS, external?: AbortSignal): Promise<GetUpdatesResp> {
  try {
    return await postJson<GetUpdatesResp>(ctx, "ilink/bot/getupdates", { get_updates_buf: req.get_updates_buf ?? "", base_info: baseInfo(ctx) }, timeoutMs, external);
  } catch (err) {
    if (isAbort(err)) {
      if (external?.aborted) throw err;
      return { ret: 0, msgs: [], get_updates_buf: req.get_updates_buf ?? "" };
    }
    throw err;
  }
}

/** 发送消息。业务错误以 ret/errcode 表达（HTTP 层 200）。 */
export async function sendMessage(ctx: ApiCtx, body: SendMessageReq): Promise<SendMessageResp> {
  const resp = await postJson<SendMessageResp>(ctx, "ilink/bot/sendmessage", { ...body, base_info: baseInfo(ctx) }, API_TIMEOUT_MS);
  if (resp.ret && resp.ret !== 0) {
    throw new IlinkApiError("api", undefined, resp.ret, resp.errcode, resp.errmsg);
  }
  return resp;
}

export async function getConfig(ctx: ApiCtx, ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
  return postJson<GetConfigResp>(ctx, "ilink/bot/getconfig", { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo(ctx) }, CONFIG_TIMEOUT_MS);
}

export async function sendTyping(ctx: ApiCtx, body: SendTypingReq): Promise<void> {
  await postJson(ctx, "ilink/bot/sendtyping", { ...body, base_info: baseInfo(ctx) }, CONFIG_TIMEOUT_MS);
}

export async function notifyStart(ctx: ApiCtx): Promise<void> {
  await postJson(ctx, "ilink/bot/msg/notifystart", { base_info: baseInfo(ctx) }, CONFIG_TIMEOUT_MS);
}

export async function notifyStop(ctx: ApiCtx): Promise<void> {
  await postJson(ctx, "ilink/bot/msg/notifystop", { base_info: baseInfo(ctx) }, CONFIG_TIMEOUT_MS);
}

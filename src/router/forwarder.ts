// 关键词 webhook 转发器。契约（AGENT.md R2 / dev-plan §7）：
// POST url，JSON {user_id, account_id, keyword, text, ts, msg_id}
// 带 secret 时附 X-SSC-Timestamp + X-SSC-Signature = HMAC-SHA256(secret, ts.rawBody)，防重放窗口 5min
// 5s 超时；2xx 且 body 为 {reply} → 该文本回发微信；2xx 无 reply → 默认回执；失败 → 错误回执

import { decryptString, hmacSignHex } from "../crypto.ts";
import type { Core } from "../core.ts";

export interface ForwardPayload {
  user_id: string;
  account_id: string;
  keyword: string;
  text: string;
  ts: number;
  msg_id?: string;
}

export interface ForwardResult {
  ok: boolean;
  reply?: string;
  error?: string;
  status?: number;
}

export const FORWARD_TIMEOUT_MS = 5_000;

export function createForwarder(core: Core) {
  return {
    async forward(url: string, secretEnc: string | null, payload: ForwardPayload): Promise<ForwardResult> {
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secretEnc) {
        try {
          const secret = decryptString(core.masterKey, secretEnc);
          const ts = Math.floor(Date.now() / 1000);
          headers["x-ssc-timestamp"] = String(ts);
          headers["x-ssc-signature"] = hmacSignHex(secret, `${ts}.${body}`);
        } catch {
          return { ok: false, error: "webhook secret 解密失败" };
        }
      }
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
      } catch (err) {
        return { ok: false, error: String((err as Error)?.name === "TimeoutError" ? "webhook 超时(5s)" : err).slice(0, 160) };
      }
      if (!res.ok) {
        return { ok: false, error: `webhook HTTP ${res.status}`, status: res.status };
      }
      const j = (await res.json().catch(() => ({}))) as { reply?: unknown };
      return { ok: true, reply: typeof j.reply === "string" && j.reply.length > 0 ? j.reply : undefined, status: res.status };
    },
  };
}

export type Forwarder = ReturnType<typeof createForwarder>;

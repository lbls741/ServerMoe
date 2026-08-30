// ServerChan 兼容层：GET|POST /{sendkey}.send，四编码（query / JSON / form / plain text）。
// 契约：{code:number(0=成功), message:string, data?:any}（依据 serverchan-sdk 审计，dev-plan §13）。

import type { Context } from "hono";
import type { Hono } from "hono";
import { sha256Hex } from "../crypto.ts";
import type { Core } from "../core.ts";
import type { PushService } from "../core/push.ts";
import { getAccount } from "../repo/accounts.ts";
import { findActiveSendkey, touchSendkey } from "../repo/sendkeys.ts";
import type { RateLimiter } from "./ratelimit.ts";

interface SendParams {
  title?: string;
  desp?: string;
  short?: string;
  extra: Record<string, unknown>;
}

const EXTRA_KEYS = ["tags", "channel", "openid", "noip"] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function parseSendParams(c: Context): Promise<SendParams> {
  const extra: Record<string, unknown> = {};

  if (c.req.method === "GET") {
    for (const k of EXTRA_KEYS) {
      const v = c.req.query(k);
      if (v) extra[k] = v;
    }
    return { title: str(c.req.query("title")), desp: str(c.req.query("desp")), short: str(c.req.query("short")), extra };
  }

  const ct = (c.req.header("content-type") ?? "").toLowerCase();

  if (ct.includes("application/json")) {
    const body = (await c.req.json()) as Record<string, unknown>;
    for (const k of EXTRA_KEYS) {
      if (body[k] !== undefined) extra[k] = body[k];
    }
    return { title: str(body.title), desp: str(body.desp), short: str(body.short), extra };
  }

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    for (const k of EXTRA_KEYS) {
      const v = form[k];
      if (typeof v === "string" && v) extra[k] = v;
    }
    return { title: str(form.title), desp: str(form.desp), short: str(form.short), extra };
  }

  // text/plain 及其他：首行作 title，其余作 desp
  const raw = await c.req.text();
  const nl = raw.indexOf("\n");
  const first = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : raw.slice(nl + 1).trim();
  return { title: first || undefined, desp: rest || undefined, extra };
}

export function mountServerchan(app: Hono, core: Core, push: PushService, limiter: RateLimiter): void {
  app.on(["GET", "POST"], "/:spec", async (c) => {
    const spec = c.req.param("spec");
    if (!spec.endsWith(".send")) return c.json({ code: 404, message: "not found" }, 404);
    const key = spec.slice(0, -".send".length);

    const sk = findActiveSendkey(core.db, sha256Hex(core.salt + ":" + key));
    if (!sk) return c.json({ code: 400, message: "bad sendkey" }, 400);

    if (!limiter.take(sk.id)) {
      return c.json({ code: 429, message: "rate limited" }, 429, { "Retry-After": String(limiter.retryAfterSec(sk.id)) });
    }
    touchSendkey(core.db, sk.id, Date.now());

    let params: SendParams;
    try {
      params = await parseSendParams(c);
    } catch {
      return c.json({ code: 400, message: "invalid request body" }, 400);
    }
    if (!params.title) return c.json({ code: 400, message: "title is required" }, 400);

    const account = getAccount(core.db, sk.accountId);
    if (!account) return c.json({ code: 451, message: "推送账号不存在，请检查绑定" }, 200);

    const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const outcome = await push.push({
      sendkeyId: sk.id,
      accountId: sk.accountId,
      peerUserId: account.ownerUserId,
      title: params.title,
      desp: params.desp,
      short: params.short,
      extra: Object.keys(params.extra).length > 0 ? params.extra : null,
      ip,
    });

    if (outcome.code === 0) {
      return c.json({ code: 0, message: "", data: { pushid: outcome.pushid, error: "SUCCESS" } });
    }
    return c.json({ code: outcome.code, message: outcome.message });
  });
}

// 自有 API v1。管理面（login/sessions/admin）需要 admin token；/send 接受 admin 或 sendkey。

import { count, eq, gte } from "drizzle-orm";
import type { Hono as HonoApp } from "hono";
import type { Context } from "hono";
import QRCode from "qrcode";
import type { WechatChannel } from "../channels/wechat/channel.ts";
import { keywords as keywordsTable, outbox as outboxTable, pushLog } from "../db/schema.ts";
import { encryptString, safeEqual, sha256Hex } from "../crypto.ts";
import type { Core } from "../core.ts";
import type { PushService } from "../core/push.ts";
import { deleteAccount, getAccount, listAccounts } from "../repo/accounts.ts";
import { getLoginSession } from "../repo/loginSessions.ts";
import {
  createKeyword,
  deleteKeyword,
  findKeywordByKeyword,
  getKeyword,
  listKeywords,
  setKeywordEnabled,
  type MatchMode,
} from "../repo/keywords.ts";
import { deleteAccountPeers, listPeers } from "../repo/peers.ts";
import { findActiveSendkey, listSendkeys, revokeSendkeys } from "../repo/sendkeys.ts";
import { isValidRegex } from "../router/matcher.ts";
import { isReserved } from "../router/builtins.ts";
import { bearerToken, requireAdmin } from "./auth.ts";
import type { RateLimiter } from "./ratelimit.ts";

function errStatus(err: unknown): { code: number; message: string } {
  const status = (err as { status?: number }).status ?? 500;
  return { code: status, message: String((err as Error).message) };
}

/** 关键词接口的账号作用域鉴权：sendkey Bearer 决定账号；admin 需显式提供 accountId。 */
function accountScope(
  c: Context,
  core: Core,
  explicitAccountId?: string,
): { ok: true; accountId: string } | { ok: false; status: 400 | 401; message: string } {
  const bearer = bearerToken(c);
  if (bearer && safeEqual(bearer, core.adminToken)) {
    if (explicitAccountId) return { ok: true, accountId: explicitAccountId };
    return { ok: false, status: 400, message: "admin 需要提供 accountId" };
  }
  if (bearer) {
    const sk = findActiveSendkey(core.db, sha256Hex(core.salt + ":" + bearer));
    if (sk) return { ok: true, accountId: sk.accountId };
  }
  return { ok: false, status: 401, message: "sendkey or admin token required" };
}

function keywordView(row: { id: number; keyword: string; matchMode: string; url: string; secretEnc: string | null; enabled: boolean; createdAt: number }) {
  return { id: row.id, keyword: row.keyword, match: row.matchMode, url: row.url, hasSecret: Boolean(row.secretEnc), enabled: row.enabled, createdAt: row.createdAt };
}

const MATCH_MODES: readonly MatchMode[] = ["exact", "prefix", "contains", "regex"];

function mountKeywords(app: HonoApp, core: Core): void {
  app.post("/api/v1/keywords", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      keyword?: string;
      match?: string;
      url?: string;
      secret?: string;
      accountId?: string;
    };
    const scope = accountScope(c, core, body.accountId);
    if (!scope.ok) return c.json({ code: scope.status, message: scope.message }, scope.status);

    const keyword = (body.keyword ?? "").trim();
    const match = (body.match ?? "") as MatchMode;
    const url = (body.url ?? "").trim();
    if (!keyword || keyword.length > 64) return c.json({ code: 400, message: "keyword 必填且 ≤64 字符" }, 400);
    if (!MATCH_MODES.includes(match)) return c.json({ code: 400, message: `match 必须是 ${MATCH_MODES.join("/")}` }, 400);
    if (isReserved(keyword)) return c.json({ code: 409, message: `「${keyword}」是保留字，应用不得注册` }, 409);
    if (match === "regex" && !isValidRegex(keyword)) return c.json({ code: 400, message: "无效的正则表达式" }, 400);
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      return c.json({ code: 400, message: "url 必须是合法的 http(s) 地址" }, 400);
    }
    if (findKeywordByKeyword(core.db, scope.accountId, keyword)) {
      return c.json({ code: 409, message: `关键词「${keyword}」已存在` }, 409);
    }

    const row = createKeyword(core.db, {
      accountId: scope.accountId,
      keyword,
      matchMode: match,
      url,
      secretEnc: body.secret ? encryptString(core.masterKey, body.secret) : null,
      now: Date.now(),
    });
    core.log.info("keyword registered", { accountId: scope.accountId, keyword, match });
    return c.json({ code: 0, keyword: keywordView(row) });
  });

  app.get("/api/v1/keywords", (c) => {
    const scope = accountScope(c, core, c.req.query("accountId") ?? undefined);
    if (!scope.ok) return c.json({ code: scope.status, message: scope.message }, scope.status);
    return c.json({ code: 0, keywords: listKeywords(core.db, scope.accountId).map(keywordView) });
  });

  app.patch("/api/v1/keywords/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; accountId?: string };
    const scope = accountScope(c, core, body.accountId ?? c.req.query("accountId") ?? undefined);
    if (!scope.ok) return c.json({ code: scope.status, message: scope.message }, scope.status);
    const row = getKeyword(core.db, Number(c.req.param("id")));
    if (!row || row.accountId !== scope.accountId) return c.json({ code: 404, message: "keyword not found" }, 404);
    if (typeof body.enabled !== "boolean") return c.json({ code: 400, message: "enabled(boolean) required" }, 400);
    setKeywordEnabled(core.db, scope.accountId, row.id, body.enabled);
    return c.json({ code: 0, keyword: keywordView(getKeyword(core.db, row.id)!) });
  });

  app.delete("/api/v1/keywords/:id", (c) => {
    const scope = accountScope(c, core, c.req.query("accountId") ?? undefined);
    if (!scope.ok) return c.json({ code: scope.status, message: scope.message }, scope.status);
    const row = getKeyword(core.db, Number(c.req.param("id")));
    if (!row || row.accountId !== scope.accountId) return c.json({ code: 404, message: "keyword not found" }, 404);
    deleteKeyword(core.db, scope.accountId, row.id);
    return c.json({ code: 0, message: "deleted" });
  });
}

function mountAdmin(app: HonoApp, core: Core, wechat: WechatChannel): void {
  app.use("/api/v1/login/*", requireAdmin(core));
  app.use("/api/v1/sessions/*", requireAdmin(core));
  app.use("/api/v1/admin/*", requireAdmin(core));

  app.post("/api/v1/login/start", async (c) => {
    const r = await wechat.startLogin();
    return c.json({ code: 0, ...r });
  });

  app.get("/api/v1/login/poll", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ code: 400, message: "sessionId required" }, 400);
    try {
      return c.json({ code: 0, ...(await wechat.pollLogin(sessionId)) });
    } catch (err) {
      return c.json(errStatus(err), 200);
    }
  });

  app.post("/api/v1/login/verify", async (c) => {
    const body = (await c.req.json()) as { sessionId?: string; code?: string };
    if (!body.sessionId || !body.code) return c.json({ code: 400, message: "sessionId & code required" }, 400);
    try {
      return c.json({ code: 0, ...(await wechat.submitVerifyCode(body.sessionId, body.code)) });
    } catch (err) {
      return c.json(errStatus(err), 200);
    }
  });

  app.post("/api/v1/login/confirm", async (c) => {
    const body = (await c.req.json()) as { sessionId?: string };
    if (!body.sessionId) return c.json({ code: 400, message: "sessionId required" }, 400);
    try {
      const r = await wechat.confirmLogin(body.sessionId);
      await wechat.startAccount(r.accountId);
      return c.json({ code: 0, accountId: r.accountId, sendkey: r.sendkey, baseUrl: r.baseUrl, ownerUserId: r.ownerUserId });
    } catch (err) {
      return c.json(errStatus(err), 200);
    }
  });

  app.get("/api/v1/login/qr.svg", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ code: 400, message: "sessionId required" }, 400);
    const row = getLoginSession(core.db, sessionId);
    if (!row) return c.json({ code: 404, message: "session not found" }, 404);
    const svg = await QRCode.toString(row.qrcodeUrl, { type: "svg", margin: 1, width: 280 });
    return c.body(svg, 200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
  });

  app.get("/api/v1/sessions", (c) => {
    const sessions = listAccounts(core.db).map((a) => ({
      accountId: a.id,
      label: a.label,
      status: a.status,
      pausedUntil: a.pausedUntil,
      ownerUserId: a.ownerUserId,
      baseUrl: a.baseUrl,
      lastInboundAt: a.lastInboundAt,
      lastError: a.lastError,
      peers: listPeers(core.db, a.id).length,
      activeSendkeys: listSendkeys(core.db, a.id).filter((k) => !k.revokedAt).length,
      createdAt: a.createdAt,
    }));
    return c.json({ code: 0, sessions });
  });

  app.delete("/api/v1/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!getAccount(core.db, id)) return c.json({ code: 404, message: "account not found" }, 404);
    await wechat.stopAccount(id, "unbind");
    revokeSendkeys(core.db, id, Date.now());
    deleteAccountPeers(core.db, id);
    deleteAccount(core.db, id);
    core.log.info("account unbound", { accountId: id });
    return c.json({ code: 0, message: "unbound" });
  });

  app.get("/api/v1/admin/overview", (c) => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return c.json({
      code: 0,
      accounts: listAccounts(core.db).length,
      keywords: core.db.select({ n: count() }).from(keywordsTable).get()?.n ?? 0,
      outboxPending: core.db.select({ n: count() }).from(outboxTable).where(eq(outboxTable.status, "pending")).get()?.n ?? 0,
      pushes24h: core.db.select({ n: count() }).from(pushLog).where(gte(pushLog.ts, dayAgo)).get()?.n ?? 0,
    });
  });
}

export function mountV1(app: HonoApp, core: Core, push: PushService, wechat: WechatChannel, limiter: RateLimiter): void {
  mountAdmin(app, core, wechat);
  mountKeywords(app, core);

  // 富推送端点：Bearer admin（可用 body.sendkey 指定目标）或 Bearer <sendkey>
  app.post("/api/v1/send", async (c) => {
    const bearer = bearerToken(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      sendkey?: string;
      title?: string;
      desp?: string;
      short?: string;
    };
    let sendkeyPlain = body.sendkey;
    if (bearer && safeEqual(bearer, core.adminToken)) {
      // admin 模式：目标由 body.sendkey 指定
    } else if (bearer) {
      sendkeyPlain = bearer;
    }
    if (!sendkeyPlain) return c.json({ code: 401, message: "admin token or sendkey required" }, 401);
    if (!body.title) return c.json({ code: 400, message: "title is required" }, 400);

    const sk = findActiveSendkey(core.db, sha256Hex(core.salt + ":" + sendkeyPlain));
    if (!sk) return c.json({ code: 400, message: "bad sendkey" }, 400);
    if (!limiter.take(sk.id)) {
      return c.json({ code: 429, message: "rate limited" }, 429, { "Retry-After": String(limiter.retryAfterSec(sk.id)) });
    }
    const account = getAccount(core.db, sk.accountId);
    if (!account) return c.json({ code: 451, message: "推送账号不存在，请检查绑定" });

    const outcome = await push.push({
      sendkeyId: sk.id,
      accountId: sk.accountId,
      peerUserId: account.ownerUserId,
      title: body.title,
      desp: body.desp,
      short: body.short ?? null,
      ip: c.req.header("x-forwarded-for") ?? null,
    });
    return c.json({ code: outcome.code, message: outcome.message, pushid: outcome.pushid, reason: outcome.reason, chunks: outcome.chunks });
  });
}

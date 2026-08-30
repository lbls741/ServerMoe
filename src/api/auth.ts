import type { Context, Next } from "hono";
import { safeEqual } from "../crypto.ts";
import type { Core } from "../core.ts";

/** 提取 Bearer token（Authorization 头）或 ?token= 查询参数（便于浏览器手工调试）。 */
export function bearerToken(c: Context): string | undefined {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const q = c.req.query("token");
  return q ? q.trim() : undefined;
}

export function isAdmin(c: Context, core: Core): boolean {
  const t = bearerToken(c);
  return Boolean(t) && safeEqual(t!, core.adminToken);
}

export function requireAdmin(core: Core) {
  return async (c: Context, next: Next) => {
    if (!isAdmin(c, core)) return c.json({ code: 401, message: "unauthorized" }, 401);
    await next();
  };
}

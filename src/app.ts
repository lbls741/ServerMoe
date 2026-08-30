import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { requireAdmin } from "./api/auth.ts";
import type { Core } from "./core.ts";
import type { PushService } from "./core/push.ts";
import type { RateLimiter } from "./api/ratelimit.ts";
import { mountServerchan } from "./api/serverchan.ts";
import { mountV1 } from "./api/v1.ts";
import type { WechatChannel } from "./channels/wechat/channel.ts";
import { listAccounts } from "./repo/accounts.ts";
import { renderIndex } from "./web/pages.ts";

export interface AppDeps {
  core: Core;
  push: PushService;
  wechat: WechatChannel;
  limiter: RateLimiter;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use(secureHeaders());

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // 账号信息属敏感数据，与 /api/v1/sessions 同等鉴权；探针请使用 /healthz
  app.get("/statusz", requireAdmin(deps.core), (c) => {
    const accounts = listAccounts(deps.core.db).map((a) => ({
      id: a.id,
      label: a.label,
      status: a.status,
      pausedUntil: a.pausedUntil,
      lastInboundAt: a.lastInboundAt,
      lastError: a.lastError,
    }));
    return c.json({ status: "ok", accounts, channelId: deps.wechat.id });
  });

  app.get("/", (c) => c.html(renderIndex()));

  mountV1(app, deps.core, deps.push, deps.wechat, deps.limiter);
  // ServerChan 兼容层挂在最后（单段 catch-all：/:spec 且以 .send 结尾才受理）
  mountServerchan(app, deps.core, deps.push, deps.limiter);

  app.notFound((c) => c.json({ code: 404, message: "not found" }, 404));

  app.onError((err, c) => {
    deps.core.log.error("unhandled error", { path: c.req.path, err: String(err) });
    return c.json({ code: 500, message: "internal error" }, 500);
  });

  return app;
}

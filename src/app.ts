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
import { createUpdateChecker, updateHeaderPayload, type UpdateChecker } from "./update/checker.ts";

export interface AppDeps {
  core: Core;
  push: PushService;
  wechat: WechatChannel;
  limiter: RateLimiter;
  /** 注入可测试；缺省按 cfg 创建真实检测器 */
  updateChecker?: UpdateChecker;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use(secureHeaders());
  const updater = deps.updateChecker ?? createUpdateChecker(deps.core);

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // 账号信息属敏感数据，与 /api/v1/sessions 同等鉴权；探针请使用 /healthz
  app.get("/statusz", requireAdmin(deps.core), async (c) => {
    const accounts = (await listAccounts(deps.core.db)).map((a) => ({
      id: a.id,
      label: a.label,
      status: a.status,
      pausedUntil: a.pausedUntil,
      lastInboundAt: a.lastInboundAt,
      lastError: a.lastError,
    }));
    return c.json({ status: "ok", accounts, channelId: deps.wechat.id });
  });

  // 更新检测随前端请求按需执行（内部有阈值节流与并发去重），结果随响应头带给管理页
  app.use("/api/v1/*", async (c, next) => {
    c.header("X-Moe-Update", JSON.stringify(updateHeaderPayload(await updater.maybeCheck())));
    await next();
  });

  app.get("/", async (c) => {
    return c.html(renderIndex(updateHeaderPayload(await updater.maybeCheck())));
  });

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

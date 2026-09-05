// Cloudflare Workers 入口（src/entries/worker.ts）。
// 自部署 Bun 入口见 src/index.ts；共享装配在 src/runtime/assemble.ts；
// 运行时构建（per-isolate 缓存）在 src/entries/runtime.ts，与 WechatPollerDO 共享。
//
// - fetch：无状态 API（管理后台 / ServerChan 兼容 / 富推送），状态全在 D1；
// - scheduled（方案1 cron）：Cron Trigger 每分钟触发，按 settings.poll_interval_sec 门控收割；
//   （方案2 do 模式）：scheduled 只做保活/补挂 alarm 与维护，收割在 Durable Object 内；
// - 无常驻进程：收信 monitor / 邮件桥 / GC 定时器均不可用，等价能力分别由
//   cron/DO 收割、「不装配」、scheduled 整点 GC 承担。

import { listAccounts } from "../repo/accounts.ts";
import { runMaintenance, runScheduledWake, harvestableAccounts } from "../core/ingest.ts";
import { WechatPollerDO } from "./poller.ts";
import { getRuntime, type Env } from "./runtime.ts";

export { WechatPollerDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rt = await getRuntime(env);
    return rt.app.fetch(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const rt = await getRuntime(env);

    // 方案2（do 模式）：补挂丢失的 alarm + 维护任务，收割在 DO 内按 alarm 链自驱
    if (rt.cfg.ingestMode === "do") {
      if (!env.POLLER) {
        rt.log.warn("MOE_INGEST_MODE=do 但未配置 POLLER 绑定，回退 cron 收割", {});
        await runScheduledWake(rt.core, rt.wechat, { warnSweep: () => rt.warner.sweep() });
        return;
      }
      const now = Date.now();
      for (const account of harvestableAccounts(await listAccounts(rt.core.db), now)) {
        try {
          const stub = env.POLLER.get(env.POLLER.idFromName(account.id));
          if ((await stub.getAlarm()) === null) await stub.setAlarm(now);
        } catch (err) {
          rt.log.warn("ensure alarm failed", { accountId: account.id, err: String(err).slice(0, 200) });
        }
      }
      await runMaintenance(rt.core, () => rt.warner.sweep());
      return;
    }

    // 方案1（cron 模式，Workers 默认）
    const res = await runScheduledWake(rt.core, rt.wechat, { warnSweep: () => rt.warner.sweep() });
    if (res.woken) {
      rt.log.info("scheduled wake", {
        cron: controller.cron,
        accounts: res.harvests.length,
        messages: res.harvests.reduce((n, h) => n + (h.result?.messages ?? 0), 0),
        warnSweep: res.maintenance.warnSweep,
        gc: res.maintenance.gc,
      });
    }
  },
};

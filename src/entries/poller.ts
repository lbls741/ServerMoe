// 方案2：Durable Object alarm 链收信（MOE_INGEST_MODE=do）。
// 每个 bot 账号一个全局单例（idFromName(accountId)）——与 iLink「同一 bot_token 同一时间
// 只允许一个 getupdates 消费者」的硬约束一一对应。alarm 响应内做一次收割后重设下一次
// alarm（alarm 不会自动重复），从而：
// - 用量 ≈ hold 时长而非常驻：interval 60s + hold 35s ≈ 6,300 GB-s/天（免费 13,000 内）；
//   连续长轮询的常驻模式 ≈ 10,800 GB-s/天（占免费额度 83%），不做默认。
// - 游标/凭据的权威仍在 D1（accounts.sync_buf / peers / accounts.token_enc），
//   DO 自身零状态——部署重启、模式切换（cron ↔ do）零迁移。
// - 账号 rebind_needed / -14 熔断中 → 不再续挂 alarm，自停；scheduled 兜底补挂。

import { LONG_POLL_TIMEOUT_MS } from "../channels/wechat/ilink/constants.ts";
import { getAccount } from "../repo/accounts.ts";
import { acquirePollLease, effectivePollIntervalSec } from "../core/ingest.ts";
import { getRuntime, type Env } from "./runtime.ts";

export class WechatPollerDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/arm") {
      // scheduled/管理端兜底补挂：立即唤醒一次，alarm 处理器自行按间隔续挂
      await this.state.storage.setAlarm(Date.now());
      return Response.json({ ok: true, id: this.state.id.name ?? "" });
    }
    if (url.pathname === "/status") {
      return Response.json({ id: this.state.id.name ?? "", alarm: await this.state.storage.getAlarm() });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const rt = await getRuntime(this.env);
    const accountId = this.state.id.name;
    if (!accountId) return; // 无法定位账号（不应发生），不续挂即自停

    const account = await getAccount(rt.core.db, accountId);
    if (!account || account.status === "rebind_needed") return; // 解绑/需重扫 → 自停

    const now = Date.now();
    if (account.status === "paused" && (account.pausedUntil ?? 0) > now) {
      // -14 熔断窗口内：到窗口结束后再试一次
      await this.state.storage.setAlarm(Math.min(account.pausedUntil ?? now, now + 60 * 60_000));
      return;
    }

    const intervalSec = await effectivePollIntervalSec(rt.core);
    // hold 不超过间隔的 80%（且不超过服务端 35s）；租约与 cron/按需收割互斥
    const holdMs = Math.min(LONG_POLL_TIMEOUT_MS, Math.floor(intervalSec * 1000 * 0.8));
    if (await acquirePollLease(rt.core.db, accountId, Math.floor(holdMs * 0.9), now)) {
      try {
        const res = await rt.wechat.harvest(accountId, { holdMs });
        if (res.outcome !== "ok") rt.log.info("do harvest", { accountId, outcome: res.outcome });
      } catch (err) {
        rt.log.warn("do harvest failed", { accountId, err: String(err).slice(0, 200) });
      }
    }
    await this.state.storage.setAlarm(Date.now() + intervalSec * 1000);
  }
}

// 入站收割调度（core/ingest）：iLink「微信→本项目」方向的三种策略共用此处的节拍与收割入口。
// - resident（自部署默认）：常驻 monitor 自行循环，不经本模块；
// - cron（Workers 默认，方案1）：wrangler 固定每分钟触发 scheduled，本模块按
//   poll_interval_sec 门控决定是否真正收割（改频率只动 settings，无需重新部署）；
// - do（方案2）：scheduled 只做保活/补挂 alarm，收割在 Durable Object 内（entries/worker.ts）。
// - 按需收割（方案3）在 core/push 发送路径上叠加（tryHarvestBeforeSend）。
//
// 额度事实（research/serverless-function-deployment.md §2）：D1 免费 100k 写/天，
// 每分钟节拍戳 1,440 写/天 + 每账号收割 1-2 写，余量充足；KV（1k 写/天）不用于游标。

import type { Core } from "../core.ts";
import type { Db } from "../db/client.ts";
import type { WechatChannel } from "../channels/wechat/channel.ts";
import type { HarvestResult } from "../channels/wechat/harvest.ts";
import { LONG_POLL_TIMEOUT_MS } from "../channels/wechat/ilink/constants.ts";
import { getAccount, listAccounts, type AccountRow } from "../repo/accounts.ts";
import { gcLogs } from "../repo/logs.ts";
import { expireOutbox } from "../repo/outbox.ts";
import { getPeerToken } from "../repo/peers.ts";
import { ingestLeases } from "../db/schema.ts";
import { sql } from "drizzle-orm";
import { getSetting, setSetting } from "../repo/settings.ts";

/** cron 模式的最小有效间隔 = 触发器粒度（1 分钟） */
export const POLL_INTERVAL_MIN_SEC = 60;
/** do 模式 alarm 链允许更细粒度（用量≈hold/interval，见 README 免费额度表） */
export const DO_POLL_INTERVAL_MIN_SEC = 10;
export const POLL_INTERVAL_MAX_SEC = 24 * 3600;
export const POLL_INTERVAL_DEFAULT_SEC = 300;
/** 按需收割的单次上游挂起上限（有缓冲消息时服务端立即返回，否则快速放弃以控制推送延迟） */
export const ONDEMAND_HOLD_MS = 5_000;

/** settings 键：节拍戳（上次真正收割的唤醒时刻，epoch ms） */
export const WAKE_KEY = "poll_last_wake_at";
/** settings 键：上次日志/出箱 GC 时刻 */
export const GC_KEY = "gc_last_at";
const GC_INTERVAL_MS = 60 * 60 * 1000;

/** 钳位到 [min, 24h]；非法输入返回 null。 */
export function clampPollIntervalSec(raw: unknown, min: number = POLL_INTERVAL_MIN_SEC): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(POLL_INTERVAL_MAX_SEC, Math.max(min, n));
}

/** 有效频率：settings.poll_interval_sec（管理页可改）优先，否则 env 默认值；按策略钳位。 */
export async function effectivePollIntervalSec(core: Core): Promise<number> {
  const raw = await getSetting(core.db, "poll_interval_sec");
  const min = core.cfg.ingestMode === "do" ? DO_POLL_INTERVAL_MIN_SEC : POLL_INTERVAL_MIN_SEC;
  return clampPollIntervalSec(raw ?? core.cfg.pollIntervalSec, min) ?? POLL_INTERVAL_DEFAULT_SEC;
}

/** 节拍门控：距上次真正收割不足 interval 时跳过本轮。 */
export async function shouldWake(core: Core, now: number): Promise<boolean> {
  const interval = await effectivePollIntervalSec(core);
  const last = Number((await getSetting(core.db, WAKE_KEY)) ?? 0);
  return now - last >= interval * 1000;
}

export async function markWoke(core: Core, now: number): Promise<void> {
  await setSetting(core.db, WAKE_KEY, String(now));
}

/** 单次唤醒可收割的账号：非 rebind_needed，且未处于 -14 熔断窗口。 */
export function harvestableAccounts(accounts: AccountRow[], now: number): AccountRow[] {
  return accounts.filter((a) => a.status !== "rebind_needed" && !(a.status === "paused" && (a.pausedUntil ?? 0) > now));
}

/**
 * 收割互斥租约（单消费者约束的跨模式保证）：
 * cron 唤醒 / DO alarm / 按需收割在收割同一账号前都必须持租约。
 * 条件 upsert：仅当现有租约已过期（leased_until < now）时才授出，返回是否获得。
 */
export async function acquirePollLease(db: Db, accountId: string, minGapMs: number, now: number): Promise<boolean> {
  const row = await db
    .insert(ingestLeases)
    .values({ accountId, leasedUntil: now + minGapMs, lastPollAt: now })
    .onConflictDoUpdate({
      target: ingestLeases.accountId,
      set: { leasedUntil: now + minGapMs, lastPollAt: now },
      setWhere: sql`${ingestLeases.leasedUntil} < ${now}`,
    })
    .returning({ accountId: ingestLeases.accountId })
    .get();
  return row !== undefined;
}

export interface WakeResult {
  /** 本次是否真正收割（false = 节拍门控跳过） */
  woken: boolean;
  /** 收割结果按账号列出 */
  harvests: Array<{ accountId: string; result?: HarvestResult; error?: string }>;
  /** 本轮顺带执行的维护任务 */
  maintenance: { warnSweep: number; gc: boolean };
}

/**
 * 一次 scheduled 唤醒：节拍门控 → 逐账号 harvestOnce（hold 按 interval 收短，
 * 避免与下一次唤醒重叠）→ warner 扫描 → 整点 GC。单账号异常不中断整轮。
 */
export async function runScheduledWake(
  core: Core,
  wechat: WechatChannel,
  opts: { force?: boolean; warnSweep?: () => Promise<number> } = {},
): Promise<WakeResult> {
  const now = Date.now();
  const harvests: WakeResult["harvests"] = [];

  if (!opts.force && !(await shouldWake(core, now))) {
    return { woken: false, harvests, maintenance: { warnSweep: 0, gc: false } };
  }
  await markWoke(core, now);

  const intervalSec = await effectivePollIntervalSec(core);
  // hold 不超过间隔的 80%（且不超过服务端 35s），保证下一次唤醒前本次长轮询已返回
  const holdMs = Math.min(LONG_POLL_TIMEOUT_MS, Math.floor(intervalSec * 1000 * 0.8));

  const accounts = harvestableAccounts(await listAccounts(core.db), now);
  for (const account of accounts) {
    try {
      // 租约：与 DO/按需收割互斥（正常情况下节拍门控已保证间隔，租约是跨模式兜底）
      if (!(await acquirePollLease(core.db, account.id, Math.floor(holdMs * 0.9), now))) {
        harvests.push({ accountId: account.id, error: "lease busy (skipped)" });
        continue;
      }
      harvests.push({ accountId: account.id, result: await wechat.harvest(account.id, { holdMs }) });
    } catch (err) {
      harvests.push({ accountId: account.id, error: String(err).slice(0, 200) });
    }
  }

  const maintenance = await runMaintenance(core, opts.warnSweep);
  return { woken: true, harvests, maintenance };
}

/** 维护任务（scheduled 唤醒内顺带执行；do 模式下由 scheduled 单独调用）：warner 扫描 + 整点 GC。 */
export async function runMaintenance(
  core: Core,
  warnSweep?: () => Promise<number>,
): Promise<WakeResult["maintenance"]> {
  const now = Date.now();
  const maintenance: WakeResult["maintenance"] = { warnSweep: 0, gc: false };
  // 24h 窗口临期提醒：每拍扫描一次（廉价 SQL），语义与自部署 warner 60s sweep 一致
  if (warnSweep) {
    try {
      maintenance.warnSweep = await warnSweep();
    } catch (err) {
      core.log.warn("warn sweep failed", { err: String(err) });
    }
  }
  // 整点 GC：日志保留期 + 过期 outbox（与自部署 setInterval 60min 语义一致）
  const lastGc = Number((await getSetting(core.db, GC_KEY)) ?? 0);
  if (now - lastGc >= GC_INTERVAL_MS) {
    await gcLogs(core.db, now - 30 * 24 * 60 * 60 * 1000);
    await expireOutbox(core.db, now);
    await setSetting(core.db, GC_KEY, String(now));
    maintenance.gc = true;
  }
  return maintenance;
}

/** 方案3（按需收割）：推送遇 WARMUP_REQUIRED 时调用。抢到租约且收割到用户近期消息
 *  （context_token 可能已刷新）返回 true，调用方重试一轮发送；否则直接落入 outbox 排队。 */
export async function tryHarvestBeforeSend(core: Core, wechat: WechatChannel, accountId: string, peerUserId: string): Promise<boolean> {
  const now = Date.now();
  // 已有 token 的 peer 仍可能因窗口过期 ret=-2：收割腾讯侧缓冲的近期消息有望刷新 token
  const hadToken = Boolean(await getPeerToken(core.db, accountId, peerUserId));
  if (hadToken) return false; // 已预热过 → 失败是窗口/凭据问题，短收割大概率无解，走排队

  const intervalSec = await effectivePollIntervalSec(core);
  const minGapMs = Math.max((intervalSec * 1000) / 2, 30_000);
  if (!(await acquirePollLease(core.db, accountId, minGapMs, now))) return false;

  // 短 hold：有缓冲消息时服务端立即返回，否则快速放弃以控制推送延迟
  const res = await wechat.harvest(accountId, { holdMs: ONDEMAND_HOLD_MS });
  return res.outcome === "ok" && res.messages > 0;
}

/** 管理端「立即收割」（POST /api/v1/admin/ingest/poll-now）：跳过节拍门控强制一轮。 */
export async function pollNow(core: Core, wechat: WechatChannel): Promise<WakeResult> {
  return runScheduledWake(core, wechat, { force: true });
}

/** 校验账号可用于收割（管理端 poll-now 指定账号时）。 */
export async function getHarvestableAccount(core: Core, accountId: string): Promise<AccountRow | undefined> {
  const account = await getAccount(core.db, accountId);
  if (!account || account.status === "rebind_needed") return undefined;
  return account;
}

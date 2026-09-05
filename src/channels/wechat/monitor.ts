// iLink 长轮询收信循环（自部署常驻形态）。
// 收割本体在 harvest.ts（与 Workers 的 Cron/DO/按需策略共用同一条代码路径），
// 本文件只负责「驱动器」语义：notifyStart/Stop 生命周期、错误退避（2s 重试，
// 连续 3 次 30s 退避）、-14 熔断 1h（回调 onStale）、成功轮询回调 onAlive。

import { decryptString } from "../../crypto.ts";
import type { AccountRow } from "../../repo/accounts.ts";
import type { Logger } from "../../log.ts";
import {
  BACKOFF_DELAY_MS,
  LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  STALE_PAUSE_MS,
} from "./ilink/constants.ts";
import { notifyStart, notifyStop } from "./ilink/client.ts";
import { harvestOnce, type HarvestCallbacks } from "./harvest.ts";

export type { HarvestCallbacks as MonitorCallbacks } from "./harvest.ts";

export interface MonitorDeps {
  log: Logger;
  masterKey: Buffer;
  botAgent: string;
  /** harvestOnce 需要 DB 写游标（onCursor 回调内经 deps.db） */
  db: import("../../db/client.ts").Db;
}

export interface MonitorHandle {
  accountId: string;
  stop(): Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function startMonitor(deps: MonitorDeps, account: AccountRow, cb: HarvestCallbacks): MonitorHandle {
  const controller = new AbortController();
  const log = deps.log.child({ acct: account.id });

  const task = (async () => {
    log.info("monitor started", { baseUrl: account.baseUrl });
    const ctx = {
      baseUrl: account.baseUrl,
      token: decryptString(deps.masterKey, account.tokenEnc),
      botAgent: deps.botAgent,
    };
    await notifyStart(ctx).catch((err) => log.warn("notifystart failed", { err: String(err) }));

    let consecutive = 0;
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;
    let staleUntil = 0;
    // 防重复投递：同一 message_id 只处理一次（游标异常/服务端重发时兜底）
    const seenMsgIds = new Set<string>();

    while (!controller.signal.aborted) {
      if (Date.now() < staleUntil) {
        try {
          await sleep(staleUntil - Date.now(), controller.signal);
        } catch {
          break;
        }
        staleUntil = 0;
        continue;
      }
      const res = await harvestOnce({ ...deps, cb }, account, {
        holdMs: nextTimeoutMs,
        seenMsgIds,
        external: controller.signal,
      });

      if (res.outcome === "aborted") break;
      if (res.outcome === "stale") {
        log.error("pausing 1h (errcode -14)");
        staleUntil = Date.now() + STALE_PAUSE_MS;
        consecutive = 0;
        continue;
      }
      if (res.outcome === "error") {
        consecutive += 1;
        const delay = consecutive >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) consecutive = 0;
        try {
          await sleep(delay, controller.signal);
        } catch {
          break;
        }
        continue;
      }

      consecutive = 0;
      if (res.serverHoldMs && res.serverHoldMs > 0) nextTimeoutMs = res.serverHoldMs;
    }

    await notifyStop(ctx).catch(() => {});
    log.info("monitor stopped");
  })();

  return {
    accountId: account.id,
    stop: async () => {
      controller.abort();
      await task;
    },
  };
}

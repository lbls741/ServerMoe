import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { Core } from "../../src/core.ts";
import { loadConfig } from "../../src/config.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import {
  createAccount,
  getAccount,
  setWarnSettings,
  touchAccountInbound,
  updateAccountStatus,
} from "../../src/repo/accounts.ts";
import { upsertPeer } from "../../src/repo/peers.ts";
import {
  DEFAULT_WARN_LEAD_SEC,
  DEFAULT_WARN_TEXT,
  createWindowWarner,
  isWarnDue,
  normalizeWarnLeadSec,
} from "../../src/core/warn.ts";
import type { SendResult } from "../../src/channels/types.ts";

const HOUR = 3600_000;
const dir = mkdtempSync(join(tmpdir(), "ssc-warn-"));
const db = openDb(join(dir, "test.db"));
const log = createLogger("error");
const cfg = { ...loadConfig({}) };
const core = { cfg, log, db, masterKey: Buffer.alloc(32, 1), salt: "s", adminToken: "t" } as unknown as Core;

afterAll(() => {
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("normalizeWarnLeadSec", () => {
  test("钳位 5min–12h；空值/非法回 null（=默认）", () => {
    expect(normalizeWarnLeadSec(undefined)).toBeNull();
    expect(normalizeWarnLeadSec(null)).toBeNull();
    expect(normalizeWarnLeadSec("")).toBeNull();
    expect(normalizeWarnLeadSec("abc")).toBeNull();
    expect(normalizeWarnLeadSec(60)).toBe(300);
    expect(normalizeWarnLeadSec(1800)).toBe(1800);
    expect(normalizeWarnLeadSec(10 ** 9)).toBe(43200);
    expect(normalizeWarnLeadSec("900.9")).toBe(900);
  });
});

describe("isWarnDue", () => {
  // 提醒时刻 = lastInboundAt + 24h − leadSec
  test("未到提醒时刻（窗口 − 提前量之前）不提醒", () => {
    const t = { lastInboundAt: 0, warnedAt: null, leadSec: 1800 };
    expect(isWarnDue(t, 23 * HOUR)).toBe(false);
    expect(isWarnDue(t, 23.5 * HOUR)).toBe(true);
    expect(isWarnDue(t, 30 * HOUR)).toBe(true);
  });

  test("默认提前量 30min", () => {
    expect(DEFAULT_WARN_LEAD_SEC).toBe(1800);
  });

  test("当前静默窗口内已提醒过则不重复", () => {
    const t = { lastInboundAt: 0, warnedAt: 24 * HOUR, leadSec: 1800 };
    expect(isWarnDue(t, 25 * HOUR)).toBe(false);
  });

  test("用户回复后（lastInbound 前移）进入新窗口，可再次提醒", () => {
    const t = { lastInboundAt: 20 * HOUR, warnedAt: 10 * HOUR, leadSec: 1800 };
    expect(isWarnDue(t, 20 * HOUR + 23.5 * HOUR)).toBe(true);
  });

  test("从未入站（lastInboundAt=null）不提醒", () => {
    expect(isWarnDue({ lastInboundAt: null, warnedAt: null, leadSec: 1800 }, 100 * HOUR)).toBe(false);
  });
});

describe("createWindowWarner.sweep", () => {
  function mkWarnAccount(id: string, opts: { owner?: string; peer?: boolean } = {}): void {
    createAccount(db, { id, tokenEnc: "x", baseUrl: "http://x", ownerUserId: opts.owner ?? `u-${id}`, now: Date.now() });
    if (opts.peer !== false) upsertPeer(db, id, opts.owner ?? `u-${id}`, "ctx", Date.now());
  }

  test("临期账号按默认文案提醒并标记；同窗口不重发", async () => {
    mkWarnAccount("w-1");
    setWarnSettings(db, "w-1", { enabled: true, text: null, leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-1", Date.now() - 13 * HOUR); // 静默 13h > 24h−12h 提前量
    const sends: Array<{ accountId: string; peer: string; text: string }> = [];
    const warner = createWindowWarner(core, {
      send: async (accountId, peer, text) => {
        sends.push({ accountId, peer, text });
        return { ok: true, clientId: "c1" };
      },
    });
    expect(await warner.sweep()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accountId).toBe("w-1");
    expect(sends[0]!.peer).toBe("u-w-1");
    expect(sends[0]!.text).toBe(DEFAULT_WARN_TEXT);
    expect((await getAccount(db, "w-1"))!.warnedAt).not.toBeNull();
    expect(await warner.sweep()).toBe(0);
    expect(sends).toHaveLength(1);
    warner.shutdown();
  });

  test("自定义文案与提前量生效；未启用/未预热/非 active 跳过", async () => {
    mkWarnAccount("w-2"); // 未开启提醒
    mkWarnAccount("w-3"); // 开启但从未入站
    setWarnSettings(db, "w-3", { enabled: true, text: null, leadSec: 300 }, Date.now());
    mkWarnAccount("w-4"); // 自定义文案
    setWarnSettings(db, "w-4", { enabled: true, text: "自定义提醒", leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-4", Date.now() - 13 * HOUR);
    mkWarnAccount("w-5"); // rebind_needed 跳过
    setWarnSettings(db, "w-5", { enabled: true, text: null, leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-5", Date.now() - 13 * HOUR);
    updateAccountStatus(db, "w-5", "rebind_needed", Date.now());

    const sends: string[] = [];
    const warner = createWindowWarner(core, {
      send: async (accountId, _peer, text) => {
        sends.push(accountId + ":" + text);
        return { ok: true, clientId: "c" };
      },
    });
    expect(await warner.sweep()).toBe(1);
    expect(sends).toEqual(["w-4:自定义提醒"]);
    warner.shutdown();
  });

  test("WARMUP_REQUIRED 视为本窗口已提醒；ERROR 不标记（下轮重试）；TOKEN_EXPIRED 标记重扫", async () => {
    mkWarnAccount("w-6");
    setWarnSettings(db, "w-6", { enabled: true, text: null, leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-6", Date.now() - 13 * HOUR);
    mkWarnAccount("w-7");
    setWarnSettings(db, "w-7", { enabled: true, text: null, leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-7", Date.now() - 13 * HOUR);
    mkWarnAccount("w-8");
    setWarnSettings(db, "w-8", { enabled: true, text: null, leadSec: 43200 }, Date.now());
    touchAccountInbound(db, "w-8", Date.now() - 13 * HOUR);

    const results: Record<string, SendResult> = {
      "w-6": { ok: false, reason: "WARMUP_REQUIRED" },
      "w-7": { ok: false, reason: "ERROR", error: "boom" },
      "w-8": { ok: false, reason: "TOKEN_EXPIRED" },
    };
    const attempts: string[] = [];
    const warner = createWindowWarner(core, {
      send: async (accountId) => {
        attempts.push(accountId);
        return results[accountId]!;
      },
    });
    expect(await warner.sweep()).toBe(0);
    expect((await getAccount(db, "w-6"))!.warnedAt).not.toBeNull(); // 一次性，不重试
    expect((await getAccount(db, "w-7"))!.warnedAt).toBeNull(); // 瞬时错误，等下轮
    expect((await getAccount(db, "w-8"))!.status).toBe("rebind_needed"); // 与 push.ts 同语义
    expect(attempts.filter((a) => a === "w-7")).toHaveLength(1);
    expect(await warner.sweep()).toBe(0); // w-6/w-8 已标记；w-7 重试
    expect(attempts.filter((a) => a === "w-7")).toHaveLength(2);
    warner.shutdown();
  });
});

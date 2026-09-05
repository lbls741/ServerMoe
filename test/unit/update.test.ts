import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { getSetting, setSetting } from "../../src/repo/settings.ts";
import {
  UPDATE_INTERVAL_DEFAULT_SEC,
  createUpdateChecker,
  isNewerVersion,
  normalizeIntervalSec,
  parseVersion,
  updateHeaderPayload,
  type UpdateCheckerDeps,
} from "../../src/update/checker.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-update-"));
const db = openDb(join(dir, "test.db"));
const log = createLogger("error");
const baseCfg = { ...loadConfig({}) };

afterAll(() => {
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("version compare", () => {
  test("parseVersion 只认三段数字（容忍 v 前缀）", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("1.2.3-rc1")).toBeNull();
  });

  test("isNewerVersion 按位比较，等/旧版本不算新", () => {
    expect(isNewerVersion("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });
});

describe("normalizeIntervalSec", () => {
  test("钳位到 1h–7d，非法回退默认", () => {
    expect(normalizeIntervalSec(60)).toBe(3600);
    expect(normalizeIntervalSec(86400)).toBe(86400);
    expect(normalizeIntervalSec(10 ** 9)).toBe(7 * 24 * 3600);
    expect(normalizeIntervalSec("abc")).toBe(UPDATE_INTERVAL_DEFAULT_SEC);
    expect(normalizeIntervalSec(undefined)).toBe(UPDATE_INTERVAL_DEFAULT_SEC);
  });
});

describe("updateHeaderPayload", () => {
  test("自构建只带 kind", () => {
    expect(updateHeaderPayload({ kind: "selfbuilt" })).toEqual({ kind: "selfbuilt" });
  });
  test("available 附 latest 与 release 页", () => {
    const p = updateHeaderPayload({ kind: "available", current: "0.1.0", latest: "0.2.0", url: "https://x/releases/latest", checkedAt: 1 });
    expect(p.kind).toBe("available");
    expect(p.latest).toBe("0.2.0");
    expect(p.url).toContain("/releases/latest");
  });
});

describe("createUpdateChecker", () => {
  function makeCore(version?: string) {
    return { cfg: { ...baseCfg, version, updateRepo: "example/org" }, db, log };
  }
  function makeDeps(tag: string | Error): { deps: UpdateCheckerDeps; calls: () => number } {
    let n = 0;
    return {
      deps: {
        now: () => t,
        fetchLatestTag: async () => {
          n++;
          if (tag instanceof Error) throw tag;
          return tag;
        },
      },
      calls: () => n,
    };
  }

  // 起点 100h：确保相对 lastCheck=0 已超过默认 24h 阈值
  let t = 100 * 3600_000;

  test("自构建：短路所有逻辑，不发请求", async () => {
    const { deps, calls } = makeDeps("v9.9.9");
    const c = createUpdateChecker(makeCore(undefined), deps);
    expect(await c.maybeCheck()).toEqual({ kind: "selfbuilt" });
    expect(calls()).toBe(0);
  });

  test("到期检测：发现新版本 → available + 落盘 lastCheck/latest；阈值内不重复请求", async () => {
    await setSetting(db, "update_last_check_at", "0");
    const { deps, calls } = makeDeps("v0.2.0");
    const c = createUpdateChecker(makeCore("0.1.0"), deps);
    const st = await c.maybeCheck();
    expect(st).toMatchObject({ kind: "available", current: "0.1.0", latest: "0.2.0" });
    expect((st as { url?: string }).url).toContain("github.com/example/org/releases/latest");
    expect(Number(await getSetting(db, "update_last_check_at"))).toBe(t);
    expect(await getSetting(db, "update_latest_version")).toBe("0.2.0");

    t += 3600_000; // 1h < 默认 24h 阈值 → 走缓存
    expect(await c.maybeCheck()).toMatchObject({ kind: "available" });
    expect(calls()).toBe(1);
  });

  test("latest 不大于本地 → current", async () => {
    await setSetting(db, "update_last_check_at", "0");
    const { deps, calls } = makeDeps("v0.1.0");
    const c = createUpdateChecker(makeCore("0.1.0"), deps);
    expect(await c.maybeCheck()).toMatchObject({ kind: "current", latest: "0.1.0" });
    expect(calls()).toBe(1);
  });

  test("检测失败 → error 态，同样刷新上次检测时间（不逐请求重试）", async () => {
    await setSetting(db, "update_last_check_at", "0");
    const { deps, calls } = makeDeps(new Error("boom"));
    const c = createUpdateChecker(makeCore("0.1.0"), deps);
    expect(await c.maybeCheck()).toMatchObject({ kind: "error", message: "Error: boom" });
    expect(Number(await getSetting(db, "update_last_check_at"))).toBe(t);
    t += 1000;
    expect(await c.maybeCheck()).toMatchObject({ kind: "error" });
    expect(calls()).toBe(1);
  });

  test("关闭开关 → disabled 且不请求", async () => {
    await setSetting(db, "update_check_enabled", "0");
    await setSetting(db, "update_last_check_at", "0");
    const { deps, calls } = makeDeps("v9.9.9");
    const c = createUpdateChecker(makeCore("0.1.0"), deps);
    expect(await c.maybeCheck()).toMatchObject({ kind: "disabled" });
    expect(calls()).toBe(0);
    await setSetting(db, "update_check_enabled", "1");
  });

  test("重启后阈值内从 settings 恢复结论，无需再等网络", async () => {
    await setSetting(db, "update_last_check_at", String(t));
    await setSetting(db, "update_latest_version", "0.2.0");
    const { deps, calls } = makeDeps("v9.9.9");
    const c = createUpdateChecker(makeCore("0.1.0"), deps); // 新实例 = 模拟重启
    expect(await c.maybeCheck()).toMatchObject({ kind: "available", latest: "0.2.0" });
    expect(calls()).toBe(0);
  });

  test("间隔设置被钳位：1h 间隔 + 超时 2h → 再次到期", async () => {
    await setSetting(db, "update_check_interval_sec", "60"); // 会按 1h 钳位
    const { deps, calls } = makeDeps("v0.3.0");
    const c = createUpdateChecker(makeCore("0.1.0"), deps);
    await setSetting(db, "update_last_check_at", String(t));
    t += 2 * 3600_000;
    expect(await c.maybeCheck()).toMatchObject({ kind: "available", latest: "0.3.0" });
    expect(calls()).toBe(1);
  });
});

// 自动更新检测（业务层）。策略：
// - 自构建版（未注入 MOE_VERSION）→ 整个逻辑短路，永不发起网络请求；
// - 每次前端请求经 maybeCheck()：距上次检测不足阈值直接返回内存缓存；
//   到期则访问 GitHub Release API 取 latest 版本号，并刷新上次检测时间（失败同样刷新，避免逐请求重试打爆）；
// - 检测结果同时写入 settings（重启后阈值内可恢复，不必再等网络）；
// - 前端契约：/api/v1/* 与 / 的响应携带状态（响应头 X-Moe-Update / 页面内嵌 __MOE_UPDATE__），
//   kind=available 时附 latest 与 release 页 URL，kind=error 时由前端展示检测失败提示。

import type { Core } from "../core.ts";
import { getSetting, setSetting } from "../repo/settings.ts";

const CHECK_TIMEOUT_MS = 5_000;
/** 设置键：是否启用 / 检测间隔(秒) / 上次检测时间(ms) / 最近一次已知 latest */
const KEY_ENABLED = "update_check_enabled";
const KEY_INTERVAL = "update_check_interval_sec";
const KEY_LAST_CHECK = "update_last_check_at";
const KEY_LATEST = "update_latest_version";

export const UPDATE_INTERVAL_MIN_SEC = 3600;
export const UPDATE_INTERVAL_MAX_SEC = 7 * 24 * 3600;
export const UPDATE_INTERVAL_DEFAULT_SEC = 24 * 3600;

/** 存储值归一到 [1h, 7d]；非法回退默认 24h。API 与检测器共用。 */
export function normalizeIntervalSec(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return UPDATE_INTERVAL_DEFAULT_SEC;
  return Math.min(UPDATE_INTERVAL_MAX_SEC, Math.max(UPDATE_INTERVAL_MIN_SEC, n));
}

export type UpdateState =
  | { kind: "selfbuilt" }
  | { kind: "disabled"; current: string }
  | { kind: "idle"; current: string }
  | { kind: "current"; current: string; latest: string; checkedAt: number }
  | { kind: "available"; current: string; latest: string; url: string; checkedAt: number }
  | { kind: "error"; current: string; message: string; checkedAt: number };

/** 附给前端的精简载荷（响应头 / 页面内嵌共用）。 */
export interface UpdatePayload {
  kind: UpdateState["kind"];
  current?: string;
  latest?: string;
  url?: string;
  message?: string;
  checkedAt?: number;
}

export function updateHeaderPayload(state: UpdateState): UpdatePayload {
  switch (state.kind) {
    case "selfbuilt":
      return { kind: "selfbuilt" };
    case "disabled":
    case "idle":
      return { kind: state.kind, current: state.current };
    case "current":
      return { kind: "current", current: state.current, latest: state.latest, checkedAt: state.checkedAt };
    case "available":
      return { kind: "available", current: state.current, latest: state.latest, url: state.url, checkedAt: state.checkedAt };
    case "error":
      return { kind: "error", current: state.current, message: state.message, checkedAt: state.checkedAt };
  }
}

/** "v1.2.3" / "1.2.3" → [1,2,3]；其余形态（自构建哈希、dev 等）视为不可解析。 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

async function defaultFetchLatestTag(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ServerMoe-update-check" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const j = (await res.json()) as { tag_name?: unknown };
  if (typeof j.tag_name !== "string" || !j.tag_name) throw new Error("响应缺少 tag_name");
  return j.tag_name;
}

export interface UpdateCheckerDeps {
  /** 注入可离线测试；默认访问 GitHub Release API */
  fetchLatestTag?: (repo: string) => Promise<string>;
  now?: () => number;
}

export interface UpdateChecker {
  /** 前端请求路径上调用：按需检测并返回当前状态（不会抛异常） */
  maybeCheck(): Promise<UpdateState>;
  /** 不触发网络的当前状态快照（SSR 首屏用） */
  snapshot(): UpdateState;
}

export function createUpdateChecker(core: Pick<Core, "cfg" | "db" | "log">, deps: UpdateCheckerDeps = {}): UpdateChecker {
  const now = deps.now ?? Date.now;
  const repo = core.cfg.updateRepo;
  // 官方镜像由构建期注入 MOE_VERSION（tag 形如 v0.2.1）；为空即自构建
  const current = (core.cfg.version ?? "").trim().replace(/^v/, "");
  const selfBuilt = current === "";
  const releaseUrl = `https://github.com/${repo}/releases/latest`;

  let state: UpdateState = selfBuilt ? { kind: "selfbuilt" } : { kind: "idle", current };
  let inflight: Promise<void> | null = null;

  async function intervalSec(): Promise<number> {
    return normalizeIntervalSec(await getSetting(core.db, KEY_INTERVAL));
  }

  async function isDue(nowMs: number): Promise<boolean> {
    const last = Number((await getSetting(core.db, KEY_LAST_CHECK)) ?? 0);
    return !(nowMs - last < (await intervalSec()) * 1000);
  }

  /** 阈值内但进程刚重启：从 settings 恢复上次结论，避免重启后提示条空白一整个周期。 */
  async function restore(): Promise<void> {
    const latest = await getSetting(core.db, KEY_LATEST);
    if (!latest) return;
    const checkedAt = Number((await getSetting(core.db, KEY_LAST_CHECK)) ?? 0);
    state = isNewerVersion(latest, current)
      ? { kind: "available", current, latest, url: releaseUrl, checkedAt }
      : { kind: "current", current, latest, checkedAt };
  }

  async function runCheck(): Promise<void> {
    const nowMs = now();
    await setSetting(core.db, KEY_LAST_CHECK, String(nowMs)); // 失败也计为一次检测，防止逐请求重试
    try {
      const tag = await (deps.fetchLatestTag ?? defaultFetchLatestTag)(repo);
      const latest = tag.trim().replace(/^v/, "");
      await setSetting(core.db, KEY_LATEST, latest);
      state = isNewerVersion(latest, current)
        ? { kind: "available", current, latest, url: releaseUrl, checkedAt: nowMs }
        : { kind: "current", current, latest, checkedAt: nowMs };
      core.log.info("update check done", { current, latest, hasUpdate: state.kind === "available" });
    } catch (err) {
      state = { kind: "error", current, message: String(err).slice(0, 160), checkedAt: nowMs };
      core.log.warn("update check failed", { err: String(err) });
    }
  }

  return {
    async maybeCheck(): Promise<UpdateState> {
      if (selfBuilt) return state;
      if ((await getSetting(core.db, KEY_ENABLED)) === "0") {
        state = { kind: "disabled", current };
        return state;
      }
      const nowMs = now();
      if (!(await isDue(nowMs))) {
        if (state.kind === "idle") await restore();
        return state;
      }
      if (!inflight) inflight = runCheck().finally(() => (inflight = null)); // 并发请求共享同一次检测
      await inflight;
      return state;
    },
    snapshot(): UpdateState {
      return state;
    },
  };
}

export type { UpdateCheckerDeps as CheckerDeps };

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createRateLimiter } from "../../src/api/ratelimit.ts";
import { createApp } from "../../src/app.ts";
import { createRegistry } from "../../src/channels/registry.ts";
import { createWechatChannel } from "../../src/channels/wechat/channel.ts";
import { loadConfig } from "../../src/config.ts";
import { createPushService } from "../../src/core/push.ts";
import type { Core } from "../../src/core.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import type { UpdateChecker, UpdateState } from "../../src/update/checker.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-test-"));
const db = openDb(join(dir, "test.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "test.db") };
const log = createLogger("error");
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey: Buffer.alloc(32, 1), salt: "testsalt" });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey: Buffer.alloc(32, 1), salt: "testsalt", adminToken: "test-admin", channels };
const app = createApp({ core, push: createPushService(core), wechat, limiter: createRateLimiter(60, 10) });

// 注入假检测器的第二实例：验证更新状态如何随响应到达前端
const fakeState: UpdateState = {
  kind: "available",
  current: "0.1.1",
  latest: "9.9.9",
  url: "https://github.com/example/org/releases/latest",
  checkedAt: 123,
};
const fakeChecker: UpdateChecker = {
  maybeCheck: async () => fakeState,
  snapshot: () => fakeState,
};
const appFake = createApp({ core, push: createPushService(core), wechat, limiter: createRateLimiter(60, 10), updateChecker: fakeChecker });

afterAll(() => {
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("http skeleton", () => {
  test("GET /healthz", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  test("GET /statusz 需要管理鉴权（账号信息不向未授权者泄露）", async () => {
    expect((await app.request("/statusz")).status).toBe(401);
    const res = await app.request("/statusz", { headers: { authorization: "Bearer test-admin" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  test("unknown single-segment route -> 404 JSON", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(404);
  });

  test("admin guard on v1", async () => {
    const res = await app.request("/api/v1/sessions");
    expect(res.status).toBe(401);
  });
});

describe("migrations + repos roundtrip", () => {
  test("accounts CRUD over migrated schema", async () => {
    const { createAccount, getAccount, updateAccountStatus, deleteAccount } = await import("../../src/repo/accounts.ts");
    const now = Date.now();
    const acc = await createAccount(db, { id: "bot-test", tokenEnc: "enc", baseUrl: "https://example.com", now });
    expect(acc.id).toBe("bot-test");
    expect(acc.status).toBe("active");
    expect((await getAccount(db, "bot-test"))?.baseUrl).toBe("https://example.com");

    await updateAccountStatus(db, "bot-test", "rebind_needed", now, { lastError: "errcode -14" });
    expect((await getAccount(db, "bot-test"))?.status).toBe("rebind_needed");

    await deleteAccount(db, "bot-test");
    expect(await getAccount(db, "bot-test")).toBeUndefined();
  });

  test("peers upsert keeps latest context token per user", async () => {
    const { upsertPeer, getPeerToken } = await import("../../src/repo/peers.ts");
    await upsertPeer(db, "acc1", "user1", "tok-old", 1);
    await upsertPeer(db, "acc1", "user1", "tok-new", 2);
    expect(await getPeerToken(db, "acc1", "user1")).toBe("tok-new");
    expect(await getPeerToken(db, "acc1", "other")).toBeUndefined();
  });

  test("sendkeys create/find/revoke", async () => {
    const { createSendkey, findActiveSendkey, revokeSendkeys } = await import("../../src/repo/sendkeys.ts");
    const now = Date.now();
    const row = await createSendkey(db, { keyHash: "hash-1", accountId: "acc1", now });
    expect((await findActiveSendkey(db, "hash-1"))?.id).toBe(row.id);
    await revokeSendkeys(db, "acc1", now);
    expect(await findActiveSendkey(db, "hash-1")).toBeUndefined();
  });

  test("settings upsert", async () => {
    const { getSetting, setSetting } = await import("../../src/repo/settings.ts");
    await setSetting(db, "k", "v1");
    await setSetting(db, "k", "v2");
    expect(await getSetting(db, "k")).toBe("v2");
    expect(await getSetting(db, "missing")).toBeUndefined();
  });
});

describe("update check plumbing", () => {
  const auth = { headers: { authorization: "Bearer test-admin" } };

  test("自构建实例：/api/v1 响应仍带 X-Moe-Update（401 也有），首页内嵌初始状态", async () => {
    const res = await app.request("/api/v1/sessions");
    expect(res.status).toBe(401);
    const hdr = res.headers.get("X-Moe-Update");
    expect(hdr).toBeTruthy();
    expect(JSON.parse(hdr!)).toEqual({ kind: "selfbuilt" });

    const page = await app.request("/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("window.__MOE_UPDATE__=");
    expect(html).toContain('"kind":"selfbuilt"');
  });

  test("available 状态经响应头与首页内嵌到达前端", async () => {
    const res = await appFake.request("/api/v1/sessions");
    const hdr = JSON.parse(res.headers.get("X-Moe-Update")!) as { kind: string; latest: string; url: string };
    expect(hdr.kind).toBe("available");
    expect(hdr.latest).toBe("9.9.9");
    expect(hdr.url).toContain("/releases/latest");

    const html = await (await appFake.request("/")).text();
    expect(html).toContain('"latest":"9.9.9"');
  });

  test("设置 API 读写更新检测开关与频率（含非法值拒绝）", async () => {
    const j = (await (await app.request("/api/v1/admin/settings", auth)).json()) as {
      update_check_enabled: string;
      update_check_interval_sec: number;
    };
    expect(j.update_check_enabled).toBe("1");
    expect(j.update_check_interval_sec).toBe(86400);

    const put = await app.request("/api/v1/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer test-admin" },
      body: JSON.stringify({ update_check_enabled: "0", update_check_interval_sec: 21600 }),
    });
    expect(put.status).toBe(200);
    const j2 = (await (await app.request("/api/v1/admin/settings", auth)).json()) as { update_check_enabled: string; update_check_interval_sec: number };
    expect(j2.update_check_enabled).toBe("0");
    expect(j2.update_check_interval_sec).toBe(21600);

    const bad = await app.request("/api/v1/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer test-admin" },
      body: JSON.stringify({ update_check_enabled: "yes" }),
    });
    expect(bad.status).toBe(400);
  });
});

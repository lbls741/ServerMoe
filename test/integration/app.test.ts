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

const dir = mkdtempSync(join(tmpdir(), "ssc-test-"));
const db = openDb(join(dir, "test.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "test.db") };
const log = createLogger("error");
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey: Buffer.alloc(32, 1), salt: "testsalt" });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey: Buffer.alloc(32, 1), salt: "testsalt", adminToken: "test-admin", channels };
const app = createApp({ core, push: createPushService(core), wechat, limiter: createRateLimiter(60, 10) });

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
    const acc = createAccount(db, { id: "bot-test", tokenEnc: "enc", baseUrl: "https://example.com", now });
    expect(acc.id).toBe("bot-test");
    expect(acc.status).toBe("active");
    expect(getAccount(db, "bot-test")?.baseUrl).toBe("https://example.com");

    updateAccountStatus(db, "bot-test", "rebind_needed", now, { lastError: "errcode -14" });
    expect(getAccount(db, "bot-test")?.status).toBe("rebind_needed");

    deleteAccount(db, "bot-test");
    expect(getAccount(db, "bot-test")).toBeUndefined();
  });

  test("peers upsert keeps latest context token per user", async () => {
    const { upsertPeer, getPeerToken } = await import("../../src/repo/peers.ts");
    upsertPeer(db, "acc1", "user1", "tok-old", 1);
    upsertPeer(db, "acc1", "user1", "tok-new", 2);
    expect(getPeerToken(db, "acc1", "user1")).toBe("tok-new");
    expect(getPeerToken(db, "acc1", "other")).toBeUndefined();
  });

  test("sendkeys create/find/revoke", async () => {
    const { createSendkey, findActiveSendkey, revokeSendkeys } = await import("../../src/repo/sendkeys.ts");
    const now = Date.now();
    const row = createSendkey(db, { keyHash: "hash-1", accountId: "acc1", now });
    expect(findActiveSendkey(db, "hash-1")?.id).toBe(row.id);
    revokeSendkeys(db, "acc1", now);
    expect(findActiveSendkey(db, "hash-1")).toBeUndefined();
  });

  test("settings upsert", async () => {
    const { getSetting, setSetting } = await import("../../src/repo/settings.ts");
    setSetting(db, "k", "v1");
    setSetting(db, "k", "v2");
    expect(getSetting(db, "k")).toBe("v2");
    expect(getSetting(db, "missing")).toBeUndefined();
  });
});

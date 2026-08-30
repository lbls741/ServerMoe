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
import { encryptString, sha256Hex } from "../../src/crypto.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { createAccount } from "../../src/repo/accounts.ts";
import { createKeyword } from "../../src/repo/keywords.ts";
import { addInboundLog, addPushLog } from "../../src/repo/logs.ts";
import { createSendkey, findActiveSendkey } from "../../src/repo/sendkeys.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-admin-"));
const db = openDb(join(dir, "t.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
const log = createLogger("error");
const masterKey = Buffer.alloc(32, 3);
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "testsalt" });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey, salt: "testsalt", adminToken: "test-admin", channels };
const app = createApp({ core, push: createPushService(core), wechat, limiter: createRateLimiter(10_000, 10_000) });

const H = { authorization: "Bearer test-admin", "content-type": "application/json" };

createAccount(db, {
  id: "bot-a",
  tokenEnc: encryptString(masterKey, "tok-a"),
  baseUrl: "http://127.0.0.1:1",
  ownerUserId: "user-a",
  now: Date.now(),
});
createSendkey(db, { keyHash: sha256Hex(core.salt + ":SSCOLDOLDOLDOLD001"), accountId: "bot-a", now: Date.now() });
createKeyword(db, { accountId: "bot-a", keyword: "ping", matchMode: "exact", url: "https://example.com/hook", now: Date.now() });
addPushLog(db, { ts: Date.now(), accountId: "bot-a", title: "测试推送", status: "sent" });
addInboundLog(db, { ts: Date.now(), accountId: "bot-a", fromUserId: "user-a", text: "ping", action: "forwarded" });

afterAll(() => {
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("管理端点（M4）", () => {
  test("鉴权：无 token 一律 401", async () => {
    expect((await app.request("/api/v1/sessions/bot-a/reset-key", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/v1/admin/settings")).status).toBe(401);
    expect((await app.request("/api/v1/admin/logs")).status).toBe(401);
  });

  test("sendkey 轮换：旧 key 失效、新 key 生效且仅明文返回一次", async () => {
    const res = await app.request("/api/v1/sessions/bot-a/reset-key", { method: "POST", headers: H });
    const j = (await res.json()) as { code: number; sendkey: string };
    expect(j.code).toBe(0);
    expect(j.sendkey).toMatch(/^SSC[23456789A-HJ-NP-Za-km-z]{16}$/);

    expect(findActiveSendkey(db, sha256Hex(core.salt + ":SSCOLDOLDOLDOLD001"))).toBeUndefined();
    const fresh = findActiveSendkey(db, sha256Hex(core.salt + ":" + j.sendkey));
    expect(fresh?.accountId).toBe("bot-a");
  });

  test("settings：默认值读写与校验", async () => {
    const g1 = (await (await app.request("/api/v1/admin/settings", { headers: H })).json()) as {
      no_match_remind: string;
      no_match_text: string;
    };
    expect(g1.no_match_remind).toBe("1");
    expect(g1.no_match_text).toBe("");

    const bad = await app.request("/api/v1/admin/settings", { method: "PUT", headers: H, body: JSON.stringify({ no_match_remind: "yes" }) });
    expect(bad.status).toBe(400);

    const put = await app.request("/api/v1/admin/settings", {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ no_match_remind: "0", no_match_text: "没听懂，发送 help" }),
    });
    expect(((await put.json()) as { code: number }).code).toBe(0);

    const g2 = (await (await app.request("/api/v1/admin/settings", { headers: H })).json()) as {
      no_match_remind: string;
      no_match_text: string;
    };
    expect(g2.no_match_remind).toBe("0");
    expect(g2.no_match_text).toBe("没听懂，发送 help");
  });

  test("logs：最近的入站与推送记录", async () => {
    const j = (await (await app.request("/api/v1/admin/logs", { headers: H })).json()) as {
      inbound: Array<{ text: string; action: string }>;
      push: Array<{ title: string; status: string }>;
    };
    expect(j.inbound[0]?.text).toBe("ping");
    expect(j.inbound[0]?.action).toBe("forwarded");
    expect(j.push[0]?.title).toBe("测试推送");
    expect(j.push[0]?.status).toBe("sent");
  });

  test("关键词 CRUD 走 admin + accountId 作用域", async () => {
    const list = (await (await app.request("/api/v1/keywords?accountId=bot-a", { headers: H })).json()) as {
      keywords: Array<{ keyword: string }>;
    };
    expect(list.keywords.map((k) => k.keyword)).toContain("ping");

    const noScope = await app.request("/api/v1/keywords", { method: "POST", headers: H, body: JSON.stringify({ keyword: "x", match: "exact", url: "https://e.com" }) });
    expect(noScope.status).toBe(400);
  });
});

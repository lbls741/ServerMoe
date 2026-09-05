// 入站收割策略（core/ingest + channels/wechat/harvest）单元测试：
// - harvestOnce（经 wechat.harvest）：游标续传 / context_token 捕获 / -14 stale / 错误计数
// - scheduled 节拍门控：shouldWake / markWoke / effectivePollIntervalSec 钳位
// - D1 令牌桶（bun:sqlite 替身驱动验证 SQL 逻辑）：burst / 回填 / 拒绝
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import { createD1RateLimiter } from "../../src/api/ratelimit.ts";
import { createRegistry } from "../../src/channels/registry.ts";
import { createWechatChannel } from "../../src/channels/wechat/channel.ts";
import { MessageItemType, MessageType } from "../../src/channels/wechat/ilink/types.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import {
  DO_POLL_INTERVAL_MIN_SEC,
  POLL_INTERVAL_DEFAULT_SEC,
  POLL_INTERVAL_MAX_SEC,
  POLL_INTERVAL_MIN_SEC,
  clampPollIntervalSec,
  effectivePollIntervalSec,
  markWoke,
  shouldWake,
} from "../../src/core/ingest.ts";
import type { Core } from "../../src/core.ts";
import { encryptString } from "../../src/crypto.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { createAccount, getAccount } from "../../src/repo/accounts.ts";
import { getPeerToken } from "../../src/repo/peers.ts";
import { setSetting } from "../../src/repo/settings.ts";
import { startMockIlink } from "../ilink/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-ingest-"));
const db = openDb(join(dir, "t.db"));
const log = createLogger("error");
const masterKey = Buffer.alloc(32, 3);

const mock = startMockIlink(() => ({
  qrStatus: [],
  updates: [],
  sends: [{ ret: 0 }],
}));

function userMsg(from: string, ctx: string, text = "hello") {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    context_token: ctx,
  };
}

afterAll(() => {
  mock.stop();
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("harvestOnce（wechat.harvest）", () => {
  test("收割推进游标并捕获 context_token；重复收割不重复处理", async () => {
    await createAccount(db, {
      id: "bot-h",
      tokenEnc: encryptString(masterKey, "tok-h"),
      baseUrl: `http://127.0.0.1:${mock.port}`,
      ownerUserId: "user-h",
      now: Date.now(),
    });
    const cfg: Config = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
    const channels = createRegistry();
    const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "salt", monitorMode: "cron" });
    channels.register(wechat);

    mock.scenario.updates.push({ msgs: [userMsg("user-h", "ctx-h1")], newBuf: "BUF-H1" });
    const r1 = await wechat.harvest("bot-h");
    expect(r1.outcome).toBe("ok");
    expect(r1.messages).toBe(1);
    expect(r1.cursorAdvanced).toBe(true);
    expect(await getPeerToken(db, "bot-h", "user-h")).toBe("ctx-h1");
    expect((await getAccount(db, "bot-h"))?.syncBuf).toBe("BUF-H1");

    // 同 buf 空轮询：无消息、游标不动
    const r2 = await wechat.harvest("bot-h");
    expect(r2.outcome).toBe("ok");
    expect(r2.messages).toBe(0);
    expect(r2.cursorAdvanced).toBe(false);
  });

  test("errcode -14 → stale 回调（账号标记 paused 熔断）", async () => {
    await createAccount(db, {
      id: "bot-stale",
      tokenEnc: encryptString(masterKey, "tok-stale"),
      baseUrl: `http://127.0.0.1:${mock.port}`,
      ownerUserId: "user-stale",
      now: Date.now(),
    });
    const cfg: Config = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
    const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "salt", monitorMode: "cron" });
    mock.scenario.updates.push({ errcode: -14 });
    const r = await wechat.harvest("bot-stale");
    expect(r.outcome).toBe("stale");
    const acc = await getAccount(db, "bot-stale");
    expect(acc?.status).toBe("paused");
  });
});

describe("scheduled 节拍门控", () => {
  test("clampPollIntervalSec：非法回 null，区间钳位", () => {
    expect(clampPollIntervalSec("abc")).toBeNull();
    expect(clampPollIntervalSec(5)).toBe(POLL_INTERVAL_MIN_SEC);
    expect(clampPollIntervalSec(10 ** 9)).toBe(POLL_INTERVAL_MAX_SEC);
    expect(clampPollIntervalSec(120)).toBe(120);
  });

  test("shouldWake/markWoke：间隔内不唤醒，到期唤醒；settings 覆盖 env 默认", async () => {
    const cfg: Config = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
    const core: Core = { cfg, log, db, masterKey: Buffer.alloc(32), salt: "s", adminToken: "a", channels: createRegistry() };

    expect(await effectivePollIntervalSec(core)).toBe(POLL_INTERVAL_DEFAULT_SEC);
    await setSetting(db, "poll_interval_sec", "61");
    expect(await effectivePollIntervalSec(core)).toBe(61);

    await setSetting(db, "poll_last_wake_at", String(Date.now() - 10_000));
    expect(await shouldWake(core, Date.now())).toBe(false); // 61s 间隔内
    await markWoke(core, Date.now());
    expect(await shouldWake(core, Date.now())).toBe(false);
    const past = Date.now() - 120_000;
    await setSetting(db, "poll_last_wake_at", String(past));
    expect(await shouldWake(core, Date.now())).toBe(true);

    // do 模式允许更细粒度
    const doCfg = { ...cfg, ingestMode: "do" as const };
    const doCore: Core = { ...core, cfg: doCfg };
    await setSetting(db, "poll_interval_sec", "15");
    expect(await effectivePollIntervalSec(doCore)).toBe(DO_POLL_INTERVAL_MIN_SEC === 10 ? 15 : 10);
  });
});

describe("D1 令牌桶（bun:sqlite 替身）", () => {
  test("满桶扣减、耗尽拒绝、按回填速率恢复", async () => {
    const limiter = createD1RateLimiter(db, 3600, 2); // 回填 1/s
    expect(await limiter.take("sk1")).toBe(true);
    expect(await limiter.take("sk1")).toBe(true);
    expect(await limiter.take("sk1")).toBe(false);
    const wait = await limiter.retryAfterSec("sk1");
    expect(wait).toBeGreaterThanOrEqual(1);
    // 模拟 2s 后回填够 1 个 token（把桶的 last 时间戳前移）
    await db.run(sql`UPDATE rate_buckets SET last = last - 2000 WHERE key = 'sk1'`);
    expect(await limiter.take("sk1", Date.now())).toBe(true);
  });
});

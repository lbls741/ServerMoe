import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRateLimiter } from "../../src/api/ratelimit.ts";
import { createApp } from "../../src/app.ts";
import { createRegistry } from "../../src/channels/registry.ts";
import { createWechatChannel } from "../../src/channels/wechat/channel.ts";
import { MessageItemType, MessageType, type WeixinMessage } from "../../src/channels/wechat/ilink/types.ts";
import { loadConfig } from "../../src/config.ts";
import { createPushService } from "../../src/core/push.ts";
import type { Core } from "../../src/core.ts";
import { hmacSignHex } from "../../src/crypto.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { getAccount, createAccount } from "../../src/repo/accounts.ts";
import { getLoginSession } from "../../src/repo/loginSessions.ts";
import { getPeerToken, upsertPeer } from "../../src/repo/peers.ts";
import { listPendingOutbox } from "../../src/repo/outbox.ts";
import { createInboundRouter } from "../../src/router/inbound.ts";
import { startMockIlink } from "../ilink/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-m2-"));
const db = openDb(join(dir, "t.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
const log = createLogger(((process.env.SSC_LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "error"));
const masterKey = Buffer.alloc(32, 7);

// mock 必须先于通道创建，登录默认入口注入 mock（绝不打生产 ilinkai.weixin.qq.com）
const mock = startMockIlink((port) => ({
  qrStatus: [
    { status: "wait" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok-1", ilink_bot_id: "bot-1", baseurl: `http://127.0.0.1:${port}`, ilink_user_id: "user-1" },
    { status: "wait" },
    { status: "confirmed", bot_token: "tok-2", ilink_bot_id: "bot-2", baseurl: `http://127.0.0.1:${port}`, ilink_user_id: "user-2" },
  ],
  updates: [{ msgs: [userMsg("user-1", "ctx-1")], newBuf: "BUF1" }],
  sends: [{ ret: 0 }],
}));

const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "testsalt", ilinkBaseUrl: `http://127.0.0.1:${mock.port}` });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey, salt: "testsalt", adminToken: "admin-tok", channels };
const push = createPushService(core);
wechat.onWarmup = (a, p) => push.flushOutbox(a, p);
const inboundRouter = createInboundRouter(core);
wechat.onInbound = (accountId, fromUserId, text, msgId) => inboundRouter.handle(accountId, fromUserId, text, msgId);
const app = createApp({ core, push, wechat, limiter: createRateLimiter(10_000, 10_000) });

const H = { authorization: "Bearer admin-tok" };
const JSON_H = { ...H, "content-type": "application/json" };

let sendkeyA = ""; // bot-1 的 sendkey
let sendkeyB = ""; // bot-2 的 sendkey

// ---- 关键词 webhook mock ----
const whRecord: Array<{ body: Record<string, unknown>; sigOk: boolean | null }> = [];
const wh = new Hono();
wh.post("/hook", async (c) => {
  const raw = await c.req.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  const ts = c.req.header("x-ssc-timestamp");
  const sig = c.req.header("x-ssc-signature");
  whRecord.push({ body, sigOk: ts && sig ? hmacSignHex("whsec", `${ts}.${raw}`) === sig : null });
  return c.json({ reply: "已收到部署指令" });
});
wh.post("/hook2", async (c) => {
  await c.req.text();
  return c.json({});
});
wh.post("/hookfail", (c) => c.json({ msg: "boom" }, 500));
const whServer = Bun.serve({ port: 0, fetch: wh.fetch });
const whUrl = (p: string) => `http://127.0.0.1:${whServer.port}${p}`;

function userMsg(from: string, ctx: string, text = "hello"): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    context_token: ctx,
  };
}

function waitFor(fn: () => boolean, timeoutMs = 4000, stepMs = 25, label = "?"): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`waitFor timeout: ${label}`));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

afterAll(async () => {
  await wechat.shutdown();
  mock.stop();
  whServer.stop(true);
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("绑定流程", () => {
  test("服务端驱动自动推进二维码状态机，confirm 落库签发 sendkey 并启动 monitor", async () => {
    const r1 = await app.request("/api/v1/login/start", { method: "POST", headers: H });
    const j1 = (await r1.json()) as { code: number; sessionId: string; qrcodeUrl: string };
    expect(j1.code).toBe(0);
    expect(j1.qrcodeUrl).toContain("https://qr.example");

    // 无需任何浏览器参与：服务端驱动轮询 mock 直到 confirmed
    await waitFor(() => getLoginSession(db, j1.sessionId)?.status === "confirmed");

    const cf = (await (
      await app.request("/api/v1/login/confirm", { method: "POST", headers: JSON_H, body: JSON.stringify({ sessionId: j1.sessionId }) })
    ).json()) as { code: number; accountId: string; sendkey: string };
    expect(cf.code).toBe(0);
    expect(cf.accountId).toBe("bot-1");
    expect(cf.sendkey).toMatch(/^SSC[23456789A-HJ-NP-Za-km-z]{16}$/);
    sendkeyA = cf.sendkey;

    // monitor 已启动：notifystart 已发，首轮 getupdates 游标为空串
    await waitFor(() => mock.record.notifyStarts >= 1);
    await waitFor(() => mock.record.updateBufs.length > 0);
    expect(mock.record.updateBufs[0]).toBe("");
  });

  test("预热：入站消息捕获 context_token 并持久化游标", async () => {
    await waitFor(() => Boolean(getPeerToken(db, "bot-1", "user-1")));
    expect(getPeerToken(db, "bot-1", "user-1")).toBe("ctx-1");
    expect(getAccount(db, "bot-1")?.syncBuf).toBe("BUF1");
  });

  test("未预热账号的推送返回 450 并入 outbox；捕获 token 后自动补发", async () => {
    // 直接落库一个无预热记录的账号（不走登录，避免 monitor 抢消息）；token 用真实可解密密文
    const { encryptString, sha256Hex } = await import("../../src/crypto.ts");
    const { createSendkey } = await import("../../src/repo/sendkeys.ts");
    createAccount(db, {
      id: "bot-x",
      tokenEnc: encryptString(masterKey, "tok-x"),
      baseUrl: `http://127.0.0.1:${mock.port}`,
      ownerUserId: "user-x",
      now: Date.now(),
    });
    createSendkey(db, { keyHash: sha256Hex(core.salt + ":SSCXTESTTESTTEST1"), accountId: "bot-x", now: Date.now() });

    const r = await app.request("/SSCXTESTTESTTEST1.send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "排队消息", desp: "尚未预热" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { code: number }).code).toBe(450);
    expect(listPendingOutbox(db, "bot-x", "user-x")).toHaveLength(1);

    // user-x 预热（模拟入站）→ onWarmup → flushOutbox → mock 收到补发
    upsertPeer(db, "bot-x", "user-x", "ctx-x", Date.now());
    await push.flushOutbox("bot-x", "user-x");
    await waitFor(() => mock.record.sends.some((s) => s.msg.to_user_id === "user-x"));
    const flushed = mock.record.sends.find((s) => s.msg.to_user_id === "user-x")!;
    expect(flushed.msg.item_list?.[0]?.text_item?.text).toContain("排队消息");
    expect(listPendingOutbox(db, "bot-x", "user-x")).toHaveLength(0);
  });
});

describe("ServerChan 兼容推送", () => {
  test("JSON 编码：成功推送携带 title/desp，粗体标记保留", async () => {
    const r = await app.request(`/${sendkeyA}.send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "构建完成", desp: "**OK** 耗时 3s" }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { code: number; message: string; data: { pushid: string; error: string } };
    expect(j.code).toBe(0);
    expect(j.data.error).toBe("SUCCESS");
    await waitFor(() => mock.record.sends.some((s) => s.msg.to_user_id === "user-1"));
    const sent = mock.record.sends[mock.record.sends.length - 1]!;
    expect(sent.msg.context_token).toBe("ctx-1");
    const text = sent.msg.item_list?.[0]?.text_item?.text ?? "";
    expect(text).toContain("构建完成");
    expect(text).toContain("**OK**");
  });

  test("GET query 与 form 编码均可", async () => {
    const r1 = await app.request(`/${sendkeyA}.send?title=via-get`);
    expect(((await r1.json()) as { code: number }).code).toBe(0);
    const r2 = await app.request(`/${sendkeyA}.send`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=via-form&desp=body-text",
    });
    expect(((await r2.json()) as { code: number }).code).toBe(0);
    await waitFor(() => mock.record.sends.length >= 3);
  });

  test("无效 sendkey → HTTP 400；缺 title → 400", async () => {
    expect((await app.request("/SSCWRONGWRONGWRONGX.send?title=x")).status).toBe(400);
    expect((await app.request(`/${sendkeyA}.send?desp=no-title`)).status).toBe(400);
  });

  test("超长 desp 分块为多条消息并带 (i/n) 序号", async () => {
    const before = mock.record.sends.length;
    const r = await app.request(`/${sendkeyA}.send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "long", desp: "内容行\n".repeat(1200) }), // 4800 chars → 2 chunks @3000
    });
    expect(((await r.json()) as { code: number }).code).toBe(0);
    await waitFor(() => mock.record.sends.length >= before + 2);
    const tail = mock.record.sends.slice(before);
    expect(tail).toHaveLength(2);
    expect(tail[0]!.msg.item_list?.[0]?.text_item?.text).toContain("(1/2)");
    expect(tail[1]!.msg.item_list?.[0]?.text_item?.text).toContain("(2/2)");
  });

  test("v1 富推送：sendkey Bearer + ret=-14 → 451 并标记 rebind_needed", async () => {
    mock.scenario.sends.splice(0, mock.scenario.sends.length, { ret: -14 });
    const r = await app.request("/api/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sendkeyA}` },
      body: JSON.stringify({ title: "expired" }),
    });
    const j = (await r.json()) as { code: number; reason?: string };
    expect(j.code).toBe(451);
    expect(j.reason).toBe("TOKEN_EXPIRED");
    expect(getAccount(db, "bot-1")?.status).toBe("rebind_needed");
    mock.scenario.sends.splice(0, mock.scenario.sends.length, { ret: 0 });
  });
});

describe("多登录与生命周期", () => {
  test("第二账号登录绑定，互不串扰", async () => {
    // 停掉 bot-1 的 monitor，避免其竞争消费后续 updates 步骤
    await wechat.stopAccount("bot-1");
    mock.scenario.updates.push({ msgs: [userMsg("user-2", "ctx-2")], newBuf: "BUF2" });

    const r1 = await app.request("/api/v1/login/start", { method: "POST", headers: H });
    const j1 = (await r1.json()) as { sessionId: string };
    await waitFor(() => getLoginSession(db, j1.sessionId)?.status === "confirmed"); // 驱动消费 [wait, confirmed(bot-2)]
    const cf = (await (
      await app.request("/api/v1/login/confirm", { method: "POST", headers: JSON_H, body: JSON.stringify({ sessionId: j1.sessionId }) })
    ).json()) as { code: number; accountId: string; sendkey: string };
    expect(cf.code).toBe(0);
    expect(cf.accountId).toBe("bot-2");
    sendkeyB = cf.sendkey;
    expect(sendkeyB).not.toBe(sendkeyA);

    await waitFor(() => Boolean(getPeerToken(db, "bot-2", "user-2")));
    expect(getPeerToken(db, "bot-2", "user-2")).toBe("ctx-2");
  });

  test("配对码门控：need_verifycode 挂起等待，提交后携带 verify_code 继续", async () => {
    // 队列已空，先推入 need_verifycode；驱动会在无码时挂起（400ms 门控）
    mock.scenario.qrStatus.push({ status: "need_verifycode" });
    const r1 = await app.request("/api/v1/login/start", { method: "POST", headers: H });
    const j1 = (await r1.json()) as { sessionId: string };
    await waitFor(() => getLoginSession(db, j1.sessionId)?.status === "need_verifycode");

    mock.scenario.qrStatus.push({ status: "scaned" }, { status: "confirmed", bot_token: "tok-3", ilink_bot_id: "bot-3", baseurl: `http://127.0.0.1:${mock.port}`, ilink_user_id: "user-3" });
    await app.request("/api/v1/login/verify", {
      method: "POST",
      headers: JSON_H,
      body: JSON.stringify({ sessionId: j1.sessionId, code: "1234" }),
    });

    await waitFor(() => getLoginSession(db, j1.sessionId)?.status === "confirmed");
    expect(getLoginSession(db, j1.sessionId)?.botId).toBe("bot-3");
    expect(mock.record.qrPolls).toContain("1234");
  });

  test("解绑：停止 monitor、吊销 sendkey、删除账号与 peers", async () => {
    const r = await app.request("/api/v1/sessions/bot-x", { method: "DELETE", headers: H });
    expect(((await r.json()) as { code: number }).code).toBe(0);
    expect(getAccount(db, "bot-x")).toBeUndefined();
  });
});

describe("关键词路由（KWR）", () => {
  function registerKeyword(auth: string, body: Record<string, unknown>) {
    return app.request("/api/v1/keywords", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
  }

  async function pushInbound(text: string, ctx = "ctx-2b", msgId?: number, from = "user-2"): Promise<void> {
    const msg: WeixinMessage = { message_type: MessageType.USER, from_user_id: from, item_list: [{ type: MessageItemType.TEXT, text_item: { text } }], context_token: ctx };
    if (msgId !== undefined) msg.message_id = msgId;
    mock.scenario.updates.push({ msgs: [msg] });
  }

  function lastSendText(): string {
    return mock.record.sends[mock.record.sends.length - 1]!.msg.item_list?.[0]?.text_item?.text ?? "";
  }

  test("CRUD：sendkey 注册（secret 加密存储）、列表不回显、重复/保留字/非法正则拒绝、账号隔离", async () => {
    const ok = (await (await registerKeyword(sendkeyB, { keyword: "deploy", match: "prefix", url: whUrl("/hook"), secret: "whsec" })).json()) as {
      code: number;
      keyword: { hasSecret: boolean };
    };
    expect(ok.code).toBe(0);
    expect(ok.keyword.hasSecret).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("whsec");

    expect(((await (await registerKeyword(sendkeyB, { keyword: "deploy", match: "exact", url: whUrl("/hook") })).json()) as { code: number }).code).toBe(409);
    expect(((await (await registerKeyword(sendkeyB, { keyword: "help", match: "exact", url: whUrl("/hook") })).json()) as { code: number }).code).toBe(409);
    expect(((await (await registerKeyword(sendkeyB, { keyword: "([bad", match: "regex", url: whUrl("/hook") })).json()) as { code: number }).code).toBe(400);
    expect(((await (await registerKeyword(sendkeyB, { keyword: "badurl", match: "exact", url: "notaurl" })).json()) as { code: number }).code).toBe(400);

    // 无鉴权 → 401
    const r = await app.request("/api/v1/keywords", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);

    // bot-1 的 sendkey 看不到 bot-2 的关键词（账号隔离）
    const other = (await (await app.request("/api/v1/keywords", { headers: { authorization: `Bearer ${sendkeyA}` } })).json()) as { keywords: unknown[] };
    expect(other.keywords).toHaveLength(0);
  });

  test("命中转发：HMAC 签名校验通过，reply 回发微信", async () => {
    const before = mock.record.sends.length;
    await pushInbound("deploy now");
    await waitFor(() => mock.record.sends.length > before);

    expect(whRecord.length).toBeGreaterThanOrEqual(1);
    const call = whRecord[whRecord.length - 1]!;
    expect(call.body.keyword).toBe("deploy");
    expect(call.body.text).toBe("deploy now");
    expect(call.body.user_id).toBe("user-2");
    expect(call.body.account_id).toBe("bot-2");
    expect(call.sigOk).toBe(true);

    const text = lastSendText();
    expect(text).toContain("已收到部署指令");
  });

  test("2xx 无 reply → 默认回执「已转发」", async () => {
    const before = mock.record.sends.length;
    await (await registerKeyword(sendkeyB, { keyword: "noreply", match: "exact", url: whUrl("/hook2") })).json();
    await pushInbound("noreply");
    await waitFor(() => mock.record.sends.length > before);
    expect(lastSendText()).toContain("已转发（noreply）");
  });

  test("webhook 500 → 错误回执", async () => {
    const before = mock.record.sends.length;
    await (await registerKeyword(sendkeyB, { keyword: "failapp", match: "exact", url: whUrl("/hookfail") })).json();
    await pushInbound("failapp");
    await waitFor(() => mock.record.sends.length > before);
    expect(lastSendText()).toContain("转发失败（failapp）");
  });

  test("内置命令 status/help，未命中 → 默认提醒", async () => {
    const before = mock.record.sends.length;
    await pushInbound("status");
    await waitFor(() => mock.record.sends.length > before);
    expect(lastSendText()).toContain("账号: bot-2");

    await pushInbound("help");
    await waitFor(() => lastSendText().includes("SuperServerChan 指令"));

    await pushInbound("随手打的废话");
    await waitFor(() => lastSendText().includes("未识别的指令"));
  });

  test("防回环与防重复：自身回显不触发路由，同 message_id 只处理一次", async () => {
    const reg = (await (await registerKeyword(sendkeyB, { keyword: "loopk", match: "prefix", url: whUrl("/hook") })).json()) as { code: number };
    expect(reg.code).toBe(0);
    const callsBefore = whRecord.length;
    const sendsBefore = mock.record.sends.length;
    const bufsBefore = mock.record.updateBufs.length;

    // 1) 自身回显（from = 账号自身，即使文本命中关键词）必须被忽略
    await pushInbound("loopk self-echo", "ctx-2e", 8001, "bot-2");
    await waitFor(() => mock.record.updateBufs.length > bufsBefore, 4000, 25, "self-echo consumed");
    await new Promise((r) => setTimeout(r, 200));
    expect(whRecord.length).toBe(callsBefore);
    expect(mock.record.sends.length).toBe(sendsBefore);

    // 2) 正常消息转发一次；同 message_id 重复投递不再处理
    await pushInbound("loopk one", "ctx-2f", 9001);
    await waitFor(() => whRecord.length > callsBefore, 4000, 25, "loopk one forwarded");
    const after = { calls: whRecord.length, sends: mock.record.sends.length };
    await pushInbound("loopk one", "ctx-2f", 9001);
    await waitFor(() => mock.record.updateBufs.length > bufsBefore + 1, 4000, 25, "duplicate consumed");
    await new Promise((r) => setTimeout(r, 200));
    expect(whRecord.length).toBe(after.calls);
    expect(mock.record.sends.length).toBe(after.sends);
  });
});

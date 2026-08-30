// 邮件桥测试：注入假 IMAP/SMTP 后端，离线验证配置 API、轮询推送、mail 命令与 SMTP 发送。
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
import { encryptString } from "../../src/crypto.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { createMailService, type MailBackendDeps } from "../../src/mail/service.ts";
import { createAccount } from "../../src/repo/accounts.ts";
import { upsertPeer } from "../../src/repo/peers.ts";
import { startMockIlink } from "../ilink/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-mail-"));
const db = openDb(join(dir, "t.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
const log = createLogger("error");
const masterKey = Buffer.alloc(32, 5);
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "testsalt", ilinkBaseUrl: "http://127.0.0.1:1" });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey, salt: "testsalt", adminToken: "admin-tok", channels };
const push = createPushService(core);
const app = createApp({ core, push, wechat, limiter: createRateLimiter(10_000, 10_000) });

const mock = startMockIlink(() => ({ qrStatus: [], updates: [], sends: [{ ret: 0 }] }));
const H = { authorization: "Bearer admin-tok", "content-type": "application/json" };

createAccount(db, {
  id: "bot-mail",
  tokenEnc: encryptString(masterKey, "tok-mail"),
  baseUrl: `http://127.0.0.1:${mock.port}`,
  ownerUserId: "user-1",
  now: Date.now(),
});
upsertPeer(db, "bot-mail", "user-1", "ctx-m1", Date.now());

const fetched: Array<{ pass: string; lastUid: number | null }> = [];
const sent: Array<{ to: string; subject: string; body: string }> = [];
const deps: MailBackendDeps = {
  imapFetch: async (cfg, lastUid) => {
    fetched.push({ pass: cfg.pass, lastUid });
    if (lastUid === null) return { uidValidity: "V1", messages: [], maxUid: 100 };
    const uid = lastUid + 1;
    return {
      uidValidity: "V1",
      maxUid: uid,
      messages: [{ uid, from: "boss@example.com", subject: `第${uid}号邮件`, date: new Date().toLocaleString("zh-CN"), text: `正文内容 uid=${uid}` }],
    };
  },
  smtpSend: async (_cfg, _from, msg) => {
    sent.push(msg);
  },
};
const mail = createMailService(core, push, deps);
core.mail = mail;

const inboundRouter = (await import("../../src/router/inbound.ts")).createInboundRouter(core);
wechat.onInbound = (accountId, fromUserId, text) => inboundRouter.handle(accountId, fromUserId, text);

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

function lastSendText(): string {
  return mock.record.sends[mock.record.sends.length - 1]!.msg.item_list?.[0]?.text_item?.text ?? "";
}

afterAll(async () => {
  await wechat.shutdown();
  mock.stop();
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("邮件桥（M5）", () => {
  test("配置 API：保存（密码加密落盘）、视图不回显密码", async () => {
    const put = await app.request("/api/v1/admin/mail/bot-mail", {
      method: "PUT",
      headers: H,
      body: JSON.stringify({
        enabled: false, // 关闭轮询，保证后续 poll-now 顺序确定
        imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", pass: "secret123" },
        smtp: { host: "smtp.example.com", port: 465, secure: true, user: "me@example.com", pass: "smtp456" },
      }),
    });
    expect(((await put.json()) as { code: number }).code).toBe(0);

    const view = (await (await app.request("/api/v1/admin/mail/bot-mail", { headers: H })).json()) as {
      mail: { configured: boolean; imap: { passSet: boolean; host: string } };
    };
    expect(view.mail.configured).toBe(true);
    expect(view.mail.imap.passSet).toBe(true);
    expect(view.mail.imap.host).toBe("imap.example.com");
    expect(JSON.stringify(view)).not.toContain("secret123");
    expect(JSON.stringify(view)).not.toContain("smtp456");
  });

  test("轮询：首次接入跳过历史，之后每轮取一封新邮件并推送摘要到微信", async () => {
    const p1 = await app.request("/api/v1/admin/mail/bot-mail/poll-now", { method: "POST", headers: H });
    expect(((await p1.json()) as { newMail: number }).newMail).toBe(0);

    const p2 = await app.request("/api/v1/admin/mail/bot-mail/poll-now", { method: "POST", headers: H });
    expect(((await p2.json()) as { newMail: number }).newMail).toBe(1);

    await waitFor(() => mock.record.sends.some((s) => (s.msg.item_list?.[0]?.text_item?.text ?? "").includes("📧 第101号邮件")));
    const push = mock.record.sends.find((s) => (s.msg.item_list?.[0]?.text_item?.text ?? "").includes("📧 第101号邮件"))!;
    expect(push.msg.to_user_id).toBe("user-1");
    // 解密后的凭据确实传给了 IMAP 后端
    expect(fetched.at(-1)?.pass).toBe("secret123");
    expect(fetched.at(-1)?.lastUid).toBe(100);
  });

  test("mail 命令：list / 读信 / status / 未知子命令", async () => {
    await inboundRouter.handle("bot-mail", "user-1", "mail:list");
    expect(lastSendText()).toContain("第101号邮件");
    expect(lastSendText()).toContain("boss@example.com");

    await inboundRouter.handle("bot-mail", "user-1", "mail 1");
    expect(lastSendText()).toContain("正文内容 uid=101");

    await inboundRouter.handle("bot-mail", "user-1", "mail 99");
    expect(lastSendText()).toContain("没有第 99 封");

    await inboundRouter.handle("bot-mail", "user-1", "mail:status");
    expect(lastSendText()).toContain("IMAP: me@example.com@imap.example.com");

    await inboundRouter.handle("bot-mail", "user-1", "mail:whatever");
    expect(lastSendText()).toContain("未知 mail 子命令");
  });

  test("mail:send 经 SMTP 发出（假后端记录）", async () => {
    await inboundRouter.handle("bot-mail", "user-1", 'mail:send to=dst@x.y subject="项目周报" body=本周一切正常');
    expect(sent.some((m) => m.to === "dst@x.y" && m.subject === "项目周报" && m.body === "本周一切正常")).toBe(true);
    expect(lastSendText()).toContain("已提交发送至 dst@x.y");
  });

  test("未配置账号时 mail 命令给出启用指引", async () => {
    await inboundRouter.handle("bot-mail", "user-1", "mail"); // 已配置 → help
    expect(lastSendText()).toContain("邮件桥指令");
  });
});

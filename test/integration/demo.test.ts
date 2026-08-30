// examples/keyword-receiver/demo.js 的端到端冒烟：真实 spawn `node demo.js`，
// 对着种子网关完成注册，并模拟网关转发（HMAC 正/反例）验证 demo 的接收与验签行为。
import { spawn, type ChildProcess } from "node:child_process";
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
import { encryptString, hmacSignHex, sha256Hex } from "../../src/crypto.ts";
import { closeDb, openDb } from "../../src/db/index.ts";
import { createLogger } from "../../src/log.ts";
import { createAccount } from "../../src/repo/accounts.ts";
import { listKeywords } from "../../src/repo/keywords.ts";
import { createSendkey } from "../../src/repo/sendkeys.ts";

const dir = mkdtempSync(join(tmpdir(), "ssc-demo-"));
const db = openDb(join(dir, "t.db"));
const cfg = { ...loadConfig({}), dataDir: dir, dbPath: join(dir, "t.db") };
const log = createLogger("error");
const masterKey = Buffer.alloc(32, 9);
const channels = createRegistry();
const wechat = createWechatChannel({ cfg, log, db, masterKey, salt: "testsalt" });
channels.register(wechat);
const core: Core = { cfg, log, db, masterKey, salt: "testsalt", adminToken: "admin-tok", channels };
const app = createApp({ core, push: createPushService(core), wechat, limiter: createRateLimiter(10_000, 10_000) });
const server = Bun.serve({ port: 0, fetch: app.fetch });
const GATEWAY = `http://127.0.0.1:${server.port}`;

const DEMO_KEY = "SSCDEMO0000000001";
const DEMO_SECRET = "demosec";
const DEMO_JS = join(import.meta.dir, "..", "..", "examples", "keyword-receiver", "demo.js");

createAccount(db, {
  id: "bot-demo",
  tokenEnc: encryptString(masterKey, "tok-demo"),
  baseUrl: "http://127.0.0.1:1", // 不会被实际调用（无 monitor、无 peer → 推送走 450 排队路径）
  ownerUserId: "user-1",
  now: Date.now(),
});
createSendkey(db, { keyHash: sha256Hex(core.salt + ":" + DEMO_KEY), accountId: "bot-demo", now: Date.now() });

const children = new Set<ChildProcess>();
let out = "";

function runDemo(): ChildProcess {
  out = "";
  const child = spawn("node", [DEMO_JS], {
    env: { ...process.env, GATEWAY, SENDKEY: DEMO_KEY, KEYWORD: "demo", PORT: "0", WEBHOOK_SECRET: DEMO_SECRET },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
  return child;
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  return exitOf(child);
}

function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function keywordRow() {
  return listKeywords(db, "bot-demo")[0];
}

afterAll(async () => {
  for (const c of children) c.kill();
  server.stop(true);
  closeDb(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("关键词接收 demo（examples/keyword-receiver）", () => {
  test("注册 → HMAC 有效转发被接收并回复，伪造签名被 401 拒绝", async () => {
    const child = runDemo();
    try {
      await waitFor(() => Boolean(keywordRow()));
      const row = keywordRow()!;
      expect(row.keyword).toBe("demo");
      expect(row.matchMode).toBe("prefix");
      const hookUrl = new URL(row.url);

      // 模拟网关转发：正确 HMAC 签名 → demo 打印并回复
      const body = JSON.stringify({ user_id: "user-1", account_id: "bot-demo", keyword: "demo", text: "demo hello", ts: Date.now(), msg_id: "m1" });
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(hookUrl.origin + "/hook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ssc-timestamp": String(ts), "x-ssc-signature": hmacSignHex(DEMO_SECRET, `${ts}.${body}`) },
        body,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { reply: string }).reply).toContain("demo hello");

      // 伪造签名 → 401
      const bad = await fetch(hookUrl.origin + "/hook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ssc-timestamp": String(ts), "x-ssc-signature": "deadbeef" },
        body,
      });
      expect(bad.status).toBe(401);

      await waitFor(() => out.includes("收到微信消息") && out.includes("有效 ✓"));
      expect(out).toContain("已注册");
      // 种子账号无预热记录 → 推送走 450 排队路径，demo 应给出提示而非崩溃（与转发存在竞态，等待式断言）
      await waitFor(() => out.includes("测试推送已排队"));
    } finally {
      await kill(child);
    }
  });

  test("重复运行幂等：删除旧定义并按当前参数重注册", async () => {
    const child = runDemo();
    try {
      await waitFor(() => out.includes("删除旧定义后重新注册"));
      await waitFor(() => out.includes("已注册"));
      await waitFor(() => listKeywords(db, "bot-demo").length === 1);
      expect(keywordRow()!.keyword).toBe("demo");
    } finally {
      await kill(child);
    }
  });

  test("GATEWAY 忘写协议自动补全：'127.0.0.1:<port>' 仍可完成注册", async () => {
    const child = spawn("node", [DEMO_JS], {
      env: { ...process.env, GATEWAY: GATEWAY.replace(/^https?:\/\//, ""), SENDKEY: DEMO_KEY, KEYWORD: "demo", PORT: "0", WEBHOOK_SECRET: DEMO_SECRET },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    let buf = "";
    child.stdout?.on("data", (c: Buffer) => (buf += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (buf += c.toString()));
    try {
      await waitFor(() => buf.includes("未带协议"));
      await waitFor(() => listKeywords(db, "bot-demo").length === 1);
      await waitFor(() => buf.includes("已注册"));
      expect(buf).not.toContain("unknown scheme");
    } finally {
      await kill(child);
    }
  });
});

#!/usr/bin/env node
/**
 * ServerMoe「关键词 → Webhook」接收 Demo（零依赖，Node.js >= 18）
 *
 * 这个 demo 演示双向消息的「接收端」完整闭环：
 *   1. 启动一个极简 HTTP 服务作为你的应用 webhook
 *   2. 调用网关 API，把关键词注册到自己的回调地址
 *   3. 微信里发送命中关键词的消息 → 网关转发到这里 → 打印在终端
 *   4. 回复 {"reply": "..."} → 这句话立刻出现在微信聊天里
 *   5. 顺带演示 ServerChan 兼容推送（/{sendkey}.send）
 *
 * 用法：
 *   GATEWAY=http://localhost:8080 \
 *   SENDKEY=MOExxxxxxxxxxxxxxxx \
 *   KEYWORD=demo \
 *   WEBHOOK_SECRET=my-secret \
 *   node demo.js
 *
 * 环境变量：
 *   GATEWAY        网关地址（默认 http://localhost:8080）
 *   SENDKEY        你的推送凭证（必填，网关绑定完成后在管理页获取）
 *   KEYWORD        要注册的关键词（默认 demo，match=prefix）
 *   WEBHOOK_SECRET 可选。设置后演示 HMAC 验签：网关的转发请求都会带签名头
 *   PORT           本地监听端口（默认 3000，传 0 则自动分配）
 *   WEBHOOK_URL    显式指定回调地址；默认 http://127.0.0.1:<PORT>/hook
 *                  注意：该地址必须是「网关」能访问到的地址——
 *                  网关跑在 Docker 里时请改成 http://host.docker.internal:<PORT>/hook
 */
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

/** 宽容化 base URL：忘写 http:// 时自动补全；非法地址给出明确报错。 */
function normalizeBaseUrl(raw, label) {
  let v = (raw || "").trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) {
    const fixed = "http://" + v;
    console.log(`ℹ️  ${label} 未带协议，按 ${fixed} 处理`);
    v = fixed;
  }
  if (v) {
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unknown scheme");
    } catch {
      console.error(`${label} 不是合法的 http(s) 地址: "${raw}"。应形如 http://localhost:8080`);
      process.exit(1);
    }
  }
  return v;
}

const GATEWAY = normalizeBaseUrl(process.env.GATEWAY || "http://localhost:8080", "GATEWAY");
const SENDKEY = (process.env.SENDKEY || "").trim();
const KEYWORD = (process.env.KEYWORD || "demo").trim();
const PORT = Number(process.env.PORT || 3000);
const SECRET = (process.env.WEBHOOK_SECRET || "").trim();

if (!SENDKEY) {
  console.error("缺少 SENDKEY 环境变量。用法示例：");
  console.error("  SENDKEY=MOExxxx KEYWORD=demo node demo.js");
  process.exit(1);
}
if (typeof fetch !== "function") {
  console.error("需要 Node.js >= 18（内置 fetch）。当前版本:", process.version);
  process.exit(1);
}

/** 校验网关转发请求的 HMAC-SHA256 签名（X-MOE-Timestamp + X-MOE-Signature）。 */
function verifySignature(raw, ts, sig) {
  if (!SECRET) return null; // 未配置 secret：跳过验签
  if (!ts || !sig) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<meta charset="utf-8"><title>SSC keyword demo</title>` +
        `<h1>关键词接收 demo 运行中</h1><p>已接收 ${received.length} 条</p>` +
        `<pre>${received.map((b) => JSON.stringify(b, null, 2)).join("\n\n")}</pre>`,
    );
    return;
  }
  if (req.method !== "POST" || req.url !== "/hook") {
    res.writeHead(404);
    res.end();
    return;
  }

  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1_000_000) req.destroy(); // 防御：超过 1MB 直接断开
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    const sigOk = verifySignature(raw, req.headers["x-moe-timestamp"], req.headers["x-moe-signature"]);
    if (sigOk === false) {
      // 验签失败：生产应用应直接拒绝，防止伪造请求
      console.error("⚠️  签名校验失败，已拒绝该请求（secret 不一致或非网关来源）");
      res.writeHead(401);
      res.end("invalid signature");
      return;
    }

    received.push(body);
    console.log("\n── 收到微信消息 ───────────────────────");
    console.log("时间  :", new Date().toLocaleString("zh-CN"));
    console.log("来自  :", body.user_id, "@ 账号", body.account_id);
    console.log("关键词:", body.keyword);
    console.log("内容  :", body.text);
    console.log("验签  :", sigOk === null ? "跳过（未配置 WEBHOOK_SECRET）" : "有效 ✓");
    console.log("───────────────────────────────────────");

    // 返回 {"reply": ...} → 这段文字会立刻出现在微信聊天里。
    // 注意：回复文本刻意不以关键词开头——若回复以关键词开头，会被网关再次命中造成消息循环。
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply: `✅ 已收到：「${String(body.text).slice(0, 60)}」` }));
  });
});

/** 带友好错误提示的 fetch：网关不可达时给出人话，而不是 undici 原始堆栈。 */
async function safeFetch(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (err) {
    console.error(`\n无法访问 ${url}`);
    console.error("请确认：1) 网关已启动；2) GATEWAY 地址正确（形如 http://localhost:8080）；3) 从本机可达。");
    console.error("原始错误:", err && err.cause ? String(err.cause) : String(err));
    process.exit(1);
  }
}

/** 带鉴权的网关 API 调用（sendkey 即身份）。 */
async function api(path, options = {}) {
  const res = await safeFetch(GATEWAY + path, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${SENDKEY}`, ...(options.headers || {}) },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

/** 注册关键词；若已存在则删除旧定义后按当前参数重注册（保证回调地址始终最新）。 */
async function registerKeyword(webhookUrl) {
  const payload = { keyword: KEYWORD, match: "prefix", url: webhookUrl, ...(SECRET ? { secret: SECRET } : {}) };
  let r = await api("/api/v1/keywords", { method: "POST", body: JSON.stringify(payload) });
  if (r.status === 409) {
    console.log("关键词已存在，删除旧定义后重新注册…");
    const list = await api("/api/v1/keywords");
    const old = ((list.json && list.json.keywords) || []).find((k) => k.keyword === KEYWORD);
    if (old) await api(`/api/v1/keywords/${old.id}`, { method: "DELETE" });
    r = await api("/api/v1/keywords", { method: "POST", body: JSON.stringify(payload) });
  }
  if (!r.json || r.json.code !== 0) {
    console.error("关键词注册失败:", r.status, JSON.stringify(r.json));
    process.exit(1);
  }
  console.log(`✓ 关键词「${KEYWORD}」已注册 → ${webhookUrl}`);
}

/** 顺带演示 ServerChan 兼容推送：一行 URL 即可发消息到微信。 */
async function pushHello() {
  const res = await safeFetch(`${GATEWAY}/${SENDKEY}.send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "关键词接收 demo 已启动",
      desp: `在微信里发送 **${KEYWORD} 你好** 试试双向消息。\n本条消息由 \`/{sendkey}.send\` 推送。`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.code === 0) console.log("✓ 已通过 /{sendkey}.send 向微信推送一条测试消息");
  else if (j.code === 450) console.log("… 测试推送已排队：请先在微信里给 ClawBot 发任意一条消息完成预热，之后会自动补发");
  else console.log(`… 测试推送未送达 (code=${j.code} ${j.message || ""})`);
}

server.listen(PORT, () => {
  const actualPort = server.address().port;
  const webhookUrl = normalizeBaseUrl(process.env.WEBHOOK_URL || "", "WEBHOOK_URL") || `http://127.0.0.1:${actualPort}/hook`;
  console.log(`关键词接收 demo 已启动: http://127.0.0.1:${actualPort}/`);
  registerKeyword(webhookUrl)
    .then(pushHello)
    .then(() => {
      console.log(`现在在微信里发送「${KEYWORD} 你好」，消息将打印在本终端。Ctrl+C 退出（关键词保留，重跑本 demo 会自动更新注册）。`);
    })
    .catch((err) => {
      console.error("启动失败:", err);
      process.exit(1);
    });
});

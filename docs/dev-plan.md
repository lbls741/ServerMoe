# SuperServerChan 详细开发规划（v2，技术栈复核版）

> 2026-08-29 批准。依据：AGENT.md（宪法）、docs/recon.md（M0 侦察）、easychen/serverchan-sdk 官方 SDK 契约审计。
> Route B 已裁决：自研 iLink Bot HTTP 客户端（规范=官方插件 MIT 源码 + recon.md §2 协议规格）。
> 技术栈经复核修订：Route B 后「必须 Node」的理由已消失，采用激进但可回退的 Bun 栈。

## 1. 总体架构与多后端接缝

```
HTTP API ─┬─ ServerChan 兼容层 /{sendkey}.send
          └─ /api/v1/*（自有 API）
               │
        网关核心：sendkey 解析 → 通道注册表 registry ──► Channel 接口（多后端扩展点，当前仅 wechat）
               │                                        └─ channels/wechat/（iLink 客户端）
        关键词路由 ←── 入站事件（channel 无关的统一消息形状）
        Web UI / 邮件桥(M5) / SQLite
```

- `Channel` 接口：`bindStart/bindPoll/bindVerify/bindWait`（绑定状态机）、`startAccount/stopAccount`、
  `send(accountId, peer, text)`、`listAccounts()`。统一 `SendResult = {ok} | {reason: WARMUP_REQUIRED | TOKEN_EXPIRED | ...}`，
  让上层与微信细节解耦。未来钉钉/飞书 = 新增 channels/<name> + registry 注册，ServerChan 兼容层不动
  （对齐 Server酱 官方「sendkey 前缀路由后端」的设计）。
- 入站统一形状：`{channelId, accountId, fromUserId, text, ts, messageId}` → 关键词路由。
- **运行时隔离纪律**（为 M8 铺路）：fs/process/sqlite 只允许出现在 db/storage 模块；
  channels/api/router/web 全部平台中立（Web 标准接口）。Hono 的多运行时能力由此兑现。
- **单消费者约束**（recon §11-4）：每个 bot_token 只允许一个 getUpdates 长轮询消费者 →
  单实例多任务进程模型，禁止双实例同账号（serverless 须外置租约，M8 议题）。

## 2. 技术栈（复核后定稿）与依赖取舍

| 用途 | 选型 | 被舍弃项及理由 |
|---|---|---|
| 运行时/包管理/测试 | **Bun 1.3.x**（当前 1.3.10，原生支持 Windows/macOS/linux-musl/gnu） | Node 24 LTS：Bun 独有收益 = `bun:sqlite` 消灭唯一原生依赖（better-sqlite3 的跨平台编译摩擦）、`bun build --compile` 单二进制、TS/TSX 原生执行（UI 零构建链）。 |
| HTTP 框架 | **Hono 4.12**（零依赖 <12KB；内置 validator、bearer/cookie 鉴权、secure-headers、JSX SSR、CSS helper） | Fastify（绑定 Node，换运行时=重写 HTTP 层）；Elysia（锁 Bun、生态小）；Express（过时）。Hono 同代码可跑 Bun/Node/Lambda/Workers → **M8 从重做变加适配器**。 |
| 数据库 | **bun:sqlite（WAL）+ Drizzle ORM 0.45 + drizzle-kit** | Prisma（codegen+engine 重）；Kysely（仅查询构建）；手写 SQL（AI 迭代时类型护栏弱）。Drizzle 驱动可换：回退 Node 换 better-sqlite3，serverless 换 D1/libsql。 |
| 校验 | zod 4 | valibot/arktype/TypeBox：生态与 Hono validator 集成 zod 最成熟。 |
| 日志 | 内置精简 JSON logger（~40 行，接口留 pino 兼容形） | pino（Bun 上 worker_threads 有历史坑；本项目日志非核心负载）。 |
| 二维码 | qrcode（服务端 SVG） | 无争议。 |
| UI 交互/样式 | hono/jsx 类型安全 SSR + hono/css + 少量手写 CSS + 原生 fetch JS | Tailwind/htmx（引入构建链，违背零构建原则；仅 5 个页面）。 |
| 邮件桥(M5) | imapflow + mailparser + nodemailer | 纯 JS、事实标准、Bun 兼容。 |
| 测试 | bun:test（jest 风格 API） | vitest（回退 Node 时迁回，成本低）。 |

**回退保障**：Hono 有 @hono/node-server、Drizzle 换 better-sqlite3 驱动、bun:test→vitest——
整栈回退 Node 24 LTS ≈ 1 天。激进风险被锁定。

## 3. 仓库布局

```
src/
  index.ts  config.ts  log.ts  crypto.ts
  db/ (drizzle schema + drizzle-kit 迁移)  repo/ (accounts/peers/sendkeys/keywords/push_log/inbound_log/outbox/login_sessions/settings)
  channels/ types.ts(接口) registry.ts
  channels/wechat/ ilink/{client,types,errors,constants}.ts  login.ts  monitor.ts  sender.ts  markdown.ts  chunk.ts  channel.ts
  api/ serverchan.ts  v1.ts  auth.ts  ratelimit.ts
  router/ inbound.ts  matcher.ts  forwarder.ts  builtins.ts
  web/ pages/ render.ts
  mail/ (M5 占位)
test/ unit/  ilink/mock-server.ts(Hono 编排场景)  integration/  contract/
docker/ (Dockerfile 多阶段 oven/bun + 可选 --compile + compose + entrypoint)
docs/ dev-plan.md  recon.md  runbook.md
```

## 4. 数据模型（SQLite v1）

- `accounts`: ilink_bot_id PK, label, **token_enc**(AES-256-GCM), base_url, owner_user_id,
  status(active|paused|rebind_needed), last_inbound_at, last_error, sync_buf（游标随行存）
- `peers`: (account_id, user_id) PK, context_token, updated_at ——「每用户最新一条、覆盖写、无 TTL」，
  失效靠发送 ret=-2 被动发现（官方/社区一致语义）
- `sendkeys`: key_hash UNIQUE(sha256(salt+key)), account_id, label, revoked_at —— 1 账号 1 活跃 key，形如 `SSC`+16 位
- `keywords`: (account_id, keyword) UNIQUE, match_mode(exact|prefix|contains|regex), url, secret_enc, enabled
- `push_log` / `inbound_log`：审计排障，默认保留 30 天（GC 定时任务）
- `outbox`: 预热队列 —— WARMUP_REQUIRED 的推送入队，该 peer 新 token 捕获时自动重发（≤5 次、24h 过期），
  借鉴 weclaw 自愈设计
- `login_sessions`: 绑定向导状态（qrcode、状态、verify_code、confirmed 凭据暂存）

## 5. iLink 客户端要点（全部已验证的协议事实）

- 请求头：`AuthorizationType: ilink_bot_token` + `Bearer <bot_token>` + `iLink-App-Id: bot` +
  `iLink-App-ClientVersion`（自报版本编码）+ 随机 `X-WECHAT-UIN`；
  body 带 `base_info.bot_agent = "SuperServerChan/<ver>"`（可配置，仅观测不鉴权）。
- 绑定：`get_bot_qrcode?bot_type=3`（带 local_token_list 防重复绑定）→ 长轮询 `get_qrcode_status`
  状态机（wait/scaned/need_verifycode 数字配对码/verify_code_blocked/expired 自动刷新≤3/
  scaned_but_redirect IDC 迁移/binded_redirect/confirmed）。confirmed 得 token+ilink_bot_id+baseurl+
  扫码者 user_id。二维码 TTL≈5min，登录总超时 480s。
- 收信：每账号一个 monitor 任务长轮询 `getupdates`（35s，采纳服务端 longpolling_timeout_ms），
  游标整串回传、DB 持久化（重启免重扫）；错误退避 3×2s→30s；
  **errcode=-14 → 熔断暂停 1h + 账号标记 rebind_needed**（不疯狂重登）。
- 发送：`sendmessage`，wire 仅纯文本 `text_item`；`context_token` 缺失→直接返回 WARMUP_REQUIRED
  （不浪费请求）；ret=-2→token 失效处理+入 outbox。`client_id` 本地生成（服务端不回 id），幂等依据。
- 文本处理：**分块**默认 3000 字符（可配 1800–4000），按行边界切分 + `(i/n)` 后缀；
  **markdown 过滤**移植官方规则——保留 `**粗体**`/行内代码/围栏/表格/水平线，剥离 CJK 斜体标记与
  H5/H6，`![](url)` 图片改为 `🔗 alt: url` 文本行（对官方行为的有意偏离：官方直接丢弃，
  会丢 ServerChan desp 的图片信息）。
- 优雅停机：notifystop + 游标落盘 + 关库；长轮询退出用 AbortSignal（停账号/热重载立即生效）。

## 6. HTTP API

**ServerChan 兼容层**（挂在根路径，四编码：query/form-urlencoded/JSON/plain text）：
- `GET|POST /{sendkey}.send`，参数 `title`（必填）、`desp`（markdown）、`short`（作为首行摘要拼入）、
  `tags/channel/openid/noip`（接受、记录、MVP 忽略——wechat 通道无对应概念，留扩展）。
- 响应：成功 `{"code":0,"message":"","data":{"pushid":"<本地id>","error":"SUCCESS"}}`；
  无效 key → HTTP 400 `{"code":400,"message":"bad sendkey"}`；限频 → HTTP 429 + Retry-After；
  未预热 → HTTP 200 `{"code":450,"message":"请先在微信中给 bot 发送任意一条消息以激活推送"}`。
  SDK 兼容面 = `{code,message,data?}` 三字段（官方 SDK 类型仅承诺这些）。
- 迁移方式（README 明示）：把脚本/自建应用里的 `https://sctapi.ftqq.com` 换成网关地址即可。
  官方 serverchan-sdk npm 包硬编码域名为已知限制，可选后续给其提 BASE_URL 支持（不承诺）。

**自有 `/api/v1/*`**（Bearer admin_token 或 sendkey）：`POST /send`（富错误）、keywords CRUD、
`login/start|poll|verify`（返回 SVG 二维码）、sessions 列表/解绑/重置 key、admin overview、
`GET /healthz|/statusz`（各账号 monitor 活性、游标年龄、outbox 数、预热状态）。

## 7. 关键词路由

匹配优先级 exact > prefix > contains > regex（同级按创建序），按账号隔离；保留字 help/status/bind 归内置。
命中 → `POST url` JSON `{user_id, account_id, keyword, text, ts, msg_id}` + `X-SSC-Timestamp` +
`X-SSC-Signature`(HMAC-SHA256(secret, `ts.rawBody`)，防重放 5min)；5s 超时，2xx 含 `{"reply"}` 则回发微信，
否则默认回执「已转发」；未命中 → 可配置提醒（默认指向 help）。

## 8. Web UI（服务端渲染，无构建链）

页面：`/login`（admin token 登录，HttpOnly Cookie）、`/`（仪表盘：账号状态/预热状态/游标年龄/最近推送）、
`/bind`（绑定向导：SVG 二维码→状态轮询→配对码输入→完成）、`/keywords`（CRUD）、`/settings`、`/logs`。
新增绑定必须 admin 授权（R4 席位控制）。

## 9. 安全与运维

落盘加密：token/secret 用 AES-256-GCM，密钥 = scrypt(SSC_SECRET || salt)；SSC_SECRET 未设则首启生成
`data/secret.key`(0600) 并告警。sendkey 只存哈希、创建时展示一次。日志脱敏。
限频：每 sendkey 令牌桶（默认 60/h、burst 10）+ 每账号 30/min 全局上限。
Docker：node:22-alpine 多阶段构建（→ v2 修订：多阶段 oven/bun:1.3，可选 `bun build --compile`
产单二进制进 distroless），卷 `/data`，healthcheck 打 /healthz。

## 10. 测试策略

- **mock ilink 服务**（Hono 实现全部 9 端点 + 可编排场景：confirmed 延迟、ret=-2、errcode=-14、
  游标推进）驱动集成测试：绑定全流程、推送成功/未预热/token 失效、重启恢复、关键词转发。
- 单测：参数四编码解析矩阵、匹配器、分块、markdown 过滤、限频、加密。
- 契约金样本：以 serverchan-sdk 源码为金标准固化 `{code,message,data}` 契约测试
  （暂不需要真实 sendkey；若后续发现解析 data 内部字段的应用再补抓）。
- 真机验收清单写入 runbook（需用户扫码）。

## 11. 里程碑任务清单

- **M1 骨架（0.5–1 天）**：git init、Bun 工程+TS strict+eslint+bun:test、config(zod)、
  Drizzle schema+迁移+repos、Hono 骨架+/healthz、crypto/ids/logger、Dockerfile+compose、CI。
  验收：`bun test` 绿，容器起、healthz 200。
- **M2 微信通道 + 推送（3–5 天，核心）**：ilink types/client → 绑定状态机 + 向导 API/UI →
  monitor 循环+游标 → context store → sender+分块+markdown → outbox →
  ServerChan 兼容层+限频+push_log → mock 集成测试 → 契约测试。
  **真机验收**：扫码绑定（含配对码）→ 预热 → curl 一行推送到达 → 容器重启免重扫 →
  未预热错误提示正确 → 长文分块可见。
- **M3 关键词路由（1.5–2 天）**：matcher + CRUD API + forwarder+HMAC + builtins + inbound_log。
  验收=R2 标准。
- **M4 Web UI 完整（1.5–2 天）**：全部页面+会话管理（解绑触发 notifystop、重置 sendkey）。
  验收=R5 标准。
- **M5 邮件桥（2–3 天，可选默认关）**：imapflow 收信推送、nodemailer 发送、`mail:*` 关键词。
  验收=R3 标准。
- **M6 多用户（1 天）**：并发账号联调、席位上限、隔离与歧义目标测试。验收=R4 标准。
- **M7 加固交付（1–2 天）**：加密审计、脱敏审计、故障演练（断网/重启/二维码过期/-14）、
  生产 compose、README+ServerChan 迁移指南。
- **M8 serverless PoC（独立评估）**：Hono 适配 Lambda（轮询自续）或 CF Workers+Durable Object，
  D1/libsql 状态外置，输出 go/no-go。

合计约 11–16 人日。

## 12. 需要用户配合的节点

1. M2 真机联调：手机扫码 + 输入配对码 + 发送预热消息「hello」（各一次，约 5 分钟）。
2. 仅当发现应用解析 ServerChan 响应 `data` 内部字段时，才需要真实 sendkey 补抓契约。

## 13. ServerChan 契约事实（来自官方 SDK 审计，2026-08-29）

- 端点：SCT（Turbo）版 `POST https://sctapi.ftqq.com/{sendkey}.send`；
  SC3 版 `POST https://{sendkey}.push.ft07.com/send`（域名即 key）。
  官方 SDK 全部 `POST + application/json;charset=utf-8`。
- 参数：`title`（必填）、`desp`（Markdown，支持 https 图片）、可选 `short / tags / channel / openid / noip`。
- 响应契约面：`{code: number(0=成功), message: string, data?: any}` —— SDK 的 TS 类型仅承诺此三字段；
  SCT 与 SC3 的 `data` 内部结构不同（我们不承诺 data 内部字段，只保证三字段语义）。
- 多后端：Server酱按 sendkey 前缀路由后端（`sctp`→ft07，其余→ftqq），`channel` 参数选消息通道——
  我们的 Channel 注册表对齐此模式。

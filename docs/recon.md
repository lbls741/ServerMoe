# M0 侦察报告（docs/recon.md）

- 日期：2026-08-29
- 任务：AGENT.md §6 之 Q1–Q7 与决策门 D1
- 结论速览：**Route B（按现有接口重实现）可行且已选定**。目标协议并非黑箱——官方插件
  MIT 开源、npm 包直接附带完整 TypeScript 源码，其 README 更内含「后端 API 协议」完整章节。
  传输为纯 HTTP JSON + 长轮询（无 WebSocket），对 serverless 友好。ServerChan 式主动推送
  **可行，但有一次「预热」约束**（见 §3）。

## 1. 目标包识别（Q1）

| 项 | 值 |
|---|---|
| 包名 | `@tencent-weixin/openclaw-weixin`（安装器 `@tencent-weixin/openclaw-weixin-cli`） |
| 当前版本 | 2.4.6（dist-tag `latest`，共 22 个版本；1.x 为 `legacy` 线） |
| 许可 | **MIT**，author Tencent，维护者 6 人均为 `@tencent.com` 邮箱 |
| 依赖 | 仅 `zod` + `qrcode-terminal`（peer：`openclaw >= 2026.5.12`，仅用于宿主版本检查） |
| 发布物 | **完整 TS 源码 `src/` + 编译产物 `dist/` + 双语 README/CHANGELOG**（非混淆、非打包） |
| 微信侧入口 | 微信 8.0.70+ → 我 → 设置 → 插件 → 「ClawBot」卡片（2026-03-22 上线） |

解包位置：`research/extract/official/package/`。官方 README（`README.zh_CN.md`）第 110 行起
为「后端 API 协议」章节，声明：*「二次开发者若需对接自有后端，需实现以下接口」*——协议
本身是面向二次开发的公开契约。

## 2. 协议规格（Q2）

### 2.1 域名

| 用途 | URL |
|---|---|
| 登录固定入口 / 默认 API | `https://ilinkai.weixin.qq.com` |
| 每账号 API baseurl | 登录 `confirmed` 时由服务端下发（`baseurl` 字段） |
| 媒体 CDN | `https://novac2c.cdn.weixin.qq.com/c2c` |
| IDC 迁移 | 长轮询响应 `scaned_but_redirect` → `redirect_host`，客户端切换 baseurl |

### 2.2 请求头（所有 API）

| Header | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `AuthorizationType` | 固定 `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>`（扫码确认后获得） |
| `X-WECHAT-UIN` | 随机 uint32 的十进制字符串再 base64（防重复，无鉴权意义） |
| `iLink-App-Id` | `bot`（来自官方包 package.json 顶层 `ilink_appid`） |
| `iLink-App-ClientVersion` | 插件版本编码为 uint32：`(major<<16)\|(minor<<8)\|patch` |
| `SKRouteTag` | 可选路由标签 |

`bot_agent` 请求体字段（默认 `OpenClaw`）仅用于后台观测归因，**不参与鉴权**（官方 README 明示）。

### 2.3 端点一览（全部为相对 baseurl 的 POST，`get_qrcode_status` 为 GET）

| 端点 | 长轮询 | 说明 |
|---|---|---|
| `ilink/bot/get_bot_qrcode?bot_type=3` | 否 | 取绑定二维码，body `{local_token_list}`；返回 `{qrcode, qrcode_img_content}`（后者为可渲染的 URL） |
| `ilink/bot/get_qrcode_status?qrcode=` | 是（35s） | 绑定状态机，见 2.4 |
| `ilink/bot/getupdates` | 是（35s，服务端可调） | 收信；body `{get_updates_buf}` 游标；返回 `{ret, msgs[], get_updates_buf, longpolling_timeout_ms}` |
| `ilink/bot/sendmessage` | 否 | 发送；见 2.6 |
| `ilink/bot/getuploadurl` | 否 | CDN 预签名上传参数（AES-128-ECB 密文尺寸/MD5） |
| `ilink/bot/getconfig` | 否 | 获取 `typing_ticket`（按用户缓存，TTL 24h 随机刷新） |
| `ilink/bot/sendtyping` | 否 | 输入状态 `status: 1`开始 / `2`取消 |
| `ilink/bot/msg/notifystart` / `notifystop` | 否 | 通道启动/停止通知 |

### 2.4 扫码绑定状态机（`get_qrcode_status`）

`wait → scaned → confirmed`；分支：`need_verifycode`（手机显示数字配对码，`verify_code` 参数回传）、
`verify_code_blocked`（多次输错封禁）、`expired`（二维码过期，客户端自动刷新 ≤3 次，TTL≈5min）、
`scaned_but_redirect`（IDC 迁移）、`binded_redirect`（该 bot 已绑定过，配合 `local_token_list` 防重复绑定）。

`confirmed` 返回：`bot_token`、`ilink_bot_id`（账号 ID）、`baseurl`（该账号专属 API 地址）、
`ilink_user_id`（扫码者用户 ID，即首位可对话用户）。

### 2.5 收信循环（`src/monitor/monitor.ts`）

游标 `get_updates_buf` **落盘持久化**（`storage/sync-buf.ts`）→ 进程重启后从中断处继续，无需重扫。
错误处理：连续 3 次失败退避 30s；`errcode = -14`（STALE_TOKEN）→ 整账号暂停 1 小时后重试。

### 2.6 发送与消息结构

`sendmessage` body：`{msg: {to_user_id, context_token?, item_list[], message_type: 2(BOT), message_state: 2(FINISH), client_id, run_id?}}`。
`item_list` type：`1`文本 / `2`图片 / `3`语音(SILK) / `4`文件 / `5`视频；媒体项携带
`{encrypt_query_param, aes_key}`（AES-128-ECB，密钥随消息下发，CDN 直传直取）。
另有 `ref_msg`（引用消息）。入站 `WeixinMessage` 含 `from_user_id`、`session_id`、`context_token`。

### 2.7 错误码

| 码 | 含义 | 处理 |
|---|---|---|
| `ret: 0` | 成功 | — |
| `ret: -2`（`prepare failed`） | **缺 `context_token`** | 需用户先发一条消息（预热）后重试 |
| `errcode: -14` | `bot_token` 失效 | 需重新扫码绑定（官方先暂停 1h 重试） |

## 3. 主动推送能力（Q4，ServerChan 生死线）

**结论：可行，附一次预热约束。**

- 官方行为：`context_token` 缺失时仅 `logger.warn` 并照常发送（`src/messaging/send.ts`）；
  收信时按 `accountId + from_user_id` 持久缓存每个用户的最新 `context_token`（`setContextToken/getContextToken`）。
- 社区实证（`weclaw-bridge` README/SKILL）：微信要求 bot 回复必须携带入站消息下发的
  `context_token`；**绑定后用户需先给 ClawBot 发至少一条消息**（预热），此后即可随时主动推送；
  token 失效表现为 `ret=-2`，重新预热即可；`bot_token` 失效（`-14`）需重新扫码。
- 产品启示（写入设计约束）：
  1. 推送 API 必须区分「未预热」错误码，返回指引文案（「请先在微信里给 bot 发任意一条消息」）；
  2. Web UI 按用户展示预热状态与最后入站时间；
  3. 每次入站消息自动刷新 context_token 缓存——正常使用中会话会被用户的交互持续续期。

## 4. 会话寿命与恢复（Q6）

- 凭据落盘：每账号一个 JSON `{token, savedAt, baseUrl, userId}` + `accounts.json` 索引；
  同一微信用户重新绑定会自动清除旧账号条目（`clearStaleAccountsForUserId`）。
- 游标落盘：重启恢复、不丢消息、不需重扫。
- 多账号是一等公民：官方 README「每次扫码登录都会创建一个新的账号条目，支持多个微信号同时在线」→ **R4 多用户有官方先例**。
- 二维码：TTL≈5min，自动刷新 ≤3 次；有配对码与风控封禁分支——Web UI 必须完整呈现该状态机。

## 5. 宿主表面（Q3）与 Route A 弃用理由

插件通过 `openclaw/plugin-sdk/{core, channel-contract, reply-runtime, account-id}` 与宿主交互，
网关注入 `channelRuntime`（`recordInboundSession`、`dispatchReplyFromConfig`、`ChannelGatewayContext` 等），
且启动时做宿主版本检查（不满足拒绝加载）。Route A（自建宿主装载官方包）需要重新实现这套
SDK 表面并绕过版本门禁，而协议本身已完全公开——**成本高、收益零**。

**D1 裁决（2026-08-29）：Route A 放弃；Route B 选定**——以官方 README 协议章节 + MIT 源码为规范，
自研 iLink Bot HTTP 客户端。Route C（企业微信/服务号降级）保留为预案。

## 6. 消息能力（Q5）

支持文本/图片/语音/文件/视频/引用消息与 typing 指示。`messaging/markdown-filter.ts`（361 行）
的存在表明落地端对 Markdown 渲染**有限制/转换**（ServerChan 的 `desp` 是 Markdown）——
具体渲染效果与文本长度上限源码中未见显式定义，**列入 M2 实测清单**。

## 7. OpenClaw 身份（Q7）

不需要任何 OpenClaw 账号。绑定单位是 bot 实例（`ilink_bot_id`），唯一长期凭据是 `bot_token`。
`bot_agent` 不参与鉴权；`local_token_list`（本地已有 token 列表，≤10）仅用于服务端识别
「已绑定到本端」避免重复发会话。社区桥不带任何 OpenClaw 痕迹也正常工作。

## 8. Serverless 评估（R6 / M8 前置）

- 有利：无 WebSocket、无二进制协议、无本地密码学依赖（媒体 AES 密钥由服务端下发）；
  每账号状态极小：`{bot_token, baseUrl, userId, get_updates_buf 游标, per-user context_token 缓存}`。
- Lambda 模式：每账号一个轮询循环跑满 15min 自续（EventBridge 重触发）；状态入 DynamoDB/SSM；
  扫码绑定为独立短请求，Web UI 承载。
- Cloudflare 模式：每账号一个 Durable Object 持有轮询循环最自然（alarm 保活）；纯 Workers + cron 次之。
- 延迟模型：推送延迟下限为一次 `sendmessage` RTT；入站感知延迟 0–35s（长轮询窗口）。
- 结论：**serverless 可行**（比预期好得多），M8 做 PoC；Docker 仍为首选形态。

## 9. 先例实现（交叉验证，均 MIT）

| 包 | 定位 | 对本项目的价值 |
|---|---|---|
| `weclaw-bridge`（Gentle-Lijie/WeClawBridge） | 独立桥（不装 OpenClaw）：`/login/start`、`/login/wait`、`/send` | **定位与我们最接近**；预热语义、错误码恢复策略可直接借鉴 |
| `weixin-clawbot`（undirectlookable） | TS SDK + 文档站 | 协议参考实现 |
| `@onebots/adapter-wechat-clawbot` | 扫码登录/长轮询/会话持久化/媒体收发 | 会话持久化参考 |
| `@linjianyu/dsh-wechat-bridge` | 零依赖 iLink 直连 | 极简实现参考 |
| `@zhin.js/adapter-weixin-ilink`、`pi-weixin-bridge`、`codex-wechat-channel`、`opencode-wechat`、`wechat-clawbot-mcp` 等 | 各生态桥接 | 证明自 2026-03 以来生态持续活跃、无已知大规模封号 |

## 10. 遗留开放问题（转入 M2 实测清单）

1. `context_token` 的有效期与失效触发条件（是否存在服务端 TTL；`ret=-2` 的精确复现条件）。
2. Markdown 在落地端的实际渲染效果、文本长度上限、长文分段策略。
3. `-14` 之后的恢复路径：静置 1h 自愈 vs 必须重扫（决定重绑 UX 的自动化程度）。
4. 服务端频率限制的实测阈值（推送 API 与 getupdates 分别测）。
5. `qrcode_img_content` 的确切格式（URL，可自渲染二维码——官方用 qrcode-terminal 渲染它）。
6. `notifystart/stop` 对服务端会话的实际影响（可否省略）。
7. 同账号多用户 DM 的隔离与并发推送行为。

## 11. 证据产物

- `research/extract/official/package/` — 官方包解包（`src/*.ts` 完整源码）
- `research/pkgs/` — 各包 tarball；`weixin-clawbot/`（git clone）；`weclaw/`（解包）
- 关键源文件：`src/api/api.ts`（586 行，端点实现）、`src/auth/login-qr.ts`（458，绑定状态机）、
  `src/monitor/monitor.ts`（224，收信循环）、`src/messaging/send.ts`（294，发送）、
  `src/channel.ts`（544，宿主集成/出站路由）、`src/auth/accounts.ts`（391，凭据存储）

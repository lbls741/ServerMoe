# AGENT.md — SuperServerChan（私有部署「超级 Server酱」）

> 面向编码 Agent 的项目宪法。所有实现决策、任务拆分与验收以本文为准。
> 状态：**M0–M3 已完成**（M2 经真机验收）。M3 关键词路由 + **开发者接入 demo**（examples/keyword-receiver，零依赖 Node.js，含端到端测试）均已交付，53 测试全绿，镜像 m3 冒烟通过。下一步：M4 Web UI 完整 → M5 邮件桥 → M6 多用户 → M7 加固交付。
> 修订协议：接口变更必须同步 §8；路线变更必须更新 §6/§9。

## 1. 一句话定位

一个可私有部署的网关：对外提供 **ServerChan（Server酱）完全兼容的零 SDK 推送 API**，
对内借道 **微信官方的 OpenClaw 接入通道** 把消息送达用户微信聊天界面，并支持
**用户→应用的反向消息路由（关键词机制）**、可选邮件桥、多用户绑定，外加一个展示
绑定二维码的简单网页。

核心思想：**不逆向微信客户端、不碰落地端**。M0 侦察证实（见 docs/recon.md）：微信官方的
对接端插件 `@tencent-weixin/openclaw-weixin` 为 MIT 开源，npm 包附带完整 TS 源码，README
文档化了插件↔后端的全部 HTTP JSON 接口（iLink Bot API，纯长轮询）。因此我们直接**按该
公开协议自研客户端**（Route B），完全不依赖 OpenClaw 宿主，也不需要装载官方包。

## 2. 背景与动机

- Server酱痛点：免费额度吝啬、单向推送、依赖企业微信/服务号等重配置通道、第三方托管不可控。
- 微信 OpenClaw 接入的两端架构（用户可见部分）：
  - **对接端**：符合 OpenClaw 插件规范的 npm 包。负责展示绑定二维码、
    接收服务器推送并转发给 OpenClaw、以及反向发送。
  - **落地端**：微信 App 内功能。负责扫码绑定、在聊天界面收发消息。
  - 两端之间的通信 = **黑箱**（大概率由官方包与微信/OpenClaw 后端完成）。
- 机会：OpenClaw 在这条链路里只是「两端之间的一个消息处理节点」。把 OpenClaw
  换成我们自己的路由逻辑，这条通道就变成一条**官方的、双向的**微信消息管道，
  足以替代 Server酱 并做得更好。

## 3. 术语表

| 术语 | 含义 |
|---|---|
| 对接端 / 官方包 | 微信发布的、符合 OpenClaw 插件规范的 npm 包（M0 时获取并解包审计） |
| 落地端 | 微信 App 内的扫码与聊天功能，**永不逆向** |
| 宿主（plugin host） | 本项目实现的「OpenClaw 插件系统仿制品」，承载官方包运行 |
| 会话（session） | 一次成功绑定后的存活连接及其凭据（含二维码生命周期） |
| sendkey | 每用户一张推送凭证，对齐 Server酱 的 SENDKEY 概念 |
| 关键词路由（KWR） | 用户消息按关键词转发到已注册应用 webhook 的机制 |

## 4. 核心需求

### R1 零 SDK 推送（ServerChan 兼容）— P0

一个 URL、零 SDK 推送消息，老应用把 base URL 换掉即可无缝迁移。

- 端点草案：`GET/POST /{sendkey}.send`，参数 `title`（必填）、`desp`（Markdown 正文，选填）。
- 接受 form-urlencoded / query string / JSON 三种编码。
- 响应对齐 Server酱 形态：`{"code":0,"message":"","data":{"pushid":"...","error":"SUCCESS"}}`
  （字段名与错误码以 M2 时对真实 Server酱 的抓包快照为准）。
- 错误语义：401 无效 sendkey、429 限频、502 通道不可用。

验收：`curl "http://gw/{sendkey}.send?title=hi&desp=hello"` → 微信聊天界面收到消息；
Server酱 老脚本改 base URL 后不改任何参数即工作。

### R2 反向消息推送（关键词路由 KWR）— P0

应用把「关键词 + 回调地址」注册到网关；用户在微信里输入含关键词的消息即被转发到对应应用。

- 注册：`POST /api/v1/keywords`（Bearer sendkey / admin token）
  `{"keyword":"deploy","match":"prefix","url":"https://app.example.com/hook","secret":"可选HMAC密钥"}`
  `match ∈ prefix | exact | contains | regex`。
- 命中转发：网关向 `url` POST
  `{"user":"u1","keyword":"deploy","text":"deploy all","ts":...,"msg_id":"..."}`。
- 回执约定：5 秒内 2xx 且 body 为 `{"reply":"..."}` → 该文本发回微信；
  超时/无 reply → 默认回执「已转发」；回调失败 → 错误回执。
- 未命中：发送可配置的默认提醒（默认开，提示输入 `help`）。
- 保留关键词命名空间：`help`、`status`、`bind`、`mail`（内置），应用不得注册。

验收：注册 demo webhook 后，微信输入关键词 → webhook 收到请求、其回复在微信可见；
输入不存在的词 → 收到提醒。

### R3 邮件桥（可选，默认关闭）— P2

网关实现邮箱**客户端**协议，双向桥接邮件与微信。

- 收：配置 IMAP/POP3 账号后轮询新邮件 → 推送摘要（发件人/主题/正文前 N 字）到微信。
- 发：关键词命令发邮件，如 `mail to:a@b.c subject:hi body:...`；`mail:reply <id> ...`。
- 默认关键词集：`mail:help`、`mail:list`、`mail <n>`（读第 n 封）、`mail:send`。

验收：新邮件 1 分钟内微信可见；`mail:send` 经 SMTP 成功发出。

### R4 多用户 — P1

- 单实例多会话并存；每会话独立 sendkey、关键词表、邮件配置。
- admin token 控制绑定席位（生成新二维码需授权），防止陌生人占用。
- 存储草案：`sessions(id, wechat_hint, sendkey_hash, status, created, last_seen)`。

验收：两个微信号分别绑定，推送按 sendkey 精准到达对应人，互不串扰。

### R5 Web UI — P1

- `/`：会话列表 + 状态；「新增绑定」→ 二维码页（轮询：待扫/已扫/已绑定/过期自动刷新）。
- 管理：sendkey 展示/重置、关键词增删、邮件配置（后期）。
- 技术选型轻量（服务端渲染或 htmx/原生 JS），禁止引入重前端栈。

验收：全程仅用 Web UI 完成一次新用户绑定与一次关键词注册。

### R6 部署形态 — P0(Docker) / P3(Serverless)

- Docker（主形态）：单容器 + 卷持久化（SQLite + 会话凭据），
  `docker run -v ssc-data:/data -p 8080:8080`；容器重启**不得**要求重新扫码。
- Serverless（评估项）：核心矛盾 = 官方包大概率需要常驻长连接与内存态会话凭据。
  预案 a) 混合：HTTP API 无服务化 + 一个常驻 bridge 小实例；
  预案 b) 全量状态外置（Upstash/D1 等）+ 长连接代理。
  做 PoC 后 go/no-go，不阻塞主线。

## 5. 非目标

- 不实现任何 AI/LLM 能力（OpenClaw 本体我们不感兴趣）。
- 不逆向微信客户端协议、不碰落地端、不使用任何非官方 bot 框架。
- 不做多 IM 平台（Telegram/WhatsApp 等）。
- 不做商业化多租户/SaaS。
- 不重分发官方 npm 包的代码；解包产物仅限本地研究。

## 6. 关键未知与决策门（D1）

M0 必须回答的问题（答案落盘 `docs/recon.md`）：

- **Q1** 官方包是否开源/可读？打包形态（minified/bundled）？——决定 Route A 成本。
- **Q2** 官方包与后端通信：端点、传输（WebSocket/长轮询/HTTP）、二维码绑定时下发了什么凭据？
- **Q3** 插件规范定义的「宿主表面」：官方包期望宿主提供哪些 API/事件/配置/依赖注入？
- **Q4（生死线）** 主动推送：无用户近期交互时，通道能否**随时**向用户发消息？
  若只能会话窗口内回复 → Server酱 替代价值不成立，回 D1 重新决策。
- **Q5** 消息能力：纯文本/Markdown/图片？长度上限？频率限制？
- **Q6** 会话寿命：二维码有效期、掉线重连语义、绑定是否长期常驻？
- **Q7** 是否强绑定 OpenClaw 身份（绑定/通信是否需要 OpenClaw 账号或 deviceId）？

**决策门 D1**（M0 结束时裁决）：

- **Route A（首选）**：官方包可直接复用 → 我们实现宿主（Q3 的表面），装载官方包，
  截获收发事件。协议黑箱全部外包给官方包。
- **Route B（次选）**：官方包闭源且无法承载 → 依 Q2 流量观测重实现协议。
  风险：加密/签名、风控、随官方更新失效。
- **Route C（降级）**：通道不可行（含 Q4=否）→ 放弃 OpenClaw 路线，
  用企业微信应用/服务号自建通道，仍交付同一套上层 API（R1–R5 全部不受影响）。

**D1 裁决记录（2026-08-29，依据 docs/recon.md）**：选定 **Route B**。
- Q1：官方包 MIT 开源、附带完整 TS 源码与协议文档 → 协议非黑箱。
- Q2：纯 HTTP JSON + 长轮询（无 WebSocket），端点/请求头/消息结构全部文档化。
- Q4（生死线）：主动推送**可行但需预热**——绑定后用户须先发一条消息以捕获 `context_token`，
  之后可随时推送；token 失效（ret=-2）重新预热，bot_token 失效（-14）重新扫码。
  推送 API 必须区分「未预热」错误并给出指引（写入 R1 设计约束）。
- Q6：凭据 `{token, baseUrl, userId}` + 同步游标均落盘，重启免重扫。
- Q7：无需 OpenClaw 账号；多账号同时在线为官方一等能力（利好 R4）。
- Route A 弃用理由：协议已公开，重实现 OpenClaw 宿主（plugin-sdk 表面 + 版本门禁）成本高、收益零。
- Q4=否 时的项目重估条款不再适用（Q4 已确认为「有条件可行」）。

## 7. 架构草图

```
 应用A ──POST /{sendkey}.send──┐
 应用B ◄─POST webhook(关键词)──┤
 用户浏览器 ──Web UI(二维码)───┤
                               ▼
                  ┌──────────────────────────────┐
                  │        网关核心 (本项目)        │
                  │  HTTP API │ KWR 路由 │ 会话管理 │
                  │  邮件桥    │ Web UI   │ SQLite  │
                  └──────────────┬───────────────┘
                                 │ 事件/调用（截获·注入）
                          plugin-host shim  ←「仿 OpenClaw 宿主」
                                 │
                    官方 OpenClaw 插件（对接端 npm 包）
                                 │ 黑箱协议（官方包承担）
                            微信服务器 ◄──▲▼── 用户微信 App（落地端，不碰）
```

分层纪律：协议细节只许存在于 `src/channel/`（plugin-host + 官方包装载/或协议实现），
业务层（API/路由/UI/邮件）只面向「收消息/发消息」抽象，禁止触碰协议事实。

## 8. 兼容性与接口规范

- ServerChan 兼容层：见 R1。**以抓包快照为准**，实现时用真实响应做契约测试。
- KWR 规范：见 R2（注册/转发/回执/保留字）。
- ServerChan 契约（官方 SDK easychen/serverchan-sdk 审计，2026-08-29）：
  - 端点：SCT 版 `POST https://sctapi.ftqq.com/{sendkey}.send`；SC3 版 `POST https://{sendkey}.push.ft07.com/send`；
    官方 SDK 全部 `POST + application/json`。
  - 参数：`title`（必填）、`desp`（Markdown）、可选 `short/tags/channel/openid/noip`。
  - 响应契约面：`{code: number(0=成功), message: string, data?: any}` —— SDK 类型仅承诺此三字段；
    `data` 内部结构不承诺（SCT 与 SC3 本就不同）。
  - 多后端：Server酱按 sendkey 前缀路由后端（`sctp`→ft07，其余→ftqq）——本项目 Channel 注册表对齐此模式。
- 内部抽象（业务层依赖的接口）：`Channel` 至少提供
  `onQRCode(cb)`、`onBound(cb)`、`onMessage(cb)`、`send(text|markdown)`、`sessionStatus()`。
- 错误体统一：`{"code":int,"message":str}`，与 ServerChan 兼容层互不污染。

## 9. 里程碑与任务清单

### M0 侦察（→ 决策门 D1）— ✅ 已完成（2026-08-29）
- [x] 获取官方 npm 包：`@tencent-weixin/openclaw-weixin@2.4.6`（MIT，含完整 TS 源码）
- [x] 解包审计：`research/extract/official/package/`；协议文档在其 README「后端 API 协议」章节
- [x] 交叉验证：社区桥 `weclaw-bridge`/`weixin-clawbot` 等多个独立重实现（均 MIT）
- [x] 回答 Q1–Q7，写 `docs/recon.md`；Route B 选定
- 备注：绑定流程的动态实测（真机扫码）留待 M2 一并完成

### M1 骨架
- [ ] Node.js + TypeScript 仓库初始化，lint/test/CI
- [ ] 配置系统（env + 文件）、SQLite 存储层、结构化日志
- [ ] plugin-host shim 接口占位、`Channel` 抽象
- 验收：`docker build` 通过，空网关可启动

### M2 打通通道（最小端到端）
- [ ] 自研 iLink Bot HTTP 客户端（规范 = docs/recon.md §2 + 官方源码）：绑定状态机全流程
      （二维码 TTL 刷新、数字配对码、IDC 重定向）、长轮询收信 + 游标落盘、发送链路
- [ ] 真机实测 recon.md §10 开放问题（context_token 预热/失效、Markdown 渲染、长度上限、限频）
- [ ] 会话持久化：容器重启不重扫
- [ ] ServerChan 兼容层 `/{sendkey}.send`（契约快照测试）
- 验收：一行 curl → 微信收到消息；重启容器后仍可收发

### M3 关键词路由
- [ ] 注册/存储/匹配引擎、webhook 转发、超时与回执语义
- [ ] 未命中提醒、`help`/`status` 内置命令
- 验收：R2 验收标准通过

### M4 Web UI
- [ ] 二维码绑定页（状态轮询与自动刷新）、会话管理、sendkey 管理、关键词管理
- 验收：R5 验收标准通过

### M5 邮件桥（可选，默认关）
- [ ] IMAP/POP3 轮询 → 推送；SMTP 发送；`mail:*` 关键词集
- 验收：R3 验收标准通过

### M6 多用户
- [ ] 多会话并存、按 sendkey 隔离、席位上限、admin token
- 验收：R4 验收标准通过

### M7 加固与交付
- [ ] 限频、sendkey 哈希落盘、HMAC webhook 签名、日志脱敏
- [ ] 故障演练：断网/重启/二维码过期 三类场景自动恢复
- [ ] docker-compose 示例 + README（含 Server酱 迁移指南）
- 验收：三类故障演练通过；陌生人拿不到未授权绑定入口

### M8 Serverless 评估（P3）
- [ ] 依 Q6 结论做混合架构 PoC，输出 go/no-go 报告

### M9 降级通道（仅 D1=Route C 时启动）
- [ ] 企业微信应用/服务号自建通道，上层 API 不变

## 10. 风险与合规

- **ToS/风控**：定位为个人低频自用；不共享实例、不群发、不倒卖；出现风控信号立即停止并记录。
- **协议易变**：官方包更新可能随时破坏假设 → 版本 pin + recon.md 持续维护 + 通道层隔离（§7）。
- **凭据安全**：会话凭据/sendkey 落盘加密（至少混淆）+ 文件权限收紧；Web UI 默认监听内网/加鉴权。
- **Q4=否 时的项目重估**：主动推送能力是本项目存在理由，触发即回 D1。

## 11. 工作约定（给后续 Agent）

- 技术栈（v2 复核定稿，理由与取舍表见 docs/dev-plan.md §2）：**Bun 1.3 + Hono 4 + bun:sqlite/Drizzle +
  zod 4 + bun:test**；UI 零构建（hono/jsx SSR）。运行时隔离纪律：fs/sqlite 只在 db/storage 模块。
  回退路径：@hono/node-server + better-sqlite3 驱动 ≈1 天。（原 Node 选型的「官方包需同运行时」
  理由随 Route B 裁决失效，故重推。）
- 动手前先读本文档与 `docs/recon.md`；协议事实一律以实测为准，**禁止臆测写死**。
- 协议代码集中在 `src/channel/`，业务层只依赖 §8 的 `Channel` 抽象。
- 每个里程碑合入前：`pnpm test` + `docker build` 通过。
- 文档随代码更新：接口变更必须同步 §8；路线变更必须更新 §6/§9。

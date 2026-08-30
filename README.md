# ServerMoe（私有部署「超级 Server酱」）

一个可私有部署的微信消息网关：对外提供 **ServerChan（Server酱）完全兼容的零 SDK 推送 API**，
对内通过微信官方 OpenClaw 通道（ClawBot / 腾讯 iLink Bot API）送达你的微信聊天界面；
同时支持**反向关键词路由**（微信里发指令 → 转发到你的应用 → 回复直达微信）、可选邮件桥、
多用户与席位管理。

> 单二进制/单容器运行，数据全在本机。个人自用、低频通知场景设计。

## 特性

- **零 SDK 推送**：`/{sendkey}.send`，与 Server酱 参数和响应结构兼容，老应用换 base URL 即迁移
- **反向关键词路由**：应用注册「关键词 → webhook」，微信发消息即触发，回复直达微信（HMAC 签名、5s 超时、失败回执）
- **邮件桥（可选）**：IMAP 收信转微信、`mail:send` 关键词经 SMTP 发信
- **多用户**：多微信号同时在线，每账号独立 sendkey/关键词/邮件配置，席位上限可控
- **免运维语义**：重启免重扫、掉线自动重试、二维码过期自动刷新、未预热推送排队自愈、token 失效熔断标记
- **安全**：sendkey 仅存哈希、凭据 AES-256-GCM 加密落盘、webhook HMAC 签名、管理接口鉴权

## 快速开始

### 方式一：Docker（推荐）

```bash
cp .env.example .env   # 填 SSC_SECRET / SSC_ADMIN_TOKEN（或留空自动生成后从日志取）
docker compose up -d --build
curl http://localhost:8080/healthz
```

### 方式二：裸 Linux 一键部署

把项目目录上传到服务器，然后：

```bash
sudo bash scripts/deploy.sh install    # 安装 Bun、创建 systemd 服务、启动并健康检查
sudo bash scripts/deploy.sh update     # 更新代码并重启（数据保留）
sudo bash scripts/deploy.sh uninstall  # 卸载（数据保留）
```

细节见脚本头部注释。数据落在 `/var/lib/servermoe`，配置在 `/etc/servermoe.env`。

### 方式三：本地开发

```bash
bun install
bun run dev            # http://localhost:8080（--hot 热重载）
bun test test/         # 69 项测试
bun run typecheck && bun run lint
```

## 初始化流程

1. 打开管理页 `http://<host>:8080/`，填入 `SSC_ADMIN_TOKEN` 保存；
2. 「生成绑定二维码」→ 手机微信（8.0.70+）扫码 → 如有配对数字则填入 → 完成绑定，**保存 sendkey**（仅显示一次）；
3. **预热**：在微信里给 ClawBot 发任意一条消息（推送的前置要求，未预热会排队自动补发）；
4. 用任意语言一行请求推送：

```bash
curl "http://<host>:8080/MOExxxxxxxx.send?title=构建完成&desp=**耗时** 3s"
```

## 反向控制（关键词路由）

应用注册「关键词 → 回调地址」后，微信里发消息即触发转发，应用返回
`{"reply":"…"}` 会直接出现在微信里。完整协议、HMAC 验签代码、限制与最佳实践见
**[docs/integration.md](docs/integration.md)**（反向控制接入文档），
可运行的零依赖示例见 [examples/keyword-receiver](examples/keyword-receiver/)。

## ServerChan（Server酱）迁移指南

| Server酱 | ServerMoe | 说明 |
|---|---|---|
| `https://sctapi.ftqq.com/{SENDKEY}.send` | `http://<网关>/{sendkey}.send` | 只换域名，参数/响应结构一致 |
| 免费 5 条/天 | 自托管默认 60 次/时（可调） | 限额在网关侧执行 |
| 单向推送 | 推送 + 关键词反向路由 + 邮件桥 | 新能力按需启用 |

注意：官方 `serverchan-sdk` npm 包硬编码了域名，无法换 base URL；使用该 SDK 的脚本需改一行
`fetch`（或等我们后续提交的 BASE_URL 支持），其余所有直接拼 URL 的脚本零改动。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SSC_PORT` / `SSC_HOST` | 8080 / 0.0.0.0 | 监听地址 |
| `SSC_DATA_DIR` | `data` | 数据目录（SQLite、凭据、主密钥） |
| `SSC_SECRET` | 自动生成 `data/secret.key` | 落盘加密主密钥；**丢弃 data 卷将无法解密已存凭据** |
| `SSC_ADMIN_TOKEN` | 首启生成并打印一次 | 管理页与管理接口令牌 |
| `SSC_TEXT_CHUNK_LIMIT` | 3000 | 单条消息分块上限（1800–4000） |
| `SSC_SEND_RATE_PER_HOUR` / `SSC_SEND_BURST` | 60 / 10 | 每 sendkey 限频 |
| `SSC_SEAT_LIMIT` | 5 | 可绑定账号数上限 |
| `SSC_LOG_LEVEL` / `SSC_BOT_AGENT` | info / ServerMoe | 日志级别 / 出站观测标识 |

## 运维与故障恢复

| 场景 | 行为 |
|---|---|
| 进程/容器重启 | 凭据与同步游标落盘，自动恢复收发，**无需重新扫码** |
| 消息重复投递 | 按 `message_id` 去重，bot 自身回显自动忽略 |
| 未预热推送 | 返回 `code 450` 并进入 outbox，预热后自动补发（≤5 次/24h） |
| bot_token 失效（errcode -14） | 熔断暂停 1 小时并标记 `rebind_needed`，管理页重新扫码即可 |
| 二维码过期 | 自动刷新（≤3 次）；多次失败终止会话，重新发起 |
| 日志保留 | push/inbound 日志默认保留 30 天，超时自动清理 |

**备份**：备份 data 目录（Docker 卷 `servermoe-data` / `/var/lib/servermoe`）= 备份一切；
**恢复**到新机器后无需重新绑定。丢弃数据目录等于重置（需全部重新扫码）。

**排查**：`docker logs ssc-gateway`（或 `journalctl -u ssc`）；管理页日志区可看路由与推送明细；
`bun scripts/inspect.ts` 可只读检视数据库。

## 安全说明

- 管理接口与绑定向导需要 admin token；sendkey 授予推送与关键词管理权限，泄露请立即「重置 sendkey」
- 账号凭据与 webhook secret 落盘均为 AES-256-GCM 密文
- 公网部署建议置于反向代理（HTTPS）之后，并收紧防火墙；`bot_agent` 出站标识可用 `SSC_BOT_AGENT` 自定义（仅观测用）
- 本项目定位**个人自用**：请勿多租户转售、高频群发，遵守微信侧服务条款

## 项目结构

```
src/
  channels/wechat/   iLink 协议层 + 绑定状态机 + 收信 monitor + 发送（唯一感知协议处）
  api/               ServerChan 兼容层 + /api/v1 管理 API + 限频
  router/            关键词匹配、webhook 转发、内置命令、入站路由
  mail/              邮件桥（IMAP 轮询 / SMTP 发信，后端可注入）
  web/               管理页（零构建 SSR）
  db/ repo/          SQLite（Drizzle）与数据访问
examples/keyword-receiver/   开发者接入 demo（零依赖 Node.js）
docs/integration.md          反向控制接入文档
scripts/deploy.sh            裸 Linux 一键部署
```

技术栈：Bun + Hono + SQLite（bun:sqlite / Drizzle）+ TypeScript，全部依赖 MIT。详见 `package.json`。

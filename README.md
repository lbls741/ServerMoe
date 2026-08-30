# SuperServerChan（私有部署「超级 Server酱」）

一个可私有部署的微信消息网关：对外提供 **Server酱（ServerChan）兼容的零 SDK 推送 API**，
对内通过微信官方 OpenClaw 通道（ClawBot / 腾讯 iLink Bot API）把消息送达你的微信聊天界面，
并支持反向关键词路由、多用户与可选邮件桥。

> 状态：**M1 骨架已完成**（工程/DB/Hono 骨架/部署产物）。推送与绑定通道在 M2 实现。
> 规划与依据见 [docs/dev-plan.md](docs/dev-plan.md)、[docs/recon.md](docs/recon.md)、[AGENT.md](AGENT.md)。

## 快速开始（开发）

```bash
bun install
bun run dev          # http://localhost:8080
bun test test/       # 测试
bun run typecheck && bun run lint
```

## 部署（Docker）

```bash
cp .env.example .env   # 按需填 SSC_SECRET / SSC_ADMIN_TOKEN
docker compose up -d --build
curl http://localhost:8080/healthz
```

数据（SQLite + 凭据 + 主密钥）全部落在 `data` 卷：**备份该卷 = 备份一切**；丢弃它需要重新扫码绑定。

## 当前端点

| 端点 | 说明 |
|---|---|
| `GET /healthz` | 存活探针 |
| `GET /statusz` | 账号状态一览 |
| `GET/POST /{sendkey}.send` | ServerChan 兼容推送（title/desp，四编码） |
| `POST /api/v1/send` | 富推送（结构化错误：450 未预热 / 451 凭据失效） |
| `POST/GET/PATCH/DELETE /api/v1/keywords` | 关键词路由注册与管理（sendkey Bearer） |
| `POST /api/v1/login/*`、`GET /api/v1/sessions` | 绑定向导与会话管理（admin） |
| `GET /` | 极简管理页（二维码绑定 / sendkey / 状态） |

## 开发者接入

参考 [examples/keyword-receiver](examples/keyword-receiver/)：零依赖 Node.js 单文件 demo，
演示「注册关键词 → 接收微信消息（HMAC 验签）→ 回复到微信」的完整闭环，以及 ServerChan 兼容推送。
更多规格见 [AGENT.md](AGENT.md) 与 [docs/dev-plan.md](docs/dev-plan.md)。

## 文档

- [AGENT.md](AGENT.md) — 项目宪法：需求、路线裁决、工作约定
- [docs/dev-plan.md](docs/dev-plan.md) — 详细开发规划（技术栈取舍、数据模型、里程碑）
- [docs/recon.md](docs/recon.md) — M0 协议侦察报告（iLink Bot API 全规格）

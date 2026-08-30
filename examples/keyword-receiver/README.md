# 关键词接收 Demo（Node.js / 零依赖）

演示 ServerMoe 双向消息的完整接入闭环：**注册关键词 → 接收微信消息 → 打印并回复**。
单文件 `demo.js`，零 npm 依赖，只需 Node.js ≥ 18。

```
你在微信里发「demo hello」
        │
        ▼
微信 ClawBot ──► ServerMoe 网关 ──(命中关键词, HMAC 签名)──► 本 demo (打印到终端)
                        ▲                                            │
                        └────────── {"reply":"demo 已收到…"} ─────────┘
                                          ▼
                                 微信里立刻看到回复
```

## 前置条件

1. 网关已运行（`bun run dev` 或 `docker compose up -d`），默认 `http://localhost:8080`
2. 已绑定微信并拿到 sendkey（管理页绑定后显示，`SSC` 开头）
3. 已完成**预热**：在微信里给 ClawBot 发过至少一条消息

## 运行

```bash
GATEWAY=http://localhost:8080 \
SENDKEY=MOExxxxxxxxxxxxxxxx \
KEYWORD=demo \
WEBHOOK_SECRET=my-secret \
node demo.js
```

- `KEYWORD` 默认 `demo`（prefix 模式，所以 `demo hello`、`demo 状态` 都会命中）
- `WEBHOOK_SECRET` 可选；设置后 demo 演示 HMAC 验签，伪造请求会被 401 拒绝
- 启动时会顺带用 `/{sendkey}.send` 推一条测试消息到微信（演示推送端）
- 重复运行会自动删除旧定义并按新参数重注册，无需手动清理

## 测试

在**微信里**给 ClawBot 发送：

```
demo 你好
```

终端立刻打印消息内容，微信里立刻收到 demo 的回复。

## 推送端（ServerChan 兼容）

把脚本里 Server酱 的 base URL 换成本网关即可，参数完全一致：

```bash
curl "http://localhost:8080/MOExxxxxxxx.send?title=构建完成&desp=**耗时** 3s"
```

## API 速查

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 推送消息 | `GET/POST /{sendkey}.send` | `title` 必填，`desp` Markdown，兼容 Server酱 |
| 注册关键词 | `POST /api/v1/keywords` | `{"keyword","match":"exact\|prefix\|contains\|regex","url","secret?"}` |
| 列出关键词 | `GET /api/v1/keywords` | 不回显 secret |
| 删除关键词 | `DELETE /api/v1/keywords/:id` | — |
| 接收转发 | 应用 webhook 收 `POST` | body `{user_id, account_id, keyword, text, ts, msg_id}`；2xx 返回 `{"reply":"..."}` 即回发微信 |

**签名**：注册时提供 `secret`，网关每次转发附 `X-MOE-Timestamp` 与
`X-MOE-Signature = HMAC-SHA256(secret, "<ts>.<rawBody>")`，建议校验（本 demo 有完整示例）。

## 常见问题

- **GATEWAY 忘写 `http://`**：会自动按 `http://` 补全处理（终端有提示）
- **回调地址必须「网关」能访问到**：demo 与网关同机直接用默认值；网关在 Docker 里时设
  `WEBHOOK_URL=http://host.docker.internal:<PORT>/hook`
- **推送返回 450**：未预热。在微信里给 ClawBot 发任意一条消息即可，排队中的推送会自动补发
- **`bind`/`help`/`status`/`mail`** 是网关保留字，应用不能注册这些词

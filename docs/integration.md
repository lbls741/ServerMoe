# 反向控制接入文档（关键词路由 + 推送 API）

ServerMoe 是双向的：应用既能**推送**消息到微信，也能通过**关键词**接收微信里的指令。
本文是给开发者的完整接入说明。零依赖可运行示例见 [examples/keyword-receiver](../examples/keyword-receiver/)。

```
推送：  你的脚本 ──GET/POST /{sendkey}.send──► 网关 ──► 微信
反向：  微信输入「deploy now」──► 网关(命中关键词) ──POST webhook──► 你的应用
                                        ◄── {"reply":"已开始部署"} ──┘
```

## 0. 前置条件

1. 拿到 **sendkey**：管理页绑定微信后签发（`MOE` 开头），或「重置 sendkey」重新获取。sendkey 即身份，一个 sendkey 对应一个绑定账号。
2. 完成**预热**：在微信里给 ClawBot 发送任意一条消息（如 `hello`）。微信要求每条下行消息必须携带一次真实会话的上下文令牌，预热后网关会自动捕获并缓存；**未预热时推送返回 code 450 并自动排队，预热后自动补发**，不会丢。
3. 保留字：`help`、`status`、`bind`、`mail` 为网关内置命令，应用不得注册这些关键词。

## 1. 推送 API（ServerChan 兼容）

```
GET/POST http://<网关>/{sendkey}.send
```

- **编码**：四种任选——URL query、`application/json`、`application/x-www-form-urlencoded`、`text/plain`（首行为 title，其余为 desp）。
- **参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `title` | ✓ | 消息标题，≤ 消息分块上限 |
| `desp` |  | Markdown 正文；保留 `**粗体**`/行内代码/围栏/表格/水平线/引用与 H1–H4；H5/H6 与中文斜体标记会被剥离；`![图](url)` 转为链接文本行 |
| `short` |  | 摘要，拼在消息首行 |
| `tags` `channel` `openid` `noip` |  | 接受并记录，当前通道忽略（多后端预留） |

- **响应**（契约面 `{code, message, data?}`，与 ServerChan SDK 类型一致）：

| code | HTTP | 含义 |
|---|---|---|
| 0 | 200 | 成功，`data: {pushid, error:"SUCCESS"}` |
| 400 | 400 | sendkey 无效或缺 title |
| 429 | 429 | 触发限频（每 sendkey 默认 60 次/时、突发 10），带 `Retry-After` |
| 450 | 200 | 未预热：已排队，用户在微信发任意消息后自动补发 |
| 451 | 200 | 通道凭据失效：需在管理页重新扫码 |

- **长文**：超过分块上限（默认 3000 字符，可配 1800–4000）按行边界自动分块，追加 `(i/n)` 序号。

示例：

```bash
curl "http://gw.example.com/MOExxxx.send?title=构建完成&desp=**耗时** 3s"
curl -X POST http://gw.example.com/MOExxxx.send -H "Content-Type: application/json" \
  -d '{"title":"告警","desp":"磁盘使用率 **95%**","short":"磁盘告警"}'
```

## 2. 注册反向关键词

```
POST   /api/v1/keywords          注册
GET    /api/v1/keywords?accountId=…   列出（admin 用）
PATCH  /api/v1/keywords/:id      启停  {"enabled": false}
DELETE /api/v1/keywords/:id      删除
```

鉴权：`Authorization: Bearer <sendkey>`（自动作用于绑定账号）；admin token 则需另带 `accountId`。

```bash
curl -X POST http://gw.example.com/api/v1/keywords \
  -H "Authorization: Bearer MOExxxx" -H "Content-Type: application/json" \
  -d '{"keyword":"deploy","match":"prefix","url":"http://10.0.0.5:3000/hook","secret":"my-hmac-key"}'
```

| 字段 | 说明 |
|---|---|
| `keyword` | 触发词，≤64 字符；`regex` 模式下为正则表达式（注册时校验） |
| `match` | `exact` > `prefix` > `contains` > `regex`，优先级从高到低；同级按注册顺序；文本比对大小写不敏感（regex 除外） |
| `url` | 回调地址，必须**网关可访问** |
| `secret` | 可选。设置后每次转发附 HMAC 签名头 |

## 3. 转发协议（网关 → 你的应用）

命中关键词时，网关向 `url` 发起：

```
POST <url>
Content-Type: application/json
X-MOE-Timestamp: 1756543200
X-MOE-Signature: <hex>

{"user_id":"wxid_xxx","account_id":"bot-1","keyword":"deploy","text":"deploy now","ts":1756543200123,"msg_id":"12345"}
```

| 字段 | 说明 |
|---|---|
| `user_id` | 发消息的微信用户（即绑定者） |
| `account_id` | 命中的绑定账号 |
| `keyword` | 命中的关键词 |
| `text` | 用户输入的完整消息（已 trim） |
| `ts` / `msg_id` | 网关时间戳与 iLink 消息号 |

**签名**（设置了 `secret` 时）：`X-MOE-Signature = HMAC-SHA256(secret, "<ts>.<rawBody>")`，
`rawBody` 为未经处理的原始请求体，建议同时校验时间戳防重放（网关侧窗口 5 分钟）。

**应答约定**：

- 5 秒内返回 2xx，且 body 为 `{"reply": "文本"}` → 该文本**回发到微信**；
- 2xx 无 `reply` → 微信收到「已转发（关键词）」；
- 超时/非 2xx → 微信收到「转发失败（关键词）: 原因」。

**最佳实践**：

1. **不要把关键词放进回复文本开头**——回复会出现在用户的聊天界面，若再次命中关键词会形成消息循环（网关已对 bot 自身回显与重复投递做了双重防护，但请从源头避免）。
2. 快速应答：耗时任务先回 `{"reply":"已接受"}`，结果稍后用推送 API 发回。
3. 对转发请求做幂等处理（可用 `msg_id`）。

### 验签示例

Node.js：

```js
const crypto = require("node:crypto");
function valid(rawBody, ts, sig, secret) {
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
```

Python：

```python
import hmac, hashlib
def valid(raw_body: bytes, ts: str, sig: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)
```

## 4. 端到端最小流程

```bash
# 1. 注册关键词（指向本机 3000 端口的接收服务）
curl -X POST http://gw/api/v1/keywords -H "Authorization: Bearer $SENDKEY" \
  -H "Content-Type: application/json" \
  -d '{"keyword":"demo","match":"prefix","url":"http://127.0.0.1:3000/hook"}'

# 2. 在微信里发送：demo hello
# 3. 接收服务终端打印 {user_id, keyword:"demo", text:"demo hello", ...}
# 4. 微信里收到回复「已转发（demo）」或应用返回的 reply
```

完整可运行的接收端（含验签、回复、推送演示）见
[examples/keyword-receiver/demo.js](../examples/keyword-receiver/demo.js)：
`GATEWAY=… SENDKEY=… node demo.js` 一条命令跑通。

## 5. 限制与注意

| 项 | 值 |
|---|---|
| 转发超时 | 5 秒 |
| 单条消息长度 | 分块上限默认 3000 字符（配置 `SSC_TEXT_CHUNK_LIMIT`） |
| 推送限频 | 每 sendkey 60 次/时 + 突发 10（配置可调） |
| 保留关键词 | `help` `status` `bind` `mail` |
| 预热失效 | 长时间无会话后 context_token 失效（发送报 ret=-2），用户再发一条消息即恢复，排队推送自动补发 |
| bot 凭据失效 | errcode -14：账号进入熔断并标记需重绑，管理页重新扫码 |

# ServerMoe 部署到 Cloudflare Workers（一键上云指南）

ServerMoe 可以完全跑在 Cloudflare 的免费计划上：HTTP API 与管理页是 **Workers**，
数据存 **D1**，微信消息收割用 **Cron Trigger / Durable Object**。
通过官方的 **Deploy to Cloudflare** 按钮，从点击到部署完成不需要打开本地终端——
Cloudflare 会把仓库克隆到你的 GitHub 账号，在一个配置界面里填完所有参数，
D1 数据库与 Durable Object 自动创建，之后每次 `git push` 自动构建部署。

| | Docker / 裸机（自部署） | Cloudflare Workers（本文） |
|---|---|---|
| 费用 | 服务器成本 | 免费计划可长期运行 |
| 微信消息捕获 | 常驻进程实时长轮询（秒级） | 定时收割（默认 5 分钟，可调至 1 分钟；do 模式可至 10 秒） |
| 邮件桥 | ✅ | ❌（IMAP/SMTP 长连接不可用，端点返回 501） |
| 数据位置 | 你自己的服务器 | Cloudflare D1 |
| 更新方式 | 拉新镜像 / `deploy.sh update` | `git push` 自动部署 |
| 适合场景 | 已有服务器、追求实时 | 没有服务器、免费、低频通知 |

> 微信侧约束两种形态相同：iLink 通道要求**用户 24 小时内至少给 bot 回复一条消息**，
> 且首次使用需在微信里发一条消息「预热」推送（详见下文初始化步骤）。

## 前置要求

1. **GitHub 账号**（部署过程会克隆本仓库到你的账号，[ServerMoe 仓库](https://github.com/lbls741/ServerMoe) 需可公开访问）；
2. **Cloudflare 账号**（免费计划即可，注册：[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)）；
3. **手机微信 8.0.70+**（ClawBot 插件入口：「我 → 设置 → 插件」，灰度放量中，见不到入口说明暂未灰度到你的账号）。

## 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lbls741/ServerMoe)

点击上方按钮，或在 Cloudflare 文档了解 [Deploy to Cloudflare 工作原理](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

### 第 1 步：连接 GitHub

点击按钮后进入 Cloudflare 的部署向导：

1. 登录 Cloudflare 账号（没有就注册）；
2. 授权 Cloudflare 访问你的 GitHub（安装 Cloudflare Workers Builds 的 GitHub App，可只授权本仓库）；
3. Cloudflare 会**把 ServerMoe 仓库克隆一份到你的 GitHub 账号**（相当于 fork）——之后的所有部署都基于你账号里的这份副本，更新版本就是从上游拉取后 push（见「日常运维」）。

### 第 2 步：核对配置（单界面完成）

向导会读取仓库里的 `wrangler.jsonc`，展示需要你确认/填写的内容：

| 配置项 | 默认值 | 建议 |
|---|---|---|
| Worker 名称 | `servermoe` | 保持默认即可；全局唯一，也是默认访问地址 `https://servermoe.<你的子域>.workers.dev` 的一部分 |
| **D1 数据库 `DB`** | 自动创建（名为 `servermoe`） | **无需手动建库**——Cloudflare 读取配置自动预置，并把真实 `database_id` 写回你仓库里的 `wrangler.jsonc` |
| **Durable Object `POLLER`** | 自动创建 | 供 `do` 收割模式使用，cron 模式下闲置不计费 |
| `MOE_SECRET`（密钥） | 留空 | **建议填写**：`openssl rand -hex 32` 生成。它是加密微信凭据的主密钥；留空则系统自动生成并入库——数据库泄露即凭据可解密，安全性弱一档。部署后也可补设（见「部署后加固」） |
| `MOE_ADMIN_TOKEN`（密钥） | 留空 | 管理页登录令牌。留空则首次启动自动生成（从部署日志查看）。建议直接填一个自己的随机值 |
| `MOE_INGEST_MODE` | `cron` | 收割策略：`cron`=定时轮询（默认）；`do`=Durable Object alarm 链（捕获更及时、间隔可低至 10 秒）。**不建议改成 `resident`**（那是自部署形态的常驻模式，Workers 上会自动回退 cron） |
| `MOE_POLL_INTERVAL_SEC` | `300` | 定时收割默认间隔（秒）。这只是默认值，部署后可在管理页随时改，**无需重新部署** |
| `MOE_ONDEMAND_HARVEST` | `off` | 按需收割：未预热时推送前先自动短收割一次。可保持 `off`，之后需要再开 |
| `MOE_VERSION` | 留空 | 留空 = 自构建版（跳过更新检测）。想看版本提示可填当前版本号如 `0.3.0` |

> 这些说明文字就来自仓库 `package.json` 的 `cloudflare.bindings` 描述，配置界面上可以直接看到。

### 第 3 步：部署

点击 **Deploy**：

1. Cloudflare 自动创建 D1 数据库与 Durable Object 绑定；
2. Workers Builds 克隆代码 → 安装依赖（识别 `bun.lock`）→ 执行 `wrangler deploy`；
3. 首次部署会自动注册 Durable Object 类并挂载每分钟的 Cron Trigger；
4. **数据库表结构无需手动初始化**——服务首次被访问/唤醒时会以幂等 DDL 自动建表。

构建日志在向导与 Cloudflare 控制台（Workers & Pages → servermoe → 部署/构建日志）可看。整个过程约 1–2 分钟。

### 第 4 步：打开服务

部署完成后向导会给出访问地址（形如 `https://servermoe.<你的子域>.workers.dev`）：

- 浏览器打开即是管理页；`/healthz` 返回 `{"status":"ok"}` 即服务正常。

## 部署后初始化（绑定微信）

1. **获取管理令牌**：配置界面填了 `MOE_ADMIN_TOKEN` 就用它；留空了则到
   **Workers & Pages → servermoe → 日志**（或本地 `bunx wrangler tail`）里找这条启动日志：
   `MOE_ADMIN_TOKEN 未设置：已生成管理令牌，请立即保存 {"adminToken":"..."}`；
2. 打开管理页，粘贴管理令牌保存；
3. 「生成绑定二维码」→ 手机微信扫码 → 如出现配对数字则填入 → 完成绑定，**保存 sendkey**（仅显示一次）；
4. **预热**：在微信里给 ClawBot 发一条任意消息。iLink 协议规定推送必须携带从入站消息捕获的
   `context_token`，没有这一步收不到推送（未预热的推送会返回 `code 450` 并排队，预热后自动补发）；
5. 用任意语言一行请求推送：

```bash
curl "https://servermoe.<你的子域>.workers.dev/MOExxxxxxxx.send?title=构建完成&desp=**耗时** 3s"
```

如果你的应用原本接的是 Server酱，把 `https://sctapi.ftqq.com` 换成本服务地址即可。

## 部署后加固（建议完成）

1. **补设主密钥**（若部署时留空）——两种方式任选：
   - 控制台：Workers & Pages → servermoe → Settings → Variables and Secrets → 添加 **Secret** 类型 `MOE_SECRET`；
   - 本地：`bunx wrangler secret put MOE_SECRET`（值建议 `openssl rand -hex 32`）。
   注意：**更换主密钥后，此前加密的微信凭据将无法解密**，需重新扫码绑定，所以最好在绑定前设置。
2. **自定义域名**（可选）：`workers.dev` 在中国大陆的可达性不稳定，把自有域名挂到 Worker
   （Settings → Domains & Routes）可以显著改善管理页访问体验；微信推送是**腾讯服务器→你的应用**方向，
   应用端稳定即可，但管理页/推送 API 的调用方（你的浏览器与服务器）在大陆访问 `workers.dev` 建议配自定义域。
3. **观察运行状态**：`bunx wrangler tail` 实时日志；`GET /healthz` 健康检查；管理页底部日志区看收发明细。

## 收割策略与频率

微信 iLink 协议没有回调机制（腾讯不会“调用”你的云函数），“微信→本项目”方向的消息只能靠定时收割：

| 策略 | 机制 | 最低间隔 | 捕获延迟 |
|---|---|---|---|
| `cron`（默认） | Cron Trigger 每分钟唤醒，按设置间隔门控收割 | 60 秒 | ≈ 收割间隔 |
| `do` | 每个 bot 账号一个 Durable Object 单例，alarm 链自驱收割 | 10 秒 | ≈ 收割间隔 |
| 按需收割（叠加，`MOE_ONDEMAND_HARVEST=on`） | 推送遇未预热时，抢租约做一次 ≤5s 短收割再重试 | — | — |

- **改频率不需要重新部署**：管理页「入站轮询」区直接改间隔（存在 D1 的 settings 表里），
  `MOE_POLL_INTERVAL_SEC` 只是默认值；
- 三种策略互斥运行，且通过 D1 租约互斥，守住 iLink「同一 bot_token 同时只允许一个
  `getupdates` 消费者」的协议约束；
- `do` 模式在管理页改到 <60s 的间隔才会体现粒度优势；改模式需修改 `MOE_INGEST_MODE`
  变量后重新部署（Settings → Variables，或在克隆仓库改 `wrangler.jsonc` 后 push）。

## 免费额度速算（Cloudflare Free，量级估算）

| 项目 | 本服务用量 | 免费额度 |
|---|---|---|
| Workers 请求数 | cron 每分钟触发 ≈ 1,440/天 + 推送流量 | 100,000/天 |
| D1 行写入 | 节拍戳 + 游标 + 限频桶 ≈ 数千行/天 | 100,000 行/天 |
| D1 存储 | 日志 30 天保留 + 账号数据，MB 级 | 5 GB |
| DO duration（仅 `do` 模式） | 60s 间隔 ≈ 6,300 GB-s/天；300s ≈ 1,260 | 13,000 GB-s/天 |
| DO 请求数 | ≈ 每账号 1,440–8,640/天 | 100,000/天 |

**为什么用 D1 而不是 KV**：KV 免费额度只有 1,000 写/天，1 分钟级收割仅游标就要 1,440 写，必超；
D1 的 10 万写/天让免费计划跑 1 分钟级收割毫无压力——**频率只影响捕获延迟，不构成额度压力**。

## 日常运维

| 操作 | 方法 |
|---|---|
| 升级版本 | 从上游同步：`git pull https://github.com/lbls741/ServerMoe main` → 解决冲突 → `git push`；Workers Builds 自动构建部署 |
| 看实时日志 | `bunx wrangler tail`，或控制台 Workers & Pages → servermoe → Logs |
| 立即收割一次 | 管理页「入站轮询 → 立即收割」（跳过节拍门控） |
| 查询数据 | `bunx wrangler d1 execute servermoe --remote --command "SELECT id,status FROM accounts"` |
| 凭据失效（errcode -14） | 账号自动标记 `rebind_needed` 并熔断，管理页重新扫码即可 |
| 24h 窗口过期 | 用户回复任意消息自动恢复；可开启「临期提醒」在到期前收到提醒 |
| 验证资源绑定 | `bunx wrangler d1 list`；DO 绑定在 wrangler.jsonc（部署时已回填真实 ID） |

## 常见问题

**Q：构建失败了？**
看构建日志定位。常见原因：GitHub App 未授权到你的克隆仓库；手动改过 `wrangler.jsonc` 导致格式错误
（`wrangler.jsonc` 是 JSONC，支持注释）；Worker 名称在控制台被改名而与配置里的 `name` 不一致
（两者必须一致，否则构建失败）。

**Q：部署成功但打开页面 404 / 1101？**
404：确认访问的是向导给出的 workers.dev 地址；1101（Worker 抛异常）：看实时日志，
最常见原因是 D1 绑定异常——一键部署通常不会发生，手动部署则多半是 `database_id` 没有替换。

**Q：扫码后收不到推送？**
按顺序检查：① 微信里是否已发过至少一条消息（预热）；② 管理页「入站轮询」间隔是否太长，
先点「立即收割」再发一条推送测试；③ 账号状态是否 `rebind_needed`（需重扫）；
④ 最后入站时间是否超过 24h（窗口过期，回复 bot 任意消息即可恢复）。

**Q：推送延迟太高？**
推送本身的 API 延迟是秒级；延迟主要来自「微信消息捕获」（关键词路由、预热补发），
把收割间隔调小（cron 最低 60s）或切 `do` 模式（最低 10s）。对外推送（应用→微信）不受影响。

**Q：能绑定几个微信号？**
默认席位 5 个（`MOE_SEAT_LIMIT` 变量可调）。每个微信号的 ClawBot 只能绑定一个机器人。

**Q：想删掉重来？**
控制台删除 Worker（Workers & Pages → servermoe → Delete）与 D1 数据库（Storage & Databases → D1），
再删掉你 GitHub 账号里的克隆仓库；重新点部署按钮即可。

## 与官方 Deploy 按钮机制的对应关系

供了解原理：按钮入口是 `https://deploy.workers.cloudflare.com/?url=<仓库地址>`；
Cloudflare 读取仓库根部的 `wrangler.jsonc` 识别资源需求并自动预置（D1、Durable Object 等），
把真实资源 ID 写回你账号里的配置；`.env.example` 中的密钥条目会成为配置界面的填写提示；
`package.json` 的 `cloudflare.bindings.<名称>.description` 生成界面上的说明文字；
部署与后续 `git push` 的自动构建由 Workers Builds 执行（deploy 命令取自 `package.json` 的
`"deploy": "wrangler deploy"`）。

// 管理页（零构建 SSR + 原生 JS）。M4 范围：账号状态、绑定向导、关键词管理、
// 未命中提醒设置、收发日志、sendkey 轮换。绑定推进由服务端驱动，前端仅读视图。
// 更新提示条：首屏状态由服务端内嵌 __MOE_UPDATE__，后续随 /api/v1 响应头 X-Moe-Update 刷新。

import type { UpdatePayload } from "../update/checker.ts";

export function renderIndex(update?: UpdatePayload): string {
  const initScript =
    "window.__MOE_UPDATE__=" + (update ? JSON.stringify(update).replace(/</g, "\\u003c") : "null") + ";";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ServerMoe</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 0 0 10px; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  input, select, textarea, button { font-size: 13px; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; }
  textarea { width: 100%; box-sizing: border-box; }
  button { cursor: pointer; background: #2563eb; color: #fff; border: none; }
  button.ghost { background: #eee; color: #333; }
  button.danger { background: #dc2626; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .active { background: #dcfce7; } .paused { background: #fef9c3; } .rebind_needed { background: #fee2e2; }
  #qr { text-align: center; } #qr svg { width: 240px; height: 240px; }
  .muted { color: #888; font-size: 12px; }
  .err { color: #b91c1c; font-size: 13px; }
  code { background: #f4f4f5; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .key { font-size: 15px; letter-spacing: 1px; background: #f0fdf4; padding: 4px 8px; border-radius: 4px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
  .url { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .update-bar { max-height: 0; overflow: hidden; transition: max-height .35s ease; }
  .update-inner { display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
    border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; padding: 10px 12px;
    font-size: 13px; margin: 12px 0; box-sizing: border-box; }
  .update-inner.available { border-color: #16a34a; background: #f0fdf4; }
  .update-inner.error { border-color: #dc2626; background: #fef2f2; }
  .update-inner.selfbuild { border-color: #cbd5e1; background: #f8fafc; }
</style>
</head>
<body>
<div id="updateBar" class="update-bar" aria-live="polite"><div id="updateInner" class="update-inner"></div></div>
<h1>ServerMoe 网关</h1>

<section id="auth">
  <h2>管理令牌</h2>
  <div class="row">
    <input id="tok" type="password" placeholder="SSC_ADMIN_TOKEN" size="34">
    <button id="tokBtn">保存</button>
    <span class="muted">仅存于浏览器 localStorage</span>
  </div>
</section>

<section>
  <h2>账号状态 <span class="muted" id="seatInfo"></span></h2>
  <table><tbody id="accounts"><tr><td class="muted">加载中…</td></tr></tbody></table>
  <div id="keyOut"></div>
  <p class="muted">微信侧限制：用户最近一次发消息后 24 小时内 bot 才能主动推送，回复任意内容即可重置窗口。
  开启「临期提醒」后，网关会在窗口到期前按提前量向该账号发一条提醒（每个静默窗口至多一条）。</p>
</section>

<section>
  <h2>绑定新微信</h2>
  <button id="bindBtn">生成绑定二维码</button>
  <div id="qr"></div>
  <div id="bindStatus" class="muted"></div>
  <div id="verifyBox" hidden>
    <input id="code" placeholder="手机微信显示的配对数字" size="20">
    <button id="verifyBtn">提交配对码</button>
  </div>
  <div id="confirmBox" hidden><button id="confirmBtn">完成绑定并签发 sendkey</button></div>
  <div id="sendkeyBox" hidden>
    <p>绑定成功！sendkey（<b>仅显示一次</b>，请立即保存）：</p>
    <p><code id="sendkey"></code></p>
    <p class="muted">推送：<code>curl "http://&lt;host&gt;:8080/&lt;sendkey&gt;.send?title=hello"</code><br>
    首条推送前需在微信里给 ClawBot 发任意一条消息（预热），未预热会排队自动补发。</p>
  </div>
</section>

<section>
  <h2>关键词路由</h2>
  <div class="row">
    <span class="muted">账号</span>
    <select id="kwAccount"></select>
    <button class="ghost" id="kwRefresh">刷新</button>
  </div>
  <div class="row">
    <input id="kwText" placeholder="关键词" size="14">
    <select id="kwMode">
      <option value="prefix">prefix</option>
      <option value="exact">exact</option>
      <option value="contains">contains</option>
      <option value="regex">regex</option>
    </select>
    <input id="kwUrl" placeholder="https://your-app/hook" size="30">
    <input id="kwSecret" placeholder="HMAC 密钥（可选）" size="16">
    <button id="kwAdd">注册</button>
  </div>
  <table><tbody id="kwTable"><tr><td class="muted">—</td></tr></tbody></table>
  <p class="muted">命中后网关向 URL 转发 <code>{user_id, account_id, keyword, text, ts, msg_id}</code>；
  回复 <code>{"reply":"…"}</code> 即回发微信；带 secret 时附 HMAC 签名头。保留字：<code>help/status/bind/mail</code></p>
</section>

<section>
  <h2>未命中提醒</h2>
  <div class="row">
    <label><input type="checkbox" id="setRemind"> 微信消息未命中关键词时发送提醒</label>
  </div>
  <textarea id="setText" rows="2" placeholder="未识别的指令。发送 help 查看可用命令。"></textarea>
  <div class="row"><button id="setSave">保存设置</button><span id="setStatus" class="muted"></span></div>
</section>

<section>
  <h2>版本与更新</h2>
  <div class="row">
    <label><input type="checkbox" id="updEnabled"> 自动检测新版本（后端访问 GitHub Release）</label>
    <span class="muted">检测频率</span>
    <select id="updInterval">
      <option value="3600">每小时</option>
      <option value="21600">每 6 小时</option>
      <option value="43200">每 12 小时</option>
      <option value="86400" selected>每天</option>
      <option value="604800">每周</option>
    </select>
  </div>
  <div class="row"><button id="updSave">保存</button><span id="updStatus" class="muted"></span></div>
  <p class="muted" id="updInfo"></p>
</section>

<section>
  <h2>入站轮询（Workers）</h2>
  <div class="row">
    <span class="muted">策略</span><span id="pollMode">-</span>
    <span class="muted">间隔(秒)</span>
    <input type="number" id="pollInterval" min="60" max="86400" step="1" style="width:90px">
    <button id="pollSave">保存间隔</button>
    <button id="pollNow">立即收割</button>
    <span id="pollStatus" class="muted"></span>
  </div>
  <p class="muted" id="pollInfo">自部署（resident）由常驻 monitor 实时收割；Workers（cron/do）按此间隔定时收割，改间隔无需重新部署。D1 免费额度（10 万写/天）足以支撑 1 分钟级轮询。</p>
</section>

<section>
  <h2>邮件桥（可选）</h2>
  <div class="row">
    <span class="muted">账号</span><select id="mailAccount"></select>
    <label><input type="checkbox" id="mailEnabled"> 启用</label>
    <span class="muted">轮询间隔(秒)</span><input id="mailPoll" type="number" value="60" min="30" style="width:70px">
  </div>
  <p class="muted" style="margin:6px 0 2px">IMAP 收信</p>
  <div class="row">
    <input id="imapHost" placeholder="host" size="16"><input id="imapPort" type="number" value="993" style="width:70px">
    <label><input type="checkbox" id="imapSecure" checked> SSL</label>
    <input id="imapUser" placeholder="user" size="14"><input id="imapPass" type="password" placeholder="密码(留空保持)" size="14">
  </div>
  <p class="muted" style="margin:6px 0 2px">SMTP 发信</p>
  <div class="row">
    <input id="smtpHost" placeholder="host" size="16"><input id="smtpPort" type="number" value="465" style="width:70px">
    <label><input type="checkbox" id="smtpSecure" checked> SSL</label>
    <input id="smtpUser" placeholder="user" size="14"><input id="smtpPass" type="password" placeholder="密码(留空保持)" size="14">
    <input id="smtpFrom" placeholder="发件人(可选)" size="14">
  </div>
  <div class="row">
    <button id="mailSave">保存</button>
    <button class="ghost" id="mailPollNow">立即收信</button>
    <input id="mailTestTo" placeholder="测试收件人" size="18"><button class="ghost" id="mailTestSend">发测试邮件</button>
  </div>
  <div id="mailStatus" class="muted"></div>
</section>

<section>
  <h2>收发日志（最近 30 条）</h2>
  <button class="ghost" id="logRefresh">刷新</button>
  <table><tbody id="logIn"><tr><td class="muted">—</td></tr></tbody></table>
  <table style="margin-top:10px"><tbody id="logPush"><tr><td class="muted">—</td></tr></tbody></table>
</section>

<script>${initScript}</script>
<script>
const $ = (id) => document.getElementById(id);
const tok = () => localStorage.getItem("moe_admin") || "";
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmt = (ts) => ts ? new Date(ts).toLocaleString("zh-CN") : "—";
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts,
    headers: { "content-type": "application/json", authorization: "Bearer " + tok(), ...(opts.headers || {}) } });
  const v = r.headers.get("X-Moe-Update");
  if (v) { try { applyUpdateState(JSON.parse(v)); } catch (e) { /* 状态头异常不阻塞主流程 */ } }
  return r;
};
let accounts = [];
let curAccount = "";

// ---- 更新提示条 ----
let updateState = null;
function hideUpdateBar() { $("updateBar").style.maxHeight = "0px"; }
function showUpdateBar(html, cls) {
  const inner = $("updateInner");
  inner.className = "update-inner " + cls;
  inner.innerHTML = html;
  $("updateBar").style.maxHeight = inner.scrollHeight + "px";
}
function applyUpdateState(u) {
  updateState = u || null;
  renderUpdSettings();
  if (!u) { hideUpdateBar(); return; }
  if (u.kind === "selfbuilt") {
    showUpdateBar('<span>当前为<b>自构建版本</b>，更新检测不可用。如需接收新版本提醒，请改用官方 Docker 镜像或 Release 部署。</span>', "selfbuild");
    return;
  }
  if (u.kind === "available") {
    if (sessionStorage.getItem("moe_upd_dismissed") === "available:" + u.latest) { hideUpdateBar(); return; }
    showUpdateBar(
      '<span>🚀 <b>更新可用</b>：最新版本 <b>v' + esc(u.latest) + '</b>（当前 v' + esc(u.current) + '），' +
      '上次检测 ' + fmt(u.checkedAt) + '</span>' +
      '<button onclick="openRelease()">前往 Release 页</button>' +
      '<button class="ghost" onclick="dismissUpdate()">收起</button>', "available");
    return;
  }
  if (u.kind === "error") {
    if (sessionStorage.getItem("moe_upd_dismissed") === "error:") { hideUpdateBar(); return; }
    showUpdateBar(
      '<span>⚠️ <b>更新检测失败</b>：暂时无法访问 GitHub Release，将按检测频率自动重试。</span>' +
      '<button class="ghost" onclick="dismissUpdate()">收起</button>', "error");
    return;
  }
  hideUpdateBar();
}
window.openRelease = () => {
  if (updateState && updateState.url) window.open(updateState.url, "_blank", "noopener");
};
window.dismissUpdate = () => {
  if (updateState && (updateState.kind === "available" || updateState.kind === "error")) {
    sessionStorage.setItem("moe_upd_dismissed", updateState.kind + ":" + (updateState.latest || ""));
  }
  hideUpdateBar();
};
applyUpdateState(window.__MOE_UPDATE__ || null);

// ---- 版本与更新设置 ----
function renderUpdSettings() {
  const selfbuilt = Boolean(updateState && updateState.kind === "selfbuilt");
  $("updEnabled").disabled = selfbuilt;
  $("updInterval").disabled = selfbuilt;
  $("updSave").disabled = selfbuilt;
  if (selfbuilt) { $("updInfo").textContent = "自构建版本不参与更新检测。"; return; }
  const cur = updateState && updateState.current ? "v" + updateState.current : "—";
  const last = updateState && updateState.checkedAt ? "上次检测 " + fmt(updateState.checkedAt) : "尚未检测";
  $("updInfo").textContent = "当前版本 " + cur + " · " + last + " · 有新版本时页面顶部会展开提示";
}
$("updSave").onclick = async () => {
  const j = await (await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({
    update_check_enabled: $("updEnabled").checked ? "1" : "0",
    update_check_interval_sec: Number($("updInterval").value),
  }) })).json();
  $("updStatus").textContent = j.code === 0 ? "已保存 " + new Date().toLocaleTimeString("zh-CN") : "保存失败: " + j.message;
};

$("tok").value = tok();
$("tokBtn").onclick = () => { localStorage.setItem("moe_admin", $("tok").value.trim()); boot(); };

async function boot() {
  if (!tok()) { $("accounts").innerHTML = '<tr><td class="muted">请先在上方填入管理令牌并点「保存」</td></tr>'; return; }
  await loadAccounts();
  loadSettings();
  loadPoll();
  loadLogs();
  loadMail();
}

async function loadMail(force) {
  try {
    const sel = $("mailAccount");
    sel.innerHTML = accounts.map((s) => '<option value="' + s.accountId + '">' + s.accountId + '</option>').join("");
    if (!accounts.length) { $("mailStatus").textContent = "暂无绑定账号"; return; }
    if (force || !sel.value) sel.value = curAccount;
    const accountId = sel.value;
    const j = await (await api("/api/v1/admin/mail/" + accountId)).json();
    const m = j.mail || {};
    $("mailEnabled").checked = Boolean(m.enabled);
    $("mailPoll").value = m.pollSec || 60;
    const f = (prefix, cfg, passSet) => {
      $(prefix + "Host").value = cfg && cfg.host ? cfg.host : "";
      $(prefix + "Port").value = cfg && cfg.port ? cfg.port : "";
      $(prefix + "Secure").checked = cfg && cfg.secure !== false;
      $(prefix + "User").value = cfg && cfg.user ? cfg.user : "";
      $(prefix + "Pass").value = "";
      $(prefix + "Pass").placeholder = passSet ? "已保存(留空保持)" : "密码";
    };
    f("imap", m.imap, m.imap && m.imap.passSet);
    f("smtp", m.smtp, m.smtp && m.smtp.passSet);
    $("smtpFrom").value = m.from || "";
    $("mailStatus").textContent = m.configured
      ? ("最近收信 " + fmt(m.lastPollAt) + (m.lastError ? " · 错误: " + m.lastError : "") + " · 缓存 " + (m.cacheCount || 0) + " 封")
      : "未配置";
  } catch (e) { $("mailStatus").textContent = "加载失败: " + e; }
}
$("mailAccount").onchange = () => { loadMail(); };
$("mailSave").onclick = async () => {
  if (!$("imapHost").value.trim() && !$("smtpHost").value.trim()) { $("mailStatus").textContent = "请至少填写 IMAP 或 SMTP 主机"; return; }
  const pass = (prefix) => { const v = $(prefix).value; return v ? v : undefined; };
  const body = {
    accountId: $("mailAccount").value,
    enabled: $("mailEnabled").checked,
    pollSec: Number($("mailPoll").value) || 60,
    from: $("smtpFrom").value || undefined,
    imap: { host: $("imapHost").value.trim(), port: Number($("imapPort").value) || 993, secure: $("imapSecure").checked, user: $("imapUser").value.trim(), pass: pass("imapPass") },
    smtp: { host: $("smtpHost").value.trim(), port: Number($("smtpPort").value) || 465, secure: $("smtpSecure").checked, user: $("smtpUser").value.trim(), pass: pass("smtpPass") },
  };
  const j = await (await api("/api/v1/admin/mail/" + body.accountId, { method: "PUT", body: JSON.stringify(body) })).json();
  $("mailStatus").textContent = j.code === 0 ? "已保存并生效" : "保存失败: " + j.message;
  if (j.code === 0) loadMail();
};
$("mailPollNow").onclick = async () => {
  const j = await (await api("/api/v1/admin/mail/" + $("mailAccount").value + "/poll-now", { method: "POST" })).json();
  $("mailStatus").textContent = j.code === 0 ? "收信完成，新邮件 " + j.newMail + " 封" : "失败: " + j.message;
  loadLogs();
};
$("mailTestSend").onclick = async () => {
  const to = $("mailTestTo").value.trim();
  if (!to) { $("mailStatus").textContent = "请填测试收件人"; return; }
  const j = await (await api("/api/v1/admin/mail/" + $("mailAccount").value + "/send-test", { method: "POST", body: JSON.stringify({ to }) })).json();
  $("mailStatus").textContent = j.code === 0 ? j.message : "失败: " + j.message;
};

async function loadAccounts() {
  try {
    const r = await api("/api/v1/sessions");
    if (r.status === 401) { $("accounts").innerHTML = '<tr><td class="err">令牌无效（401）</td></tr>'; return; }
    const j = await r.json();
    accounts = j.sessions || [];
    $("seatInfo").textContent = j.seats ? "已用 " + j.seats.used + "/" + j.seats.limit + " 席位" : "";
    $("accounts").innerHTML = accounts.map((s, i) => {
      const w = s.warn || {};
      let win = "未预热";
      if (s.lastInboundAt) {
        const left = s.lastInboundAt + 86400000 - Date.now();
        win = left <= 0 ? "窗口已过期·回复即恢复" : "窗口剩 " + Math.floor(left / 3600000) + "h" + Math.floor((left % 3600000) / 60000) + "m";
      }
      return '<tr><td><b>' + s.accountId + '</b><br><span class="muted">' + s.baseUrl + '</span></td>' +
      '<td><span class="badge ' + s.status + '">' + s.status + '</span><br><span class="muted">入站 ' + fmt(s.lastInboundAt) + '<br>' + win + '</span></td>' +
      '<td>预热用户 ' + s.peers + '<br><span class="muted">关键词 ' + s.activeSendkeys + ' key</span></td>' +
      '<td><label><input type="checkbox" id="warnOn' + i + '"' + (w.enabled ? " checked" : "") + '> 临期提醒</label><br>' +
      '<input id="warnLead' + i + '" type="number" value="' + (w.leadSec ? w.leadSec / 60 : 30) + '" min="5" max="720" style="width:58px" title="窗口到期前多少分钟提醒"> <span class="muted">分钟前</span><br>' +
      '<input id="warnText' + i + '" placeholder="提醒文案（留空用默认）" size="22" value="' + esc(w.text || "") + '"><br>' +
      '<button class="ghost" onclick="saveWarn(' + i + ', this)">保存提醒设置</button></td>' +
      '<td><button class="ghost" onclick="resetKey(\\'' + s.accountId + '\\')">重置 sendkey</button> ' +
      '<button class="danger" onclick="unbind(\\'' + s.accountId + '\\')">解绑</button></td></tr>';
    }).join("") || '<tr><td class="muted">暂无绑定，请在下方完成绑定向导</td></tr>';
    const sel = $("kwAccount");
    sel.innerHTML = accounts.map((s) => '<option value="' + s.accountId + '">' + s.accountId + '</option>').join("");
    if (!accounts.find((s) => s.accountId === curAccount)) curAccount = accounts[0] ? accounts[0].accountId : "";
    sel.value = curAccount;
    loadKeywords();
  } catch (e) { $("accounts").innerHTML = '<tr><td class="err">请求失败: ' + e + '</td></tr>'; }
}
window.unbind = async (id) => { if (!confirm("解绑 " + id + "？其关键词与 sendkey 将一并吊销。")) return; await api("/api/v1/sessions/" + id, { method: "DELETE" }); loadAccounts(); };
window.resetKey = async (id) => {
  if (!confirm("重置 " + id + " 的 sendkey？旧 key 立即失效。")) return;
  const j = await (await api("/api/v1/sessions/" + id + "/reset-key", { method: "POST" })).json();
  if (j.code === 0) $("keyOut").innerHTML = '<p>新 sendkey（<b>仅显示一次</b>）：<code class="key">' + j.sendkey + '</code></p>';
  else $("keyOut").innerHTML = '<p class="err">重置失败: ' + j.message + '</p>';
};
window.saveWarn = async (i, btn) => {
  const s = accounts[i];
  if (!s) return;
  const body = {
    enabled: $("warnOn" + i).checked,
    text: $("warnText" + i).value,
    leadSec: (Number($("warnLead" + i).value) || 30) * 60,
  };
  const j = await (await api("/api/v1/sessions/" + encodeURIComponent(s.accountId) + "/warn", { method: "PUT", body: JSON.stringify(body) })).json();
  btn.textContent = j.code === 0 ? "已保存" : "失败";
  setTimeout(() => { btn.textContent = "保存提醒设置"; }, 1500);
};
$("kwAccount").onchange = () => { curAccount = $("kwAccount").value; loadKeywords(); };
$("kwRefresh").onclick = loadKeywords;

async function loadKeywords() {
  if (!curAccount) { $("kwTable").innerHTML = '<tr><td class="muted">—</td></tr>'; return; }
  try {
    const j = await (await api("/api/v1/keywords?accountId=" + curAccount)).json();
    $("kwTable").innerHTML = (j.keywords || []).map((k) =>
      '<tr><td><b>' + k.keyword + '</b></td><td>' + k.match + '</td><td class="url" title="' + k.url + '">' + k.url + '</td>' +
      '<td>' + (k.hasSecret ? "HMAC" : "—") + '</td>' +
      '<td><label><input type="checkbox" ' + (k.enabled ? "checked" : "") + ' onchange="kwToggle(' + k.id + ', this.checked)"> 启用</label></td>' +
      '<td><button class="danger" onclick="kwDel(' + k.id + ')">删除</button></td></tr>')
      .join("") || '<tr><td class="muted">该账号尚未注册关键词</td></tr>';
  } catch (e) { $("kwTable").innerHTML = '<tr><td class="err">' + e + '</td></tr>'; }
}
window.kwToggle = async (id, enabled) => { await api("/api/v1/keywords/" + id, { method: "PATCH", body: JSON.stringify({ enabled, accountId: curAccount }) }); loadKeywords(); };
window.kwDel = async (id) => { if (!confirm("删除该关键词？")) return; await api("/api/v1/keywords/" + id + "?accountId=" + curAccount, { method: "DELETE" }); loadKeywords(); };
$("kwAdd").onclick = async () => {
  const body = { accountId: curAccount, keyword: $("kwText").value.trim(), match: $("kwMode").value, url: $("kwUrl").value.trim() };
  if ($("kwSecret").value.trim()) body.secret = $("kwSecret").value.trim();
  const j = await (await api("/api/v1/keywords", { method: "POST", body: JSON.stringify(body) })).json();
  if (j.code === 0) { $("kwText").value = ""; $("kwUrl").value = ""; $("kwSecret").value = ""; loadKeywords(); }
  else alert("注册失败: " + j.message);
};

async function loadSettings() {
  try {
    const j = await (await api("/api/v1/admin/settings")).json();
    if (j.code !== 0) return;
    $("setRemind").checked = j.no_match_remind === "1";
    $("setText").value = j.no_match_text || "";
    $("updEnabled").checked = j.update_check_enabled !== "0";
    const iv = String(j.update_check_interval_sec || 86400);
    if ($("updInterval").querySelector('option[value="' + iv + '"]')) $("updInterval").value = iv;
  } catch {}
}
$("setSave").onclick = async () => {
  const j = await (await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({
    no_match_remind: $("setRemind").checked ? "1" : "0",
    no_match_text: $("setText").value,
  }) })).json();
  $("setStatus").textContent = j.code === 0 ? "已保存 " + new Date().toLocaleTimeString("zh-CN") : "保存失败: " + j.message;
};

async function loadPoll() {
  try {
    const j = await (await api("/api/v1/admin/settings")).json();
    if (j.code !== 0) return;
    $("pollMode").textContent = j.ingest_mode + (j.ondemand_harvest === "on" ? " + 按需收割" : "");
    $("pollInterval").value = j.poll_interval_sec;
    $("pollInfo").textContent = j.ingest_mode === "resident"
      ? "常驻 monitor 实时收割（自部署形态）"
      : j.poll_last_wake_at
        ? "上次收割: " + new Date(j.poll_last_wake_at).toLocaleString("zh-CN")
        : "尚未收割（等待下一次 scheduled 唤醒或点「立即收割」）";
  } catch {}
}
$("pollSave").onclick = async () => {
  const j = await (await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({
    poll_interval_sec: Number($("pollInterval").value),
  }) })).json();
  $("pollStatus").textContent = j.code === 0 ? "已保存" : "保存失败: " + j.message;
  loadPoll();
};
$("pollNow").onclick = async () => {
  $("pollStatus").textContent = "收割中…";
  try {
    const j = await (await api("/api/v1/admin/ingest/poll-now", { method: "POST" })).json();
    $("pollStatus").textContent = j.code === 0 ? "已收割 " + ((j.harvests || []).length) + " 个账号" : j.message;
  } catch (e) { $("pollStatus").textContent = "触发失败: " + e; }
  loadPoll();
};

async function loadLogs() {
  try {
    const j = await (await api("/api/v1/admin/logs")).json();
    if (j.code !== 0) return;
    $("logIn").innerHTML = '<tr><th>入站</th><th>动作</th><th>时间</th></tr>' + (j.inbound || []).map((l) =>
      '<tr><td>' + l.fromUserId + '：' + String(l.text).slice(0, 40) + '</td><td>' + l.action + (l.matchedKeywordId ? " #" + l.matchedKeywordId : "") + '</td><td>' + fmt(l.ts) + '</td></tr>').join("") ||
      '<tr><td class="muted">暂无</td></tr>';
    $("logPush").innerHTML = '<tr><th>推送</th><th>状态</th><th>时间</th></tr>' + (j.push || []).map((l) =>
      '<tr><td>' + String(l.title).slice(0, 40) + '</td><td>' + l.status + (l.error ? ' <span class="err">' + l.error + '</span>' : "") + '</td><td>' + fmt(l.ts) + '</td></tr>').join("") ||
      '<tr><td class="muted">暂无</td></tr>';
  } catch (e) { /* 静默 */ }
}
$("logRefresh").onclick = loadLogs;

let sessionId = null;
let polling = false;
$("bindBtn").onclick = async () => {
  try {
    const r = await api("/api/v1/login/start", { method: "POST" });
    const j = await r.json();
    if (j.code !== 0) { $("bindStatus").textContent = "发起失败: " + j.message; return; }
    sessionId = j.sessionId;
    $("sendkeyBox").hidden = true; $("confirmBox").hidden = true; $("verifyBox").hidden = true;
    $("qr").innerHTML = '<img alt="二维码" src="/api/v1/login/qr.svg?sessionId=' + sessionId + '&token=' + encodeURIComponent(tok()) + '">';
    $("bindStatus").textContent = "[wait] 请用手机微信扫描二维码";
    pollLoop();
  } catch (e) { $("bindStatus").textContent = "发起异常: " + e; }
};

async function pollLoop() {
  if (polling || !sessionId) return;
  polling = true;
  while (sessionId) {
    try {
      const r = await api("/api/v1/login/poll?sessionId=" + sessionId);
      const j = await r.json();
      $("bindStatus").textContent = "[" + j.status + "] " + (j.message || "");
      if (j.status === "need_verifycode") $("verifyBox").hidden = false;
      if (j.status === "scaned") $("verifyBox").hidden = true;
      if (j.status === "confirmed") { $("confirmBox").hidden = false; break; }
      if (j.status === "failed" || j.status === "expired") break;
    } catch (e) { $("bindStatus").textContent = "轮询异常（继续）: " + e; }
    await new Promise((r2) => setTimeout(r2, 1200));
  }
  polling = false;
}
$("verifyBtn").onclick = async () => {
  try {
    const r = await api("/api/v1/login/verify", { method: "POST", body: JSON.stringify({ sessionId, code: $("code").value.trim() }) });
    const j = await r.json();
    $("bindStatus").textContent = "[" + j.status + "] 已提交配对码，等待确认";
  } catch (e) { $("bindStatus").textContent = "提交异常: " + e; }
};
$("confirmBtn").onclick = async () => {
  try {
    const r = await api("/api/v1/login/confirm", { method: "POST", body: JSON.stringify({ sessionId }) });
    const j = await r.json();
    if (j.code !== 0) { $("bindStatus").textContent = "绑定失败: " + j.message; return; }
    $("qr").innerHTML = ""; $("confirmBox").hidden = true;
    $("sendkeyBox").hidden = false; $("sendkey").textContent = j.sendkey;
    sessionId = null;
    loadAccounts();
  } catch (e) { $("bindStatus").textContent = "完成异常: " + e; }
};
boot();
</script>
</body>
</html>`;
}

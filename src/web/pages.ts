// 管理页（零构建 SSR + 原生 JS）。M4 范围：账号状态、绑定向导、关键词管理、
// 未命中提醒设置、收发日志、sendkey 轮换。绑定推进由服务端驱动，前端仅读视图。

export function renderIndex(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SuperServerChan</title>
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
</style>
</head>
<body>
<h1>SuperServerChan 网关</h1>

<section id="auth">
  <h2>管理令牌</h2>
  <div class="row">
    <input id="tok" type="password" placeholder="SSC_ADMIN_TOKEN" size="34">
    <button id="tokBtn">保存</button>
    <span class="muted">仅存于浏览器 localStorage</span>
  </div>
</section>

<section>
  <h2>账号状态</h2>
  <table><tbody id="accounts"><tr><td class="muted">加载中…</td></tr></tbody></table>
  <div id="keyOut"></div>
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
  <h2>收发日志（最近 30 条）</h2>
  <button class="ghost" id="logRefresh">刷新</button>
  <table><tbody id="logIn"><tr><td class="muted">—</td></tr></tbody></table>
  <table style="margin-top:10px"><tbody id="logPush"><tr><td class="muted">—</td></tr></tbody></table>
</section>

<script>
const $ = (id) => document.getElementById(id);
const tok = () => localStorage.getItem("ssc_admin") || "";
const api = (path, opts = {}) => fetch(path, { ...opts,
  headers: { "content-type": "application/json", authorization: "Bearer " + tok(), ...(opts.headers || {}) } });
const fmt = (ts) => ts ? new Date(ts).toLocaleString("zh-CN") : "—";
let accounts = [];
let curAccount = "";

$("tok").value = tok();
$("tokBtn").onclick = () => { localStorage.setItem("ssc_admin", $("tok").value.trim()); boot(); };

async function boot() {
  if (!tok()) { $("accounts").innerHTML = '<tr><td class="muted">请先在上方填入管理令牌并点「保存」</td></tr>'; return; }
  await loadAccounts();
  loadSettings();
  loadLogs();
}

async function loadAccounts() {
  try {
    const r = await api("/api/v1/sessions");
    if (r.status === 401) { $("accounts").innerHTML = '<tr><td class="err">令牌无效（401）</td></tr>'; return; }
    const j = await r.json();
    accounts = j.sessions || [];
    $("accounts").innerHTML = accounts.map((s) =>
      '<tr><td><b>' + s.accountId + '</b><br><span class="muted">' + s.baseUrl + '</span></td>' +
      '<td><span class="badge ' + s.status + '">' + s.status + '</span><br><span class="muted">入站 ' + fmt(s.lastInboundAt) + '</span></td>' +
      '<td>预热用户 ' + s.peers + '<br><span class="muted">关键词 ' + s.activeSendkeys + ' key</span></td>' +
      '<td><button class="ghost" onclick="resetKey(\\'' + s.accountId + '\\')">重置 sendkey</button> ' +
      '<button class="danger" onclick="unbind(\\'' + s.accountId + '\\')">解绑</button></td></tr>')
      .join("") || '<tr><td class="muted">暂无绑定，请在下方完成绑定向导</td></tr>';
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
  } catch {}
}
$("setSave").onclick = async () => {
  const j = await (await api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify({
    no_match_remind: $("setRemind").checked ? "1" : "0",
    no_match_text: $("setText").value,
  }) })).json();
  $("setStatus").textContent = j.code === 0 ? "已保存 " + new Date().toLocaleTimeString("zh-CN") : "保存失败: " + j.message;
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

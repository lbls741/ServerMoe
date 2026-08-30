// 极简管理页（M2 范围）：绑定向导 + 账号状态。完整 UI（关键词/设置/日志）在 M4。
// 绑定推进由服务端驱动，本页轮询仅为读视图（毫秒级），任何前端故障都不影响绑定。

export function renderIndex(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SuperServerChan</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 8px; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  input, button { font-size: 14px; padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; }
  button { cursor: pointer; background: #2563eb; color: #fff; border: none; }
  button.ghost { background: #eee; color: #333; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .active { background: #dcfce7; } .paused { background: #fef9c3; } .rebind_needed { background: #fee2e2; }
  #qr { text-align: center; } #qr svg { width: 240px; height: 240px; }
  .muted { color: #888; font-size: 12px; }
  .err { color: #b91c1c; font-size: 13px; }
  code { background: #f4f4f5; padding: 1px 5px; border-radius: 4px; }
  #sendkey { font-size: 15px; letter-spacing: 1px; }
</style>
</head>
<body>
<h1>SuperServerChan 网关</h1>

<section id="auth">
  <h2>管理令牌</h2>
  <input id="tok" type="password" placeholder="SSC_ADMIN_TOKEN" size="34">
  <button id="tokBtn">保存</button>
  <span class="muted">仅存于浏览器 localStorage</span>
</section>

<section>
  <h2>账号状态</h2>
  <button class="ghost" id="refreshBtn">刷新</button>
  <table><tbody id="accounts"></tbody></table>
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

<script>
const $ = (id) => document.getElementById(id);
const tok = () => localStorage.getItem("ssc_admin") || "";
const api = (path, opts = {}) => fetch(path, { ...opts,
  headers: { "content-type": "application/json", authorization: "Bearer " + tok(), ...(opts.headers || {}) } });

$("tok").value = tok();
$("tokBtn").onclick = () => { localStorage.setItem("ssc_admin", $("tok").value.trim()); loadAccounts(); };

async function loadAccounts() {
  if (!tok()) { $("accounts").innerHTML = '<tr><td class="muted">请先在上方填入管理令牌并点「保存」</td></tr>'; return; }
  try {
    const r = await api("/api/v1/sessions");
    if (r.status === 401) { $("accounts").innerHTML = '<tr><td class="err">令牌无效（401）</td></tr>'; return; }
    const j = await r.json();
    $("accounts").innerHTML = (j.sessions || []).map((s) =>
      '<tr><td>' + s.accountId + '</td><td><span class="badge ' + s.status + '">' + s.status + '</span></td>' +
      '<td>预热用户 ' + s.peers + '</td><td><button class="ghost" onclick="unbind(\\'' + s.accountId + '\\')">解绑</button></td></tr>')
      .join("") || '<tr><td class="muted">暂无绑定</td></tr>';
  } catch (e) { $("accounts").innerHTML = '<tr><td class="err">请求失败: ' + e + '</td></tr>'; }
}
window.unbind = async (id) => { if (!confirm("解绑 " + id + "？")) return; await api("/api/v1/sessions/" + id, { method: "DELETE" }); loadAccounts(); };
$("refreshBtn").onclick = loadAccounts;

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
loadAccounts();
</script>
</body>
</html>`;
}

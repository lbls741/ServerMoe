// 邮件桥：每账号 IMAP 轮询收信 → 推送摘要到微信；`mail` 关键词命令读信/发信。
// 收发后端可注入（测试用假后端离线运行）；默认实现 imapflow + nodemailer。
// v1 仅支持 IMAP；POP3 为后续可选扩展。

import { decryptString, encryptString, randomId } from "../crypto.ts";
import type { Core } from "../core.ts";
import type { PushService } from "../core/push.ts";
import { getAccount } from "../repo/accounts.ts";
import {
  decryptMailConfig,
  deleteMailConfig,
  getMailConfigRow,
  listEnabledMailAccounts,
  updateMailState,
  upsertMailConfig,
  type MailConfig,
  type MailServerConfig,
} from "../repo/mail.ts";

export interface ParsedMailLite {
  uid: number;
  from: string;
  subject: string;
  date: string;
  /** 正文纯文本（已截断，用于 mail <n> 阅读） */
  text: string;
}

export interface ImapFetchResult {
  uidValidity: string;
  messages: ParsedMailLite[];
  maxUid: number;
}

/** IMAP 拉取：返回 uidValidity 与大于 lastUid 的新邮件（首次调用期望跳过历史）。 */
export type ImapFetch = (
  cfg: MailServerConfig,
  lastUid: number | null,
  uidValidity: string | null,
) => Promise<ImapFetchResult>;

export type SmtpSend = (
  cfg: MailServerConfig,
  from: string | null,
  msg: { to: string; subject: string; body: string },
) => Promise<void>;

export interface MailBackendDeps {
  imapFetch?: ImapFetch;
  smtpSend?: SmtpSend;
}

const CACHE_LIMIT = 20;
const BODY_LIMIT = 2000;

function defaultImapFetch(): ImapFetch {
  return async (cfg, lastUid, uidValidity) => {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      const mailbox = client.mailbox || null;
      const newValidity = String(mailbox?.uidValidity ?? "");
      try {
        if (lastUid === null || uidValidity === null || newValidity !== uidValidity) {
          // 首次接入或邮箱 UID 有效性变化：跳过历史，仅记录当前水位
          const all = await client.search({ uid: "1:*" }, { uid: true });
          const maxUid = all && all.length ? Math.max(...all) : 0;
          return { uidValidity: newValidity, messages: [], maxUid };
        }
        const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).filter((u) => u > lastUid);
        const messages: ParsedMailLite[] = [];
        let maxUid = lastUid;
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source ?? Buffer.alloc(0));
          const fromAddr = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? "(未知发件人)";
          const rawText = parsed.text || (parsed.html || "").replace(/<[^>]+>/g, " ");
          messages.push({
            uid: msg.uid,
            from: fromAddr,
            subject: parsed.subject || "(无主题)",
            date: (parsed.date ?? new Date()).toLocaleString("zh-CN"),
            text: rawText.replace(/\s+/g, " ").trim().slice(0, BODY_LIMIT),
          });
          if (msg.uid > maxUid) maxUid = msg.uid;
        }
        return { uidValidity: newValidity, messages, maxUid };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  };
}

function defaultSmtpSend(): SmtpSend {
  return async (cfg, from, msg) => {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass } });
    try {
      await transporter.sendMail({ from: from || cfg.user, to: msg.to, subject: msg.subject, text: msg.body });
    } finally {
      transporter.close();
    }
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export function createMailService(core: Core, push: PushService, deps: MailBackendDeps = {}) {
  const imapFetch = deps.imapFetch ?? defaultImapFetch();
  const smtpSend = deps.smtpSend ?? defaultSmtpSend();
  const cache = new Map<string, ParsedMailLite[]>();
  const pollers = new Map<string, AbortController>();
  const log = core.log.child({ mod: "mail" });

  function configOf(accountId: string): MailConfig | undefined {
    const row = getMailConfigRow(core.db, accountId);
    if (!row) return undefined;
    try {
      return decryptMailConfig(core.db, core.masterKey, row);
    } catch {
      log.error("mail config decrypt failed", { accountId });
      return undefined;
    }
  }

  function pushCache(accountId: string, msg: ParsedMailLite): void {
    const arr = cache.get(accountId) ?? [];
    arr.push(msg);
    if (arr.length > CACHE_LIMIT) arr.shift();
    cache.set(accountId, arr);
  }

  /** 单次 IMAP 轮询：拉新邮件 → 缓存 → 推送摘要。返回新邮件数。 */
  async function pollOnce(accountId: string): Promise<number> {
    const cfg = configOf(accountId);
    if (!cfg) return 0;
    try {
      const result = await imapFetch(cfg.imap, cfg.lastUid ?? null, cfg.uidValidity ?? null);
      updateMailState(core.db, accountId, {
        uidValidity: result.uidValidity,
        lastUid: result.maxUid,
        lastPollAt: Date.now(),
        lastError: null,
      });
      for (const m of result.messages) {
        pushCache(accountId, m);
        const account = getAccount(core.db, accountId);
        const peer = account?.ownerUserId;
        if (peer) {
          await push.push({
            accountId,
            peerUserId: peer,
            title: `📧 ${m.subject.slice(0, 60)}`,
            desp: `来自 ${m.from}\n\n${m.text.slice(0, 300)}`,
          });
        }
      }
      return result.messages.length;
    } catch (err) {
      updateMailState(core.db, accountId, { lastPollAt: Date.now(), lastError: String(err).slice(0, 200) });
      log.warn("imap poll failed", { accountId, err: String(err).slice(0, 120) });
      return 0;
    }
  }

  function startPoller(accountId: string): void {
    stopPoller(accountId);
    const cfg = configOf(accountId);
    if (!cfg?.enabled) return;
    const controller = new AbortController();
    pollers.set(accountId, controller);
    const interval = Math.max(30, cfg.pollSec) * 1000;
    void (async () => {
      while (!controller.signal.aborted) {
        await pollOnce(accountId);
        try {
          await sleep(interval, controller.signal);
        } catch {
          break;
        }
      }
    })().finally(() => pollers.delete(accountId));
    log.info("mail poller started", { accountId, intervalMs: interval });
  }

  function stopPoller(accountId: string): void {
    pollers.get(accountId)?.abort();
    pollers.delete(accountId);
  }

  function startAll(): void {
    for (const id of listEnabledMailAccounts(core.db)) startPoller(id);
  }

  function restart(accountId: string): void {
    startPoller(accountId); // startPoller 内部先 stop，且 disabled 时不启动
  }

  async function shutdown(): Promise<void> {
    for (const c of pollers.values()) c.abort();
    pollers.clear();
  }

  // ---- 配置持久化（供 admin API 使用） ----

  function view(accountId: string) {
    const row = getMailConfigRow(core.db, accountId);
    if (!row) return { enabled: false, configured: false };
    return {
      enabled: row.enabled,
      configured: true,
      imap: { ...JSON.parse(decryptString(core.masterKey, row.imapEnc)), pass: undefined, passSet: true },
      smtp: { ...JSON.parse(decryptString(core.masterKey, row.smtpEnc)), pass: undefined, passSet: true },
      from: row.from,
      pollSec: row.pollSec,
      lastPollAt: row.lastPollAt,
      lastError: row.lastError,
      cacheCount: cache.get(accountId)?.length ?? 0,
    };
  }

  function saveConfig(accountId: string, body: {
    enabled?: boolean;
    pollSec?: number;
    from?: string;
    imap?: Partial<MailServerConfig>;
    smtp?: Partial<MailServerConfig>;
  }): void {
    const existing = configOf(accountId);
    const merge = (old?: MailServerConfig, next?: Partial<MailServerConfig>): MailServerConfig => ({
      host: next?.host ?? old?.host ?? "",
      port: next?.port ?? old?.port ?? 993,
      secure: next?.secure ?? old?.secure ?? true,
      user: next?.user ?? old?.user ?? "",
      pass: next?.pass ?? old?.pass ?? "",
    });
    const imap = merge(existing?.imap, body.imap);
    const smtp = merge(existing?.smtp, body.smtp);
    upsertMailConfig(core.db, {
      accountId,
      imapEnc: encryptString(core.masterKey, JSON.stringify(imap)),
      smtpEnc: encryptString(core.masterKey, JSON.stringify(smtp)),
      from: body.from ?? existing?.from ?? null,
      pollSec: body.pollSec ?? existing?.pollSec ?? 60,
      enabled: body.enabled ?? existing?.enabled ?? true,
    });
    restart(accountId);
  }

  async function removeConfig(accountId: string): Promise<void> {
    stopPoller(accountId);
    cache.delete(accountId);
    deleteMailConfig(core.db, accountId);
  }

  async function sendTest(accountId: string, to: string): Promise<void> {
    const cfg = configOf(accountId);
    if (!cfg) throw new Error("邮件桥未配置");
    await smtpSend(cfg.smtp, cfg.from, { to, subject: "SuperServerChan SMTP 测试", body: `这是一封测试邮件，发自网关 (${randomId().slice(0, 8)})。` });
  }

  // ---- `mail` 关键词命令 ----

  function handleCommand(accountId: string, text: string): string {
    const cfg = configOf(accountId);
    const m = text.match(/^mail(?::|\s+)?(.*)$/i);
    const rest = (m?.[1] ?? "").trim();

    if (!cfg) return "邮件桥未启用。请管理员在管理页配置 IMAP/SMTP 后使用。";

    if (!rest || rest.toLowerCase() === "help") {
      return [
        "邮件桥指令：",
        "  mail:list - 列出最近收件",
        "  mail <n> - 阅读第 n 封",
        "  mail:send to=a@b.c subject=标题 body=正文",
        "  mail:status - 收信状态",
      ].join("\n");
    }

    const lower = rest.toLowerCase();
    if (lower === "list") {
      const arr = cache.get(accountId) ?? [];
      if (arr.length === 0) return "暂无缓存的邮件（网关启动后才会累积）。";
      return arr
        .map((msg, i) => {
          const idx = arr.length - i;
          return `${idx}. [${msg.from}] ${msg.subject} (${msg.date})`;
        })
        .join("\n");
    }

    if (lower === "status") {
      const row = getMailConfigRow(core.db, accountId);
      return [
        `邮件桥: ${cfg.enabled ? "已启用" : "已停用"}`,
        `IMAP: ${cfg.imap.user}@${cfg.imap.host}`,
        `最近收信: ${row?.lastPollAt ? new Date(row.lastPollAt).toLocaleString("zh-CN") : "从未"}`,
        `最后错误: ${row?.lastError ?? "无"}`,
        `缓存邮件: ${cache.get(accountId)?.length ?? 0} 封`,
      ].join("\n");
    }

    if (/^\d+$/.test(rest)) {
      const arr = cache.get(accountId) ?? [];
      const idx = arr.length - Number(rest);
      const msg = idx >= 0 && idx < arr.length ? arr[idx] : undefined;
      if (!msg) return `没有第 ${rest} 封（当前缓存 ${arr.length} 封，mail:list 查看）。`;
      return `来自: ${msg.from}\n主题: ${msg.subject}\n时间: ${msg.date}\n\n${msg.text}`;
    }

    if (lower.startsWith("send")) {
      const args: Record<string, string> = {};
      const re = /(\w+)=("[^"]*"|\S+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(rest)) !== null) args[mm[1]!.toLowerCase()] = mm[2]!.replace(/^"|"$/g, "");
      const to = args.to;
      const subject = args.subject ?? "(无主题)";
      const bodyText = args.body ?? args.text ?? "(空)";
      if (!to) return "用法: mail:send to=地址 subject=标题 body=正文";
      smtpSend(cfg.smtp, cfg.from, { to, subject, body: bodyText })
        .then(() => log.info("mail sent via command", { accountId, to }))
        .catch((err) => log.error("mail send failed", { accountId, err: String(err).slice(0, 160) }));
      return `已提交发送至 ${to}（subject: ${subject}），结果见后续消息/日志`;
    }

    return "未知 mail 子命令，发送 mail:help 查看用法。";
  }

  return { pollOnce, startPoller, stopPoller, startAll, shutdown, restart, view, saveConfig, removeConfig, sendTest, handleCommand };
}

export type MailService = ReturnType<typeof createMailService>;

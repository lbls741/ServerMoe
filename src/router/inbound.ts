// 入站路由总入口：内置命令 → 关键词转发 → 未命中提醒。
// 由 wechat 通道在捕获 context_token 之后调用（回发依赖该 token）。

import type { Core } from "../core.ts";
import { getAccount } from "../repo/accounts.ts";
import { addInboundLog } from "../repo/logs.ts";
import { listKeywords } from "../repo/keywords.ts";
import { getSetting } from "../repo/settings.ts";
import { createForwarder, type Forwarder } from "./forwarder.ts";
import { matchKeyword } from "./matcher.ts";
import { builtinReply, isReserved } from "./builtins.ts";

const DEFAULT_NO_MATCH_TEXT = "未识别的指令。发送 help 查看可用命令。";

export function createInboundRouter(core: Core) {
  const forwarder: Forwarder = createForwarder(core);

  async function handle(accountId: string, fromUserId: string, text: string, msgId?: string): Promise<void> {
    const db = core.db;
    const account = await getAccount(db, accountId);
    if (!account || !text.trim()) return;
    const ch = core.channels.get("wechat");
    if (!ch) return;
    const trimmed = text.trim();
    const now = Date.now();
    const reply = async (replyText: string): Promise<boolean> => {
      try {
        const res = await ch.send(accountId, fromUserId, replyText);
        return res.ok;
      } catch {
        return false;
      }
    };

    // 0. 邮件桥命令（保留字 mail 前缀，优先于关键词匹配）
    if (/^mail(?::|\s|$)/i.test(trimmed)) {
      const text = core.mail
        ? await core.mail.handleCommand(accountId, trimmed)
        : "邮件桥未启用。";
      const ok = await reply(text);
      await addInboundLog(db, { ts: now, accountId, fromUserId, text: trimmed, action: "builtin", reply: ok ? text : null });
      return;
    }

    // 1. 内置命令（保留字，exact 语义，最高优先级）
    const lower = trimmed.toLowerCase();
    if (isReserved(lower)) {
      const text = await builtinReply(lower, { account, db, keywords: await listKeywords(db, accountId) });
      if (text) {
        const ok = await reply(text);
        await addInboundLog(db, { ts: now, accountId, fromUserId, text: trimmed, action: "builtin", reply: ok ? text : null });
        return;
      }
    }

    // 2. 关键词匹配 → webhook 转发
    const keywords = (await listKeywords(db, accountId)).filter((k) => k.enabled);
    const hit = matchKeyword(trimmed, keywords);
    if (hit) {
      const result = await forwarder.forward(hit.url, hit.secretEnc, {
        user_id: fromUserId,
        account_id: accountId,
        keyword: hit.keyword,
        text: trimmed,
        ts: now,
        msg_id: msgId,
      });
      let replyText: string;
      let action: string;
      if (!result.ok) {
        replyText = `转发失败（${hit.keyword}）: ${result.error ?? "unknown"}`;
        action = "error";
      } else if (result.reply) {
        replyText = result.reply;
        action = "forwarded";
      } else {
        replyText = `已转发（${hit.keyword}）`;
        action = "forwarded";
      }
      const ok = await reply(replyText);
      await addInboundLog(db, {
        ts: Date.now(),
        accountId,
        fromUserId,
        text: trimmed,
        matchedKeywordId: hit.id,
        action: ok ? action : "error",
        reply: ok ? replyText : null,
      });
      return;
    }

    // 3. 未命中 → 可配置提醒（settings.no_match_remind = "0" 关闭）
    await addInboundLog(db, { ts: now, accountId, fromUserId, text: trimmed, action: "no_match" });
    if ((await getSetting(db, "no_match_remind")) !== "0") {
      const remindText = (await getSetting(db, "no_match_text")) || DEFAULT_NO_MATCH_TEXT;
      await reply(remindText).catch(() => {});
    }
  }

  return { handle };
}

export type InboundRouter = ReturnType<typeof createInboundRouter>;

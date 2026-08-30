import { randomId } from "../../crypto.ts";
import { MessageItemType, MessageState, MessageType } from "./ilink/types.ts";
import { WARMUP_RET, STALE_TOKEN_ERRCODE } from "./ilink/constants.ts";
import { sendMessage, IlinkApiError, type ApiCtx } from "./ilink/client.ts";

export type SendOutcome =
  | { ok: true; clientId: string }
  | { ok: false; reason: "WARMUP_REQUIRED" | "TOKEN_EXPIRED" | "ERROR"; error?: string };

/**
 * 发送一条纯文本消息。context_token 缺失时直接返回 WARMUP_REQUIRED（不浪费请求——
 * 官方虽会照发，但社区实测无 context 一律 ret=-2）。
 */
export async function sendText(ctx: ApiCtx, to: string, text: string, contextToken?: string): Promise<SendOutcome> {
  if (!contextToken) {
    return { ok: false, reason: "WARMUP_REQUIRED", error: "missing context_token (user has not messaged the bot yet)" };
  }
  const clientId = `ssc-${randomId()}`;
  try {
    await sendMessage(ctx, {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        context_token: contextToken,
      },
    });
    return { ok: true, clientId };
  } catch (err) {
    if (err instanceof IlinkApiError && err.kind === "api") {
      if (err.ret === WARMUP_RET) return { ok: false, reason: "WARMUP_REQUIRED", error: err.errmsg };
      if (err.ret === STALE_TOKEN_ERRCODE) return { ok: false, reason: "TOKEN_EXPIRED", error: err.errmsg };
      return { ok: false, reason: "ERROR", error: `ret=${err.ret} ${err.errmsg ?? ""}` };
    }
    return { ok: false, reason: "ERROR", error: String(err) };
  }
}

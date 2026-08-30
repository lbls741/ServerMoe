// iLink Bot API wire 类型。照抄自官方 MIT 源码 src/api/types.ts（M0 审计 §2），
// 仅保留本项目用到的字段。

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

export interface TextItem {
  text: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  /** 顶层 16 字节 hex 密钥，官方实现优先于 media.aes_key */
  aeskey?: string;
  mid_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  playtime?: number;
  /** 服务端语音转写文本 */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  /** 注意：官方定义 len 为字符串 */
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** 会话上下文令牌：回复/主动发送必须回传；仅随入站消息下发 */
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesReq {
  /** 整串同步游标；首次/重置传 "" */
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  sync_buf?: string;
  get_updates_buf?: string;
  /** 服务端建议的下次长轮询时长 */
  longpolling_timeout_ms?: number;
}

export interface SendMessageMsg {
  from_user_id?: string;
  to_user_id: string;
  client_id: string;
  message_type: number;
  message_state: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface SendMessageReq {
  msg: SendMessageMsg;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingReq {
  ilink_user_id: string;
  typing_ticket: string;
  status: number;
}

// ---- 扫码绑定 ----

export interface QrCodeResp {
  qrcode: string;
  /** 可渲染的二维码内容（URL） */
  qrcode_img_content: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResp {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

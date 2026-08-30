// 通道接口：多后端扩展点（dev-plan §1）。业务层只面向此接口，不感知微信协议细节。

export type SendResult =
  | { ok: true; clientId: string }
  | { ok: false; reason: "WARMUP_REQUIRED" | "TOKEN_EXPIRED" | "ERROR"; error?: string };

export interface LoginPollView {
  sessionId: string;
  status: string;
  qrcodeUrl: string;
  message?: string | null;
}

export interface ConfirmOutcome {
  accountId: string;
  sendkey: string;
  baseUrl?: string;
  ownerUserId?: string;
}

export interface ChannelAccountView {
  accountId: string;
  label: string;
  status: string;
  lastInboundAt: number | null;
}

export interface Channel {
  readonly id: string;
  /** 发起绑定：返回会话 id 与二维码内容（URL，由上层渲染）。服务端后台驱动绑定状态机。 */
  startLogin(): Promise<{ sessionId: string; qrcodeUrl: string }>;
  /** 读取绑定会话当前状态（纯 DB 读，毫秒级返回；推进由服务端驱动负责）。 */
  pollLogin(sessionId: string): Promise<LoginPollView>;
  /** 提交手机上显示的配对数字，驱动随后自动继续。 */
  submitVerifyCode(sessionId: string, code: string): Promise<LoginPollView>;
  /** 用已确认的会话落库账号并签发 sendkey（明文仅返回一次）。 */
  confirmLogin(sessionId: string): Promise<ConfirmOutcome>;
  startAccount(accountId: string): Promise<void>;
  stopAccount(accountId: string, reason?: string): Promise<void>;
  /** 彻底移除账号：停 monitor、吊销 sendkey、清理关键词/预热记录/凭据（解绑与重绑清理共用）。 */
  removeAccount(accountId: string): Promise<void>;
  send(accountId: string, peerUserId: string, text: string): Promise<SendResult>;
  listStatuses(): ChannelAccountView[];
  shutdown(): Promise<void>;
}

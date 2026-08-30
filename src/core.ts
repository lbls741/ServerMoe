// 平台接缝之外的共享依赖容器。业务模块（api/router/web）只通过 Core 访问状态与能力。

import type { Registry } from "./channels/registry.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Logger } from "./log.ts";
import type { MailService } from "./mail/service.ts";

export interface Core {
  cfg: Config;
  log: Logger;
  db: Db;
  masterKey: Buffer;
  /** sendkey 哈希盐（即 settings.crypto_salt） */
  salt: string;
  adminToken: string;
  channels: Registry;
  /** 邮件桥（可选，index.ts 装配；路由器据此响应 mail 关键词命令） */
  mail?: MailService;
}

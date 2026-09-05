// 引导边缘（平台无关部分）：盐 / admin token / 主密钥原料的「env 优先，否则生成并持久化」逻辑。
// 平台差异：自部署 secret 落 data/secret.key 文件（index.ts）；Workers 无文件系统，落 settings 表。

import { randomToken } from "../crypto.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../log.ts";
import { getSetting, setSetting } from "../repo/settings.ts";

/** sendkey 哈希盐（settings.crypto_salt）：首次生成后固定。 */
export async function ensureSalt(db: Db): Promise<string> {
  const existing = await getSetting(db, "crypto_salt");
  if (existing) return existing;
  const salt = randomToken(16);
  await setSetting(db, "crypto_salt", salt);
  return salt;
}

export interface SecretBootstrap {
  secret: string;
  /** true = 由本进程生成的 32 字节高熵随机值（Workers 端据此免 KDF 直 SHA-256） */
  generated: boolean;
}

/** admin token：MOE_ADMIN_TOKEN/SSC_ADMIN_TOKEN 优先，否则生成一次并落 settings（明文，仅此打印一次）。 */
export async function ensureAdminToken(db: Db, provided: string | undefined, log: Logger): Promise<string> {
  const existing = provided ?? (await getSetting(db, "admin_token"));
  if (existing) return existing;
  const adminToken = randomToken(24);
  await setSetting(db, "admin_token", adminToken);
  log.warn("MOE_ADMIN_TOKEN 未设置：已生成管理令牌，请立即保存", { adminToken });
  return adminToken;
}

/** 自部署主密钥原料：MOE_SECRET 优先，否则 data/secret.key（0600，随 data 卷持久化）。 */
export async function ensureSecretSelfhosted(
  db: Db,
  provided: string | undefined,
  readFile: (path: string) => string | undefined,
  writeFile: (path: string, content: string) => void,
  keyFilePath: string,
  log: Logger,
): Promise<SecretBootstrap> {
  if (provided) return { secret: provided, generated: false };
  const fromFile = readFile(keyFilePath);
  if (fromFile) return { secret: fromFile, generated: false };
  const secret = randomToken(32);
  writeFile(keyFilePath, `${secret}\n`);
  log.warn("MOE_SECRET 未设置：已生成随机主密钥文件；丢弃 data 卷将导致已存凭据无法解密", { keyFilePath });
  return { secret, generated: true };
}

/**
 * Workers 主密钥原料：MOE_SECRET（wrangler secret / vars）优先；未设置则生成后存 settings.master_secret。
 * 注意：DB 泄露即凭据可解密，生产环境务必 `wrangler secret put MOE_SECRET`（部署指南有说明）。
 */
export async function ensureSecretInDb(db: Db, provided: string | undefined, log: Logger): Promise<SecretBootstrap> {
  if (provided) return { secret: provided, generated: false };
  const existing = await getSetting(db, "master_secret");
  if (existing) return { secret: existing, generated: true };
  const secret = randomToken(32);
  await setSetting(db, "master_secret", secret);
  log.warn("MOE_SECRET 未设置：已生成随机主密钥并入库；建议改为 wrangler secret put MOE_SECRET 以获得与数据库解耦的主密钥");
  return { secret, generated: true };
}

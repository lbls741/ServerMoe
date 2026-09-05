import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { mailConfigs } from "../db/schema.ts";
import { decryptString } from "../crypto.ts";

export type MailConfigRow = typeof mailConfigs.$inferSelect;

export interface MailServerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface MailConfig extends MailConfigRow {
  imap: MailServerConfig;
  smtp: MailServerConfig;
}

export async function getMailConfigRow(db: Db, accountId: string): Promise<MailConfigRow | undefined> {
  return await db.select().from(mailConfigs).where(eq(mailConfigs.accountId, accountId)).get();
}

export async function listEnabledMailAccounts(db: Db): Promise<string[]> {
  return (await db.select().from(mailConfigs).all()).filter((r) => r.enabled).map((r) => r.accountId);
}

/** 解密出完整配置（含明文密码），仅供邮件服务内部使用。 */
export function decryptMailConfig(row: MailConfigRow, masterKey: Buffer): MailConfig {
  const imap = JSON.parse(decryptString(masterKey, row.imapEnc)) as MailServerConfig;
  const smtp = JSON.parse(decryptString(masterKey, row.smtpEnc)) as MailServerConfig;
  return { ...row, imap, smtp };
}

export async function upsertMailConfig(
  db: Db,
  row: {
    accountId: string;
    imapEnc: string;
    smtpEnc: string;
    from?: string | null;
    pollSec?: number;
    enabled?: boolean;
  },
): Promise<MailConfigRow> {
  const values = {
    accountId: row.accountId,
    imapEnc: row.imapEnc,
    smtpEnc: row.smtpEnc,
    from: row.from ?? null,
    pollSec: row.pollSec ?? 60,
    enabled: row.enabled ?? true,
  };
  return (await db
    .insert(mailConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: mailConfigs.accountId,
      // 更新时只覆盖配置字段，轮询状态（uidValidity/lastUid 等）经 updateMailState 单独维护
      set: {
        imapEnc: values.imapEnc,
        smtpEnc: values.smtpEnc,
        from: values.from,
        pollSec: values.pollSec,
        enabled: values.enabled,
      },
    })
    .returning()
    .get())!;
}

export async function updateMailState(
  db: Db,
  accountId: string,
  patch: Partial<Pick<MailConfigRow, "uidValidity" | "lastUid" | "lastPollAt" | "lastError" | "enabled">>,
): Promise<void> {
  await db.update(mailConfigs).set(patch).where(eq(mailConfigs.accountId, accountId)).run();
}

export async function deleteMailConfig(db: Db, accountId: string): Promise<void> {
  await db.delete(mailConfigs).where(eq(mailConfigs.accountId, accountId)).run();
}

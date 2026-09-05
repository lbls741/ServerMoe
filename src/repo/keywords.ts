import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { keywords } from "../db/schema.ts";

export type KeywordRow = typeof keywords.$inferSelect;
export type MatchMode = "exact" | "prefix" | "contains" | "regex";

export interface NewKeyword {
  accountId: string;
  keyword: string;
  matchMode: MatchMode;
  url: string;
  secretEnc?: string | null;
  now: number;
}

export async function createKeyword(db: Db, k: NewKeyword): Promise<KeywordRow> {
  return (await db
    .insert(keywords)
    .values({
      accountId: k.accountId,
      keyword: k.keyword,
      matchMode: k.matchMode,
      url: k.url,
      secretEnc: k.secretEnc ?? null,
      createdAt: k.now,
    })
    .returning()
    .get())!;
}

export async function getKeyword(db: Db, id: number): Promise<KeywordRow | undefined> {
  return await db.select().from(keywords).where(eq(keywords.id, id)).get();
}

export async function listKeywords(db: Db, accountId: string): Promise<KeywordRow[]> {
  return await db.select().from(keywords).where(eq(keywords.accountId, accountId)).orderBy(asc(keywords.id)).all();
}

export async function listAllKeywords(db: Db): Promise<KeywordRow[]> {
  return await db.select().from(keywords).orderBy(asc(keywords.id)).all();
}

export async function findKeywordByKeyword(db: Db, accountId: string, keyword: string): Promise<KeywordRow | undefined> {
  return await db
    .select()
    .from(keywords)
    .where(and(eq(keywords.accountId, accountId), eq(keywords.keyword, keyword)))
    .get();
}

export async function deleteKeyword(db: Db, accountId: string, id: number): Promise<void> {
  await db.delete(keywords).where(and(eq(keywords.accountId, accountId), eq(keywords.id, id))).run();
}

/** 账号解绑/清理时删除其全部关键词。 */
export async function deleteAccountKeywords(db: Db, accountId: string): Promise<void> {
  await db.delete(keywords).where(eq(keywords.accountId, accountId)).run();
}

export async function setKeywordEnabled(db: Db, accountId: string, id: number, enabled: boolean): Promise<void> {
  await db.update(keywords).set({ enabled }).where(and(eq(keywords.accountId, accountId), eq(keywords.id, id))).run();
}

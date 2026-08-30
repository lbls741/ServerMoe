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

export function createKeyword(db: Db, k: NewKeyword): KeywordRow {
  return db
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
    .get()!;
}

export function getKeyword(db: Db, id: number): KeywordRow | undefined {
  return db.select().from(keywords).where(eq(keywords.id, id)).get();
}

export function listKeywords(db: Db, accountId: string): KeywordRow[] {
  return db.select().from(keywords).where(eq(keywords.accountId, accountId)).orderBy(asc(keywords.id)).all();
}

export function listAllKeywords(db: Db): KeywordRow[] {
  return db.select().from(keywords).orderBy(asc(keywords.id)).all();
}

export function findKeywordByKeyword(db: Db, accountId: string, keyword: string): KeywordRow | undefined {
  return db.select().from(keywords).where(and(eq(keywords.accountId, accountId), eq(keywords.keyword, keyword))).get();
}

export function deleteKeyword(db: Db, accountId: string, id: number): void {
  db.delete(keywords).where(and(eq(keywords.accountId, accountId), eq(keywords.id, id))).run();
}

export function setKeywordEnabled(db: Db, accountId: string, id: number, enabled: boolean): void {
  db.update(keywords).set({ enabled }).where(and(eq(keywords.accountId, accountId), eq(keywords.id, id))).run();
}

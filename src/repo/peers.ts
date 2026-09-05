import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { peers } from "../db/schema.ts";

export type PeerRow = typeof peers.$inferSelect;

export async function upsertPeer(db: Db, accountId: string, userId: string, contextToken: string, now: number): Promise<void> {
  await db
    .insert(peers)
    .values({ accountId, userId, contextToken, updatedAt: now })
    .onConflictDoUpdate({
      target: [peers.accountId, peers.userId],
      set: { contextToken, updatedAt: now },
    })
    .run();
}

export async function getPeerToken(db: Db, accountId: string, userId: string): Promise<string | undefined> {
  const row = await db
    .select()
    .from(peers)
    .where(and(eq(peers.accountId, accountId), eq(peers.userId, userId)))
    .get();
  return row?.contextToken;
}

export async function listPeers(db: Db, accountId: string): Promise<PeerRow[]> {
  return await db.select().from(peers).where(eq(peers.accountId, accountId)).all();
}

export async function deleteAccountPeers(db: Db, accountId: string): Promise<void> {
  await db.delete(peers).where(eq(peers.accountId, accountId)).run();
}

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { peers } from "../db/schema.ts";

export type PeerRow = typeof peers.$inferSelect;

export function upsertPeer(db: Db, accountId: string, userId: string, contextToken: string, now: number): void {
  db.insert(peers)
    .values({ accountId, userId, contextToken, updatedAt: now })
    .onConflictDoUpdate({
      target: [peers.accountId, peers.userId],
      set: { contextToken, updatedAt: now },
    })
    .run();
}

export function getPeerToken(db: Db, accountId: string, userId: string): string | undefined {
  return db
    .select()
    .from(peers)
    .where(and(eq(peers.accountId, accountId), eq(peers.userId, userId)))
    .get()?.contextToken;
}

export function listPeers(db: Db, accountId: string): PeerRow[] {
  return db.select().from(peers).where(eq(peers.accountId, accountId)).all();
}

export function deleteAccountPeers(db: Db, accountId: string): void {
  db.delete(peers).where(eq(peers.accountId, accountId)).run();
}

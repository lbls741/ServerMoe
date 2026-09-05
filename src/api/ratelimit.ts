import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { rateBuckets } from "../db/schema.ts";

export interface RateLimiter {
  take(key: string | number, now?: number): Promise<boolean>;
  retryAfterSec(key: string | number): Promise<number>;
}

/** 每 sendkey 令牌桶：容量 burst，回填速率 perHour/小时（进程内存实现，自部署形态）。 */
export function createRateLimiter(perHour: number, burst: number): RateLimiter {
  const buckets = new Map<string, { tokens: number; last: number }>();
  const refillPerMs = perHour / 3_600_000;

  return {
    async take(key, now = Date.now()) {
      const k = String(key);
      let b = buckets.get(k);
      if (!b) {
        b = { tokens: burst, last: now };
        buckets.set(k, b);
      }
      b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
      b.last = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return true;
      }
      return false;
    },
    async retryAfterSec(key) {
      const b = buckets.get(String(key));
      if (!b) return 0;
      return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
    },
  };
}

/**
 * D1 持久化令牌桶（Workers 形态）：多隔离体内存不共享，扣减用单条原子 UPDATE
 * （WHERE 内完成「回填后 ≥1」判定 + RETURNING 判断是否命中），免读-改-写竞态。
 * 额度：每 sendkey 每次推送 1-2 行写，远低于 D1 免费 100k 写/天。
 */
export function createD1RateLimiter(db: Db, perHour: number, burst: number): RateLimiter {
  const refillPerMs = perHour / 3_600_000;

  const refilledTokens = (now: number) =>
    sql`min(${burst}, ${rateBuckets.tokens} + (${now} - ${rateBuckets.last}) * ${refillPerMs})`;

  return {
    async take(key, now = Date.now()) {
      const k = String(key);
      // 桶缺失时以满额初始化；已存在则保持（回填在下一条 UPDATE 内完成）
      await db
        .insert(rateBuckets)
        .values({ key: k, tokens: burst, last: now })
        .onConflictDoNothing()
        .run();
      const hit = await db
        .update(rateBuckets)
        .set({ tokens: sql`${refilledTokens(now)} - 1`, last: now })
        .where(and(eq(rateBuckets.key, k), sql`${refilledTokens(now)} >= 1`))
        .returning({ tokens: rateBuckets.tokens })
        .get();
      return hit !== undefined;
    },
    async retryAfterSec(key) {
      const row = await db.select().from(rateBuckets).where(eq(rateBuckets.key, String(key))).get();
      if (!row) return 0;
      return Math.max(1, Math.ceil((1 - row.tokens) / refillPerMs / 1000));
    },
  };
}

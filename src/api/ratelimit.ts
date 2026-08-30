export interface RateLimiter {
  take(key: string | number, now?: number): boolean;
  retryAfterSec(key: string | number): number;
}

/** 每 sendkey 令牌桶：容量 burst，回填速率 perHour/小时。 */
export function createRateLimiter(perHour: number, burst: number): RateLimiter {
  const buckets = new Map<string, { tokens: number; last: number }>();
  const refillPerMs = perHour / 3_600_000;

  return {
    take(key, now = Date.now()) {
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
    retryAfterSec(key) {
      const b = buckets.get(String(key));
      if (!b) return 0;
      return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
    },
  };
}

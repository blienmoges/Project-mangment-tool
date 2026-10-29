import { AppException } from './app-exception';

/**
 * A simple in-memory limit: at most `limit` hits per key in `windowMs` (sliding window). Enough for one API process;
 * several processes would share the counts through Redis.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Counts a hit; throws 429 RATE_LIMITED when the key is over the limit. */
  hit(key: string, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      const wait = Math.ceil((this.windowMs - (now - recent[0])) / 60_000);
      throw new AppException(429, { code: 'RATE_LIMITED', message: `Too many attempts. Please try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.prune(now);
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

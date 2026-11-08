import { DurableObject } from 'cloudflare:workers';
import type { AuthRateLimit } from '../auth-rate-limit';
import type { EdgeEnv } from '../env';

const ATTEMPTS_KEY = 'attempts';

/**
 * Distributed sliding-window limiter for failed auth attempts — one object per
 * client key (IP), so the failure budget is global across isolates and colos,
 * unlike the in-process AuthRateLimiter fallback. State lives in DO
 * storage (survives hibernation); an alarm garbage-collects idle windows.
 */
export class RateLimiterDO extends DurableObject<EdgeEnv> {
  private readonly maxAttempts = Number(this.env.AUTH_RATE_LIMIT_MAX ?? 10);
  private readonly windowMs = Number(this.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000);

  async isBlocked(): Promise<boolean> {
    return (await this.recent()).length >= this.maxAttempts;
  }

  async recordFailure(): Promise<boolean> {
    const recent = await this.recent();
    recent.push(Date.now());
    await this.ctx.storage.put(ATTEMPTS_KEY, recent);
    // GC after the window fully lapses so idle keys don't hold storage.
    await this.ctx.storage.setAlarm(Date.now() + this.windowMs * 2);
    return recent.length >= this.maxAttempts;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    const recent = await this.recent();
    if (recent.length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.put(ATTEMPTS_KEY, recent);
      await this.ctx.storage.setAlarm(Date.now() + this.windowMs * 2);
    }
  }

  private async recent(): Promise<number[]> {
    const stored = (await this.ctx.storage.get<number[]>(ATTEMPTS_KEY)) ?? [];
    const windowStart = Date.now() - this.windowMs;
    return stored.filter((t) => t > windowStart);
  }
}

/** AuthRateLimit over the per-key RateLimiterDO namespace. */
export function createDoRateLimiter(ns: DurableObjectNamespace<RateLimiterDO>): AuthRateLimit {
  const stub = (key: string) => ns.get(ns.idFromName(key));
  return {
    isBlocked: (key) => stub(key).isBlocked(),
    recordFailure: (key) => stub(key).recordFailure(),
    clear: async (key) => {
      await stub(key).clear();
    },
  };
}

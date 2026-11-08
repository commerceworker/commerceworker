import type { CfRateLimiter, EdgeEnv } from '@commerceworker/platform/env';
import type { RateLimitClass, RequestRateLimit } from './api/request-rate-limit';

export type { CfRateLimiter };

/**
 * Binds the per-class limiters present in `env`. Returns undefined when none
 * are configured, leaving the deployment unlimited (dev/demo) rather than
 * silently falling back to a per-isolate window that would not limit anything.
 */
export function createCfRequestRateLimiter(env: EdgeEnv): RequestRateLimit | undefined {
  const byClass: Partial<Record<RateLimitClass, CfRateLimiter>> = {
    ...(env.RATE_LIMIT_READ ? { read: env.RATE_LIMIT_READ } : {}),
    ...(env.RATE_LIMIT_WRITE ? { write: env.RATE_LIMIT_WRITE } : {}),
    ...(env.RATE_LIMIT_AI ? { ai: env.RATE_LIMIT_AI } : {}),
  };
  if (Object.keys(byClass).length === 0) return undefined;

  return {
    async limit(bucket, key) {
      const limiter = byClass[bucket];
      // An unbound class is unlimited — never fail closed on a missing
      // binding, which would take the whole surface down on a config slip.
      if (!limiter) return true;
      const { success } = await limiter.limit({ key: `${bucket}:${key}` });
      return success;
    },
  };
}

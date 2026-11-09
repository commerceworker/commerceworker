/** A native `ratelimit` binding (limits are declared in wrangler.jsonc, not env). */
export interface CfRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The request classes, each with its own binding (`RATE_LIMIT_READ`, `_WRITE`, `_AI`). */
export type CfRateLimiters = Partial<Record<'read' | 'write' | 'ai', CfRateLimiter>>;

/**
 * Whether one request may proceed, per class. Structurally the HTTP surface's `RequestRateLimit`
 * (`packages/http`, which owns the type and the middleware); declared here so the adapter does
 * not depend on the library it is bound into.
 */
export interface CfRequestRateLimit {
  limit(bucket: 'read' | 'write' | 'ai', key: string): Promise<boolean>;
}

/**
 * Binds the per-class limiters present in `limiters`. Returns undefined when none
 * are configured, leaving the deployment unlimited (dev/demo) rather than
 * silently falling back to a per-isolate window that would not limit anything.
 */
export function createCfRequestRateLimiter(
  limiters: CfRateLimiters,
): CfRequestRateLimit | undefined {
  const byClass: CfRateLimiters = {
    ...(limiters.read ? { read: limiters.read } : {}),
    ...(limiters.write ? { write: limiters.write } : {}),
    ...(limiters.ai ? { ai: limiters.ai } : {}),
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

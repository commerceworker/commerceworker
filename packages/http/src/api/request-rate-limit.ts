/**
 * Per-client request-rate limiting for the whole API surface.
 *
 * This is deliberately separate from {@link ./auth-rate-limit.js}: that one
 * budgets *failed authentication attempts* per IP (a credential-stuffing
 * guard), while this one budgets *total request volume* per credential (an
 * abuse/cost guard for publicly reachable deployments). A caller with a valid
 * key sails through the auth limiter no matter how fast it hammers the API.
 *
 * Requests are bucketed into three classes with independent budgets, because
 * their marginal cost differs by orders of magnitude:
 *   - `read`  — delivery/preview reads; usually served from cache.
 *   - `write` — mutations; a D1 unit of work plus an outbox append.
 *   - `ai`    — routes that call a model or an embeddings provider; real money.
 *
 * The in-process implementation below serves tests and bare `createApp`
 * callers. The Worker injects Cloudflare's `ratelimit` binding through the same
 * interface (see src/rate-limit.ts).
 */

import { clientIp } from '@commerceworker/platform/auth-rate-limit';
import { logger } from '@commerceworker/telemetry';
import type { Context, MiddlewareHandler } from 'hono';

/** Cost class of a request. Each class carries its own budget. */
export type RateLimitClass = 'read' | 'write' | 'ai';

export interface RequestRateLimit {
  /**
   * Records one request against `key`'s budget for `bucket` and reports
   * whether it is allowed. Implementations may be eventually consistent —
   * this is an abuse guard, not an accounting ledger.
   */
  limit(bucket: RateLimitClass, key: string): Promise<boolean>;
}

import type { RateLimitBudgets } from '@commerceworker/platform/config';

export type { RateLimitBudgets };

export const RATE_LIMIT_DISABLED: RateLimitBudgets = {
  read: 0,
  write: 0,
  ai: 0,
  windowSeconds: 60,
};

/**
 * True when at least one class carries a budget. Tolerates an absent config
 * block: hand-built `ApiConfig` objects (tests, embedders) omit it, and an
 * unconfigured limiter must mean "unlimited", never "deny everything".
 */
export function rateLimitEnabled(budgets: RateLimitBudgets | undefined): boolean {
  if (!budgets) return false;
  return budgets.read > 0 || budgets.write > 0 || budgets.ai > 0;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that spend model/embeddings budget. `/search` is included because
 * hybrid search embeds the query text before it can fuse in the lexical leg,
 * so an unauthenticated search flood is an embeddings bill.
 */
const AI_ROUTES = [
  /\/entries\/generate$/,
  /\/entries\/[^/]+\/(moderate|translate|suggest-tags)$/,
  /\/assets\/[^/]+\/alt-text$/,
  /\/ai-actions\/[^/]+\/run$/,
  /\/search$/,
];

/**
 * Paths exempt from limiting: probes (a limited /health would take the
 * deployment down under load, which is precisely backwards) and the static
 * API documentation.
 */
const EXEMPT = /^\/(health|ready|openapi\.json|docs|graphiql)(\/|$)/;

/**
 * Delivery GraphQL is a POST, but it is mounted on the read-only delivery
 * surface and scope-checked as `deliveryRead` — charging it to the write
 * budget would throttle ordinary reads. Known gap: its `search` resolver does
 * spend embeddings, so a search-heavy GraphQL flood escapes the `ai` budget.
 * The per-space AI cost guard still meters that spend, which is what bounds it.
 */
const READ_OVER_POST = /\/graphql$/;

/** Buckets a request by marginal cost. */
export function classifyRequest(method: string, path: string): RateLimitClass {
  if (AI_ROUTES.some((re) => re.test(path))) return 'ai';
  if (READ_OVER_POST.test(path)) return 'read';
  return MUTATING.has(method.toUpperCase()) ? 'write' : 'read';
}

/**
 * Derives the limiter key, preferring credential identity over network
 * identity. Cloudflare's guidance is explicit that IP-keyed limits punish
 * shared egress (mobile carriers, corporate NAT, CI), so an authenticated
 * caller is budgeted per key and only anonymous traffic falls back to IP.
 *
 * The bearer token is hashed, never used raw: limiter keys reach logs, DO
 * names, and storage keys, and a raw token in any of those is a credential leak.
 * Hashing here is also what lets the limit apply *before* the key is resolved
 * against the database, so a flood with a valid token never reaches D1.
 */
export function rateLimitKey(
  c: Context,
  hash: (value: string) => string,
  trustedProxyCount?: number,
): string {
  const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) return `k:${hash(bearer).slice(0, 32)}`;
  const ip = clientIp({
    cfConnectingIp: c.req.header('cf-connecting-ip'),
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    trustedProxyCount,
  });
  return `ip:${ip}`;
}

/**
 * Mounts request-rate limiting. Runs ahead of authentication so that rejected
 * traffic costs one hash rather than a database round-trip.
 */
export function requestRateLimitMiddleware(opts: {
  limiter: RequestRateLimit;
  hash: (value: string) => string;
  windowSeconds: number;
  trustedProxyCount?: number;
}): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (EXEMPT.test(path)) return next();

    const bucket = classifyRequest(c.req.method, path);
    const key = rateLimitKey(c, opts.hash, opts.trustedProxyCount);
    if (await opts.limiter.limit(bucket, key)) return next();

    logger.warn({ bucket, path, method: c.req.method }, 'request: rate limit exceeded');
    return c.json({ code: 'rate_limited', message: 'Too many requests' }, 429, {
      'Retry-After': String(opts.windowSeconds),
    });
  };
}

/**
 * In-process sliding window. Correct within one isolate only; across isolates
 * the effective budget multiplies, which is why the Worker injects the
 * Cloudflare `ratelimit` binding instead.
 */
export class InProcessRequestRateLimiter implements RequestRateLimit {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(private readonly budgets: RateLimitBudgets) {
    this.windowMs = budgets.windowSeconds * 1000;
  }

  async limit(bucket: RateLimitClass, key: string): Promise<boolean> {
    const budget = this.budgets[bucket];
    if (budget <= 0) return true;

    const now = Date.now();
    const mapKey = `${bucket}:${key}`;
    const recent = (this.hits.get(mapKey) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= budget) {
      this.hits.set(mapKey, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(mapKey, recent);
    this.sweep(now);
    return true;
  }

  /**
   * Drops fully-lapsed windows so an attacker cycling keys cannot grow the map
   * without bound. Amortized: only once the map is large enough to be worth it.
   */
  private sweep(now: number): void {
    if (this.hits.size < 1024) return;
    for (const [k, times] of this.hits) {
      if (times.length === 0 || (times[times.length - 1] ?? 0) <= now - this.windowMs) {
        this.hits.delete(k);
      }
    }
  }
}

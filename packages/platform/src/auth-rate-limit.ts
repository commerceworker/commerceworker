/**
 * Rate-limit seam for failed auth attempts. The in-process implementation
 * below serves single-node deployments; distributed runtimes (Cloudflare
 * Workers) inject a shared-state implementation (a Durable Object per client
 * key) through `AuthDeps.rateLimiter`.
 */
export interface AuthRateLimit {
  /** True when recent failures exceed the limit. */
  isBlocked(key: string): boolean | Promise<boolean>;
  /** Record a failed attempt; returns true if the limit is now exceeded. */
  recordFailure(key: string): boolean | Promise<boolean>;
  /** Reset the window (called on successful auth). */
  clear(key: string): void | Promise<void>;
}

/**
 * In-process sliding-window rate limiter for failed auth attempts.
 */
export class AuthRateLimiter implements AuthRateLimit {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  /** True when recent failures exceed the limit. */
  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxAttempts;
  }

  /** Record a failed attempt; returns true if the limit is now exceeded. */
  recordFailure(key: string): boolean {
    const now = Date.now();
    const recent = this.recent(key);
    recent.push(now);
    this.attempts.set(key, recent);
    return recent.length >= this.maxAttempts;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private recent(key: string): number[] {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const prev = this.attempts.get(key) ?? [];
    const recent = prev.filter((t) => t > windowStart);
    this.attempts.set(key, recent);
    return recent;
  }
}

/**
 * Derives the client key for rate limiting in a spoof-resistant way.
 *
 * `cf-connecting-ip` (set by Cloudflare, not client-forgeable) always wins. Behind
 * other reverse proxies (local dev, tests), `X-Forwarded-For` is parsed from
 * the RIGHT: with `trustedProxyCount` proxies in front, the genuine client is the
 * entry `trustedProxyCount` from the end — anything an attacker prepends on the
 * left is ignored. Taking the left-most hop (the old behaviour) let a client set
 * a fresh key per request and defeat the failed-auth budget entirely.
 */
export function clientIp(opts: {
  cfConnectingIp?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxyCount?: number;
}): string {
  const cf = opts.cfConnectingIp?.trim();
  if (cf) return cf;
  const trusted = Math.max(0, opts.trustedProxyCount ?? 1);
  const hops = (opts.forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // With `trusted` proxies in front, each appends the address it received from,
  // so the genuine client sits `trusted` entries from the end; anything further
  // left is client-supplied and ignored. `trusted === 0` means X-Forwarded-For is
  // wholly untrusted, so fall back to the socket-derived address.
  if (trusted >= 1 && hops.length > 0) {
    const idx = Math.max(0, hops.length - trusted);
    return hops[idx] ?? hops[hops.length - 1] ?? 'unknown';
  }
  return opts.realIp?.trim() || 'unknown';
}

import type { Scope } from '@commerceworker/domain';
import type { AiBudgetDecision, CostGuard } from '@commerceworker/ports';

export interface CostGuardLimits {
  /** Max AI requests per scope per window. */
  readonly maxRequests: number;
  /** Max total tokens (input+output) per scope per window. */
  readonly maxTokens: number;
  /** Rolling window length in seconds. */
  readonly windowSeconds: number;
}

interface Bucket {
  windowStartMs: number;
  requests: number;
  tokens: number;
}

/**
 * In-process fixed-window {@link CostGuard} for dev, single-node, and tests.
 * Counters are per space (the isolation boundary), not per environment. The Worker
 * uses the CostGuardDO Durable Object so the window is shared across isolates.
 */
export class InMemoryCostGuard implements CostGuard {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;

  constructor(
    private readonly limits: CostGuardLimits,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.windowMs = limits.windowSeconds * 1000;
  }

  private bucketFor(scope: Scope): Bucket {
    const key = scope.spaceId;
    const t = this.now();
    const existing = this.buckets.get(key);
    if (!existing || t - existing.windowStartMs >= this.windowMs) {
      const fresh: Bucket = { windowStartMs: t, requests: 0, tokens: 0 };
      this.buckets.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  async consume(scope: Scope): Promise<AiBudgetDecision> {
    const b = this.bucketFor(scope);
    b.requests += 1;
    const retryAfterSeconds = Math.ceil((b.windowStartMs + this.windowMs - this.now()) / 1000);
    if (b.tokens >= this.limits.maxTokens) {
      return { allowed: false, reason: 'tokens', retryAfterSeconds };
    }
    if (b.requests > this.limits.maxRequests) {
      return { allowed: false, reason: 'requests', retryAfterSeconds };
    }
    return { allowed: true };
  }

  async settle(scope: Scope, tokens: number): Promise<void> {
    const b = this.bucketFor(scope);
    b.tokens += Math.max(0, tokens);
  }
}

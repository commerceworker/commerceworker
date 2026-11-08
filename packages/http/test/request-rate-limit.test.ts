import type { EdgeEnv } from '@commerceworker/platform/env';
import { describe, expect, it } from 'vitest';
import { type CfRateLimiter, createCfRequestRateLimiter } from '../src/rate-limit';

/** Stand-in for a native `ratelimit` binding, recording the keys it is asked about. */
function fakeBinding(success: boolean) {
  const keys: string[] = [];
  const binding: CfRateLimiter = {
    async limit({ key }) {
      keys.push(key);
      return { success };
    },
  };
  return { binding, keys };
}

describe('Cloudflare ratelimit binding adapter', () => {
  it('is absent when no class is bound, leaving the deployment unlimited', () => {
    expect(createCfRequestRateLimiter({} as EdgeEnv)).toBeUndefined();
  });

  it('routes each class to its own binding and namespaces the key by class', async () => {
    const read = fakeBinding(true);
    const write = fakeBinding(true);
    const ai = fakeBinding(true);
    const limiter = createCfRequestRateLimiter({
      RATE_LIMIT_READ: read.binding,
      RATE_LIMIT_WRITE: write.binding,
      RATE_LIMIT_AI: ai.binding,
    } as EdgeEnv);

    expect(await limiter?.limit('read', 'k:abc')).toBe(true);
    expect(await limiter?.limit('write', 'k:abc')).toBe(true);
    expect(await limiter?.limit('ai', 'k:abc')).toBe(true);

    // Class-prefixed keys keep the three budgets from sharing one counter even
    // though the same client key reaches all three bindings.
    expect(read.keys).toEqual(['read:k:abc']);
    expect(write.keys).toEqual(['write:k:abc']);
    expect(ai.keys).toEqual(['ai:k:abc']);
  });

  it('reports exhaustion when the binding denies', async () => {
    const ai = fakeBinding(false);
    const limiter = createCfRequestRateLimiter({ RATE_LIMIT_AI: ai.binding } as EdgeEnv);
    expect(await limiter?.limit('ai', 'k:abc')).toBe(false);
  });

  it('treats an unbound class as unlimited rather than failing closed', async () => {
    // Only the AI class is bound. A config slip that drops the read binding must
    // not take the entire delivery surface offline.
    const ai = fakeBinding(false);
    const limiter = createCfRequestRateLimiter({ RATE_LIMIT_AI: ai.binding } as EdgeEnv);
    expect(await limiter?.limit('read', 'k:abc')).toBe(true);
    expect(await limiter?.limit('write', 'k:abc')).toBe(true);
  });
});

import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { createDoRateLimiter } from '@commerceworker/platform/do/rate-limiter';
import { afterEach, describe, expect, it } from 'vitest';

// vitest.config.ts binds AUTH_RATE_LIMIT_MAX=3, AUTH_RATE_LIMIT_WINDOW_MS=3000. Seconds, not
// milliseconds: a test records its failures and checks the block inside one window, and a loaded CI
// runner took ~950 ms for three failures against a 300 ms window (the first had aged out).
const MAX = 3;
const WINDOW_MS = 3000;

// The DO arms a GC alarm on every recorded failure. A pending alarm must not
// outlive its test: vitest-pool-workers pops each test's isolated storage at
// test end, and an alarm write landing mid-pop corrupts the storage stack
// (the upstream "isolated storage failed" issue — flaky on slow CI runners).
// Delete (not run) the alarm: the handler re-arms itself when windows remain.
afterEach(async () => {
  // listDurableObjectIds is typed for an untyped namespace; ours is typed.
  const ns = env.AUTH_LIMITER as unknown as DurableObjectNamespace;
  for (const id of await listDurableObjectIds(ns)) {
    await runInDurableObject(env.AUTH_LIMITER.get(id), (_instance, state) =>
      state.storage.deleteAlarm(),
    );
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RateLimiterDO via createDoRateLimiter', () => {
  it('blocks a key once it reaches the failure budget', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-blocks';
    expect(await limiter.isBlocked(key)).toBe(false);
    expect(await limiter.recordFailure(key)).toBe(false);
    expect(await limiter.recordFailure(key)).toBe(false);
    // The Nth failure trips the budget and reports it to the caller.
    expect(await limiter.recordFailure(key)).toBe(true);
    expect(await limiter.isBlocked(key)).toBe(true);
  });

  it('keeps budgets independent per key', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    for (let i = 0; i < MAX; i++) await limiter.recordFailure('ip-noisy');
    expect(await limiter.isBlocked('ip-noisy')).toBe(true);
    expect(await limiter.isBlocked('ip-quiet')).toBe(false);
  });

  it('unblocks after the window lapses', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-lapses';
    for (let i = 0; i < MAX; i++) await limiter.recordFailure(key);
    expect(await limiter.isBlocked(key)).toBe(true);
    // Wait out the window, then give a loaded runner a generous deadline: the limiter compares the
    // failures' times with its own clock, so a fixed margin after a fixed sleep was flaky in CI.
    await sleep(WINDOW_MS);
    await expect
      .poll(() => limiter.isBlocked(key), { timeout: WINDOW_MS * 3, interval: 100 })
      .toBe(false);
  }, 20_000);

  it('clear resets the budget immediately (successful auth path)', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-clears';
    for (let i = 0; i < MAX; i++) await limiter.recordFailure(key);
    expect(await limiter.isBlocked(key)).toBe(true);
    await limiter.clear(key);
    expect(await limiter.isBlocked(key)).toBe(false);
  });
});

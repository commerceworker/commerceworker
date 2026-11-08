import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import type { Scope } from '@commerceworker/domain';
import {
  createDoCostGuard,
  doAgentCostGuardFromEnv,
  doCostGuardFromEnv,
} from '@commerceworker/platform/do/cost-guard';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { afterEach, describe, expect, it } from 'vitest';

// vitest.config.ts binds AI_MAX_REQUESTS_PER_WINDOW=2, AI_MAX_TOKENS_PER_WINDOW=100,
// AI_BUDGET_WINDOW_SECONDS=2, AI_AGENT_MAX_REQUESTS_PER_WINDOW=1.
const WINDOW_MS = 2_000;

// Drain the DO's GC alarm after every test — a pending alarm firing while
// vitest-pool-workers pops the test's isolated storage corrupts the storage
// stack (flaky "isolated storage failed" on slow runners). Delete, don't run:
// the alarm handler re-arms itself when live windows remain.
afterEach(async () => {
  // listDurableObjectIds is typed for an untyped namespace; ours is typed.
  const ns = env.AI_BUDGET as unknown as DurableObjectNamespace;
  for (const id of await listDurableObjectIds(ns)) {
    await runInDurableObject(env.AI_BUDGET.get(id), (_instance, state) =>
      state.storage.deleteAlarm(),
    );
  }
});

const scopeFor = (spaceId: string): Scope => ({ spaceId, environmentId: 'main' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CostGuardDO via createDoCostGuard', () => {
  it('denies with reason "requests" once the request ceiling is exceeded', async () => {
    const guard = createDoCostGuard(env.AI_BUDGET);
    const scope = scopeFor('space-requests');
    expect((await guard.consume(scope)).allowed).toBe(true);
    expect((await guard.consume(scope)).allowed).toBe(true);
    const third = await guard.consume(scope);
    expect(third).toMatchObject({ allowed: false, reason: 'requests' });
    if (!third.allowed) expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(0);
  });

  it('denies with reason "tokens" after settled usage reaches the token ceiling', async () => {
    const guard = createDoCostGuard(env.AI_BUDGET);
    const scope = scopeFor('space-tokens');
    expect((await guard.consume(scope)).allowed).toBe(true);
    await guard.settle(scope, 150);
    expect(await guard.consume(scope)).toMatchObject({ allowed: false, reason: 'tokens' });
  });

  it('meters per space — one space exhausting its window leaves others intact', async () => {
    const guard = createDoCostGuard(env.AI_BUDGET);
    const noisy = scopeFor('space-noisy');
    for (let i = 0; i < 3; i++) await guard.consume(noisy);
    expect((await guard.consume(noisy)).allowed).toBe(false);
    expect((await guard.consume(scopeFor('space-calm'))).allowed).toBe(true);
  });

  it('keeps prefixed windows independent (background agent spend vs interactive)', async () => {
    const interactive = createDoCostGuard(env.AI_BUDGET);
    const background = createDoCostGuard(env.AI_BUDGET, 'agent:');
    const scope = scopeFor('space-prefixed');
    for (let i = 0; i < 3; i++) await interactive.consume(scope);
    expect((await interactive.consume(scope)).allowed).toBe(false);
    // Same space, separate `agent:` counter window — still within budget.
    expect((await background.consume(scope)).allowed).toBe(true);
  });

  it('enforces the AI_AGENT_* ceilings on background windows only', async () => {
    const interactive = createDoCostGuard(env.AI_BUDGET);
    const background = createDoCostGuard(env.AI_BUDGET, 'agent:');
    const scope = scopeFor('space-agent-limits');
    // Background ceiling is 1 request/window (AI_AGENT_MAX_REQUESTS_PER_WINDOW).
    expect((await background.consume(scope)).allowed).toBe(true);
    expect(await background.consume(scope)).toMatchObject({
      allowed: false,
      reason: 'requests',
    });
    // The interactive window keeps its own ceiling of 2.
    expect((await interactive.consume(scope)).allowed).toBe(true);
    expect((await interactive.consume(scope)).allowed).toBe(true);
    expect((await interactive.consume(scope)).allowed).toBe(false);
  });

  it('rolls the window after it lapses', async () => {
    const guard = createDoCostGuard(env.AI_BUDGET);
    const scope = scopeFor('space-rolls');
    for (let i = 0; i < 3; i++) await guard.consume(scope);
    expect((await guard.consume(scope)).allowed).toBe(false);
    await sleep(WINDOW_MS + 100);
    expect((await guard.consume(scope)).allowed).toBe(true);
  });
});

describe('cost guard env helpers', () => {
  const budgetEnv = (vars: Record<string, string>): EdgeEnv =>
    ({ AI_BUDGET: env.AI_BUDGET, ...vars }) as unknown as EdgeEnv;

  it('returns undefined without the AI_BUDGET binding', () => {
    expect(doCostGuardFromEnv({} as EdgeEnv)).toBeUndefined();
    expect(doAgentCostGuardFromEnv({} as EdgeEnv)).toBeUndefined();
  });

  it('treats a 0 ceiling as metering disabled (Node parity)', () => {
    expect(doCostGuardFromEnv(budgetEnv({ AI_MAX_REQUESTS_PER_WINDOW: '0' }))).toBeUndefined();
    expect(doCostGuardFromEnv(budgetEnv({ AI_MAX_TOKENS_PER_WINDOW: '0' }))).toBeUndefined();
    expect(doCostGuardFromEnv(budgetEnv({}))).toBeDefined();
  });

  it('meters background spend under AI_AGENT_* even when interactive metering is off', () => {
    const disabled = budgetEnv({
      AI_MAX_REQUESTS_PER_WINDOW: '0',
      AI_AGENT_MAX_REQUESTS_PER_WINDOW: '5',
    });
    expect(doCostGuardFromEnv(disabled)).toBeUndefined();
    expect(doAgentCostGuardFromEnv(disabled)).toBeDefined();
    // Everything off → background unmetered too.
    expect(
      doAgentCostGuardFromEnv(
        budgetEnv({ AI_MAX_REQUESTS_PER_WINDOW: '0', AI_AGENT_MAX_REQUESTS_PER_WINDOW: '0' }),
      ),
    ).toBeUndefined();
  });
});

import { RateLimitedError } from '@commerceworker/domain';
import type { AIProvider } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryCostGuard,
  SequenceIdGenerator,
  StubDecisionModel,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  aiBudgetLimits,
  decide,
  decideWithBudget,
  generateWithBudget,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const scopeB = { spaceId: 's2', environmentId: 'main' };

function fakeAI(tokens = 100): AIProvider {
  return {
    async generate() {
      return { text: 'ok', usage: { inputTokens: tokens, outputTokens: tokens } };
    },
  };
}

function ctxWith(guard?: InMemoryCostGuard): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('a'),
    costGuard: guard,
  };
}

const req = { prompt: 'hi', maxTokens: 128 };

describe('generateWithBudget', () => {
  it('passes through unmetered when no cost guard is wired', async () => {
    const ctx = ctxWith(undefined);
    const r = await generateWithBudget(ctx, fakeAI(), scope, req);
    expect(r.text).toBe('ok');
  });

  it('enforces the per-space request ceiling', async () => {
    const guard = new InMemoryCostGuard({
      maxRequests: 3,
      maxTokens: 1_000_000,
      windowSeconds: 60,
    });
    const ctx = ctxWith(guard);
    for (let i = 0; i < 3; i++) await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('enforces the per-space token ceiling on the next call after usage accrues', async () => {
    const guard = new InMemoryCostGuard({ maxRequests: 100, maxTokens: 150, windowSeconds: 60 });
    const ctx = ctxWith(guard);
    // First call settles 100+100=200 tokens, over the 150 ceiling.
    await generateWithBudget(ctx, fakeAI(100), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(100), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('isolates budgets per space', async () => {
    const guard = new InMemoryCostGuard({
      maxRequests: 1,
      maxTokens: 1_000_000,
      windowSeconds: 60,
    });
    const ctx = ctxWith(guard);
    await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // A different space still has its full budget.
    await expect(generateWithBudget(ctx, fakeAI(0), scopeB, req)).resolves.toBeTruthy();
  });

  it('resets after the window elapses', async () => {
    let t = 1_000_000;
    const guard = new InMemoryCostGuard(
      { maxRequests: 1, maxTokens: 1_000_000, windowSeconds: 60 },
      () => t,
    );
    const ctx = ctxWith(guard);
    await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    t += 61_000; // advance past the window
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).resolves.toBeTruthy();
  });
});

describe('aiBudgetLimits', () => {
  it('returns defaults for an empty env', () => {
    expect(aiBudgetLimits({})).toEqual({ maxRequests: 60, maxTokens: 200_000, windowSeconds: 60 });
  });

  it('disables metering when a ceiling is 0', () => {
    expect(aiBudgetLimits({ AI_MAX_REQUESTS_PER_WINDOW: '0' })).toBeUndefined();
    expect(aiBudgetLimits({ AI_MAX_TOKENS_PER_WINDOW: '0' })).toBeUndefined();
  });

  it('reads overrides from env', () => {
    expect(
      aiBudgetLimits({
        AI_MAX_REQUESTS_PER_WINDOW: '10',
        AI_MAX_TOKENS_PER_WINDOW: '5000',
        AI_BUDGET_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ maxRequests: 10, maxTokens: 5000, windowSeconds: 30 });
  });
});

describe('decisions under the budget', () => {
  const question = {
    state: 'x',
    questions: { ok: { type: 'noul' as const, instructions: 'OK?' } },
  };

  it('meters a decision by its input tokens, and refuses one over the budget', async () => {
    const guard = new InMemoryCostGuard({ maxRequests: 1, maxTokens: 1000, windowSeconds: 60 });
    const ctx = ctxWith(guard);
    const model = new StubDecisionModel();
    const r = await decideWithBudget(ctx, model, scope, question);
    expect(r.answers.ok).toEqual({ type: 'noul', probability: 0 });
    await expect(decideWithBudget(ctx, model, scope, question)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(model.requests).toHaveLength(1);
  });

  it('answers with the caller’s heuristic on a budget refusal, and records why', async () => {
    const guard = new InMemoryCostGuard({ maxRequests: 1, maxTokens: 1000, windowSeconds: 60 });
    await guard.consume(scope); // the window's one request is already spent
    const model = new StubDecisionModel();
    const r = await decide(ctxWith(guard), model, scope, question, {
      prompt: 'test.decision',
      fallback: () => ({ ok: { type: 'noul', probability: 0.9 } }),
    });
    expect(r).toMatchObject({ source: 'heuristic', answers: { ok: { probability: 0.9 } } });
    expect(String(r.fallback)).toMatch(/^budget:/);
    expect(model.requests).toEqual([]);
  });
});

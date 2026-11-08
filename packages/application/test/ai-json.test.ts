import type { AIProvider, GenerateRequest } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryCostGuard,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AiCallRecord,
  type AppContext,
  aiModeFakes,
  aiRuntimeConfig,
  assertNoFakeAdapters,
  conforms,
  DEFAULT_AI_TIMEOUT_MS,
  generateJson,
  isUncheckedFallback,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };

const schema = {
  type: 'object',
  properties: {
    route: { type: 'string', enum: ['publish', 'review'] },
    score: { type: 'number' },
  },
  required: ['route'],
  additionalProperties: false,
} as const;

type Answer = { route: 'publish' | 'review'; score?: number };

const req = (): GenerateRequest & { outputSchema: Record<string, unknown> } => ({
  prompt: 'route this',
  maxTokens: 64,
  tier: 'fast',
  outputSchema: schema,
});

const fallback = (): Answer => ({ route: 'review' });

function ctxWith(overrides: Partial<AppContext> = {}): AppContext & { records: AiCallRecord[] } {
  const records: AiCallRecord[] = [];
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('a'),
    ai: { mode: 'live', timeoutMs: DEFAULT_AI_TIMEOUT_MS, log: (r) => records.push(r) },
    ...overrides,
    records,
  };
}

const answering = (value: unknown): StubAIProvider => new StubAIProvider(() => value);

function failing(err: Error): AIProvider {
  return {
    async generate() {
      throw err;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('generateJson — the model path', () => {
  it('returns a conforming answer with model provenance and usage', async () => {
    const ctx = ctxWith();
    const ai = answering({ route: 'publish', score: 0.9 });
    const res = await generateJson(ctx, ai, scope, req(), { prompt: 'workflow.router', fallback });
    expect(res).toMatchObject({
      source: 'model',
      tier: 'fast',
      prompt: 'workflow.router',
      value: { route: 'publish', score: 0.9 },
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(res.fallback).toBeUndefined();
    expect(ai.requests[0]!.outputSchema).toBe(schema);
    expect(ctx.records).toEqual([
      expect.objectContaining({ type: 'ai_call', source: 'model', tokens: 30 }),
    ]);
  });
});

describe('generateJson — fallbacks (never blocks)', () => {
  it('AI_MODE=mock answers from the heuristic without calling the model', async () => {
    const ctx = ctxWith({ ai: { mode: 'mock', timeoutMs: DEFAULT_AI_TIMEOUT_MS } });
    const ai = answering({ route: 'publish' });
    const res = await generateJson(ctx, ai, scope, req(), { prompt: 'p', fallback });
    expect(res).toMatchObject({ source: 'heuristic', tier: null, fallback: 'mock' });
    expect(res.value).toEqual({ route: 'review' });
    expect(ai.requests).toHaveLength(0);
    expect(isUncheckedFallback(res)).toBe(false);
  });

  it('falls back when the answer does not match the schema', async () => {
    const ctx = ctxWith();
    const res = await generateJson(ctx, answering({ route: 'ship-it' }), scope, req(), {
      prompt: 'p',
      fallback,
    });
    expect(res).toMatchObject({
      source: 'heuristic',
      fallback: 'response does not match the schema',
      value: { route: 'review' },
      // What the model used still counts.
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(isUncheckedFallback(res)).toBe(true);
  });

  it('falls back when the model returns no object', async () => {
    const ai: AIProvider = {
      async generate() {
        return { text: 'nope', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const res = await generateJson(ctxWith(), ai, scope, req(), { prompt: 'p', fallback });
    expect(res).toMatchObject({ source: 'heuristic', fallback: 'empty response' });
  });

  it('falls back on timeout at the configured cap', async () => {
    vi.useFakeTimers();
    const ctx = ctxWith({ ai: { mode: 'live', timeoutMs: 1_000 } });
    const hang: AIProvider = { generate: () => new Promise(() => {}) };
    const p = generateJson(ctx, hang, scope, req(), { prompt: 'p', fallback });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({
      source: 'heuristic',
      fallback: expect.stringContaining('timed out after 1000ms'),
    });
  });

  it('falls back when the budget refuses the call, even with retry set', async () => {
    const ctx = ctxWith({
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    });
    const ai = answering({ route: 'publish' });
    const res = await generateJson(ctx, ai, scope, req(), { prompt: 'p', fallback, retry: true });
    expect(res).toMatchObject({ source: 'heuristic', fallback: expect.stringMatching(/^budget:/) });
    expect(ai.requests).toHaveLength(0);
  });
});

describe('generateJson — retry versus last attempt', () => {
  it('throws on a provider failure while the step has attempts left', async () => {
    const ctx = ctxWith();
    await expect(
      generateJson(ctx, failing(new Error('upstream 503')), scope, req(), {
        prompt: 'p',
        fallback,
        retry: true,
      }),
    ).rejects.toThrow(/upstream 503.*trying again/);
    expect(ctx.records).toEqual([expect.objectContaining({ retrying: 'upstream 503' })]);
  });

  it('throws on a timeout while the step has attempts left', async () => {
    vi.useFakeTimers();
    const ctx = ctxWith({ ai: { mode: 'live', timeoutMs: 500 } });
    const hang: AIProvider = { generate: () => new Promise(() => {}) };
    const p = generateJson(ctx, hang, scope, req(), { prompt: 'p', fallback, retry: true });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('falls back on the last attempt (retry unset)', async () => {
    const res = await generateJson(ctxWith(), failing(new Error('upstream 503')), scope, req(), {
      prompt: 'p',
      fallback,
    });
    expect(res).toMatchObject({ source: 'heuristic', fallback: 'upstream 503' });
  });

  it('does not retry a bad answer — the same prompt gets the same answer', async () => {
    const res = await generateJson(ctxWith(), answering({ route: 'x' }), scope, req(), {
      prompt: 'p',
      fallback,
      retry: true,
    });
    expect(res.source).toBe('heuristic');
  });
});

describe('conforms', () => {
  it('checks type, enum, required, nested items and additionalProperties:false', () => {
    expect(conforms({ route: 'publish' }, schema)).toBe(true);
    expect(conforms({ route: 'publish', extra: 1 }, schema)).toBe(false);
    expect(conforms({ score: 1 }, schema)).toBe(false);
    expect(conforms({ route: 'publish', score: '1' }, schema)).toBe(false);
    const list = { type: 'array', items: { type: 'integer' } };
    expect(conforms([1, 2], list)).toBe(true);
    expect(conforms([1, 2.5], list)).toBe(false);
    expect(conforms(null, { type: ['string', 'null'] })).toBe(true);
  });
});

describe('aiRuntimeConfig + AI_MODE=mock adapter guard', () => {
  it('parses AI_MODE / AI_TIMEOUT_MS with defaults', () => {
    expect(aiRuntimeConfig({})).toEqual({ mode: 'live', timeoutMs: 20_000 });
    expect(aiRuntimeConfig({ AI_MODE: 'mock', AI_TIMEOUT_MS: '5000' })).toEqual({
      mode: 'mock',
      timeoutMs: 5_000,
    });
    expect(aiRuntimeConfig({ AI_MODE: 'other', AI_TIMEOUT_MS: 'x' })).toEqual({
      mode: 'live',
      timeoutMs: 20_000,
    });
  });

  it('refuses AI_MODE=mock against a persistent store unless ALLOW_FAKE_ADAPTERS names ai', () => {
    const fakes = aiModeFakes(aiRuntimeConfig({ AI_MODE: 'mock' }));
    expect(() => assertNoFakeAdapters({ persistent: true, fakes })).toThrow(
      /ai: AI_MODE=mock.*\n.*ALLOW_FAKE_ADAPTERS=ai/s,
    );
    expect(() =>
      assertNoFakeAdapters({ persistent: true, allowFakeAdapters: 'ai', fakes }),
    ).not.toThrow();
    expect(() => assertNoFakeAdapters({ persistent: false, fakes })).not.toThrow();
    expect(aiModeFakes(aiRuntimeConfig({ AI_MODE: 'live' }))).toEqual([]);
  });
});

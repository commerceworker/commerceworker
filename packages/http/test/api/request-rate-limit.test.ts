import type { ApiConfig } from '@commerceworker/platform/config';
import { loadConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import {
  classifyRequest,
  InProcessRequestRateLimiter,
  type RateLimitClass,
  type RequestRateLimit,
  rateLimitEnabled,
} from '../../src/api/request-rate-limit';
import { wire } from './wire';

const base = {
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
} as ApiConfig;

function configWith(rateLimit: ApiConfig['rateLimit']): ApiConfig {
  return { ...base, rateLimit } as ApiConfig;
}

/** Records every (bucket, key) the middleware asks about; allows/denies on demand. */
function recordingLimiter(allow: boolean) {
  const calls: { bucket: RateLimitClass; key: string }[] = [];
  const limiter: RequestRateLimit = {
    async limit(bucket, key) {
      calls.push({ bucket, key });
      return allow;
    },
  };
  return { limiter, calls };
}

function makeApp(config: ApiConfig, limiter?: RequestRateLimit) {
  const { ctx, rag, blob, ai, bus } = wire(config);
  return createApp(ctx, config, rag, blob, ai, inMemoryEdge(), bus, undefined, undefined, limiter);
}

describe('request classification', () => {
  it('buckets reads, writes, and model-spending routes separately', () => {
    expect(classifyRequest('GET', '/delivery/s1/main/entries')).toBe('read');
    expect(classifyRequest('POST', '/spaces/s1/environments/main/entries')).toBe('write');
    expect(classifyRequest('DELETE', '/spaces/s1/environments/main/entries/e1')).toBe('write');
  });

  it('charges delivery GraphQL to the read budget despite being a POST', () => {
    // It is mounted on the read-only delivery surface; billing it as a write
    // would throttle ordinary reads against the much smaller mutation budget.
    expect(classifyRequest('POST', '/delivery/s1/main/graphql')).toBe('read');
  });

  it('classifies every model- or embeddings-spending route as ai', () => {
    const ai = [
      ['POST', '/spaces/s1/environments/main/entries/generate'],
      ['POST', '/spaces/s1/environments/main/entries/e1/moderate'],
      ['POST', '/spaces/s1/environments/main/entries/e1/translate'],
      ['POST', '/spaces/s1/environments/main/entries/e1/suggest-tags'],
      ['POST', '/spaces/s1/environments/main/assets/a1/alt-text'],
      ['POST', '/spaces/s1/environments/main/ai-actions/x/run'],
      // Hybrid search embeds the query before it can fuse the lexical leg, so a
      // search flood is an embeddings bill even though it is a GET.
      ['GET', '/delivery/s1/main/search'],
    ] as const;
    for (const [method, path] of ai) {
      expect(classifyRequest(method, path), `${method} ${path}`).toBe('ai');
    }
  });
});

describe('in-process limiter', () => {
  it('allows exactly the budget within a window, then rejects', async () => {
    const limiter = new InProcessRequestRateLimiter({
      read: 3,
      write: 0,
      ai: 0,
      windowSeconds: 60,
    });
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.limit('read', 'k'));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('budgets each class and each key independently', async () => {
    const limiter = new InProcessRequestRateLimiter({
      read: 1,
      write: 1,
      ai: 1,
      windowSeconds: 60,
    });
    expect(await limiter.limit('read', 'a')).toBe(true);
    expect(await limiter.limit('read', 'a')).toBe(false);
    // Different key, and different class for the same key: both untouched.
    expect(await limiter.limit('read', 'b')).toBe(true);
    expect(await limiter.limit('write', 'a')).toBe(true);
    expect(await limiter.limit('ai', 'a')).toBe(true);
  });

  it('treats a zero budget as unlimited rather than as "deny everything"', async () => {
    const limiter = new InProcessRequestRateLimiter({
      read: 0,
      write: 0,
      ai: 0,
      windowSeconds: 60,
    });
    for (let i = 0; i < 50; i++) expect(await limiter.limit('read', 'k')).toBe(true);
  });
});

describe('rate limit middleware', () => {
  const enabled = { read: 10, write: 10, ai: 10, windowSeconds: 30 };

  it('is not mounted at all when no class carries a budget', async () => {
    const { limiter, calls } = recordingLimiter(false);
    const app = makeApp(configWith({ read: 0, write: 0, ai: 0, windowSeconds: 60 }), limiter);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    // Denying limiter injected, yet never consulted — the middleware is absent.
    expect(calls).toEqual([]);
  });

  it('rejects with 429, a machine-readable code, and Retry-After', async () => {
    const { limiter } = recordingLimiter(false);
    const app = makeApp(configWith(enabled), limiter);
    const res = await app.request('/delivery/s1/main/entries', {
      headers: { authorization: 'Bearer cda' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ code: 'rate_limited', message: 'Too many requests' });
  });

  it('never limits health probes — a limited /health would fail the deployment under load', async () => {
    const { limiter, calls } = recordingLimiter(false);
    const app = makeApp(configWith(enabled), limiter);
    for (const path of ['/health', '/ready']) {
      expect((await app.request(path)).status, path).toBe(200);
    }
    expect(calls).toEqual([]);
  });

  it('keys by hashed token, never by the raw credential', async () => {
    const { limiter, calls } = recordingLimiter(true);
    const app = makeApp(configWith(enabled), limiter);
    await app.request('/delivery/s1/main/entries', {
      headers: { authorization: 'Bearer super-secret-key' },
    });
    expect(calls).toHaveLength(1);
    const key = calls[0]?.key ?? '';
    expect(key.startsWith('k:')).toBe(true);
    expect(key).not.toContain('super-secret-key');
  });

  it('falls back to the client IP for anonymous traffic', async () => {
    const { limiter, calls } = recordingLimiter(true);
    const app = makeApp(configWith(enabled), limiter);
    await app.request('/delivery/s1/main/entries', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(calls[0]?.key).toBe('ip:203.0.113.7');
  });

  it('limits before authentication, so a flood with a bad token costs no lookup', async () => {
    const { limiter, calls } = recordingLimiter(false);
    const app = makeApp(configWith(enabled), limiter);
    const res = await app.request('/delivery/s1/main/entries', {
      headers: { authorization: 'Bearer definitely-not-a-real-key' },
    });
    // 429 rather than 401: the limiter ran first and short-circuited.
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });
});

describe('budget configuration', () => {
  beforeEach(() => {
    for (const k of [
      'RATE_LIMIT_READ_PER_WINDOW',
      'RATE_LIMIT_WRITE_PER_WINDOW',
      'RATE_LIMIT_AI_PER_WINDOW',
      'RATE_LIMIT_WINDOW_SECONDS',
    ]) {
      delete process.env[k];
    }
  });

  it('defaults to disabled so existing deployments are unaffected', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.rateLimit).toEqual({ read: 0, write: 0, ai: 0, windowSeconds: 60 });
    expect(rateLimitEnabled(config.rateLimit)).toBe(false);
  });

  it('reads budgets from the environment', () => {
    const config = loadConfig({
      RATE_LIMIT_READ_PER_WINDOW: '600',
      RATE_LIMIT_WRITE_PER_WINDOW: '120',
      RATE_LIMIT_AI_PER_WINDOW: '20',
      RATE_LIMIT_WINDOW_SECONDS: '60',
    } as NodeJS.ProcessEnv);
    expect(config.rateLimit).toEqual({ read: 600, write: 120, ai: 20, windowSeconds: 60 });
    expect(rateLimitEnabled(config.rateLimit)).toBe(true);
  });

  it('treats garbage and negative budgets as "no limit", not as zero-allowance', () => {
    const config = loadConfig({
      RATE_LIMIT_READ_PER_WINDOW: 'not-a-number',
      RATE_LIMIT_WRITE_PER_WINDOW: '-5',
      RATE_LIMIT_WINDOW_SECONDS: '0',
    } as NodeJS.ProcessEnv);
    expect(config.rateLimit?.read).toBe(0);
    expect(config.rateLimit?.write).toBe(0);
    // A zero-length window would make every budget instantly expire.
    expect(config.rateLimit?.windowSeconds).toBe(60);
  });
});

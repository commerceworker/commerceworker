import { type AuthRateLimit, clientIp } from '@commerceworker/platform/auth-rate-limit';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
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
}) as ApiConfig;

/** Recording fake for the injected (distributed) limiter seam. */
function fakeLimiter(blocked = false) {
  const calls: { method: string; key: string }[] = [];
  const limiter: AuthRateLimit = {
    async isBlocked(key) {
      calls.push({ method: 'isBlocked', key });
      return blocked;
    },
    async recordFailure(key) {
      calls.push({ method: 'recordFailure', key });
      return false;
    },
    async clear(key) {
      calls.push({ method: 'clear', key });
    },
  };
  return { limiter, calls };
}

function makeApp(limiter: AuthRateLimit) {
  const { ctx, rag, blob, ai, bus } = wire(config);
  return createApp(ctx, config, rag, blob, ai, inMemoryEdge(), bus, limiter);
}

describe('injected auth rate limiter (distributed seam)', () => {
  it('keys failures by CF-Connecting-IP and records them on bad tokens', async () => {
    const { limiter, calls } = fakeLimiter();
    const app = makeApp(limiter);
    const res = await app.request('/auth/me', {
      headers: { authorization: 'Bearer wrong', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([
      { method: 'isBlocked', key: '203.0.113.9' },
      { method: 'recordFailure', key: '203.0.113.9' },
    ]);
  });

  it('never touches the limiter for requests with no credentials at all', async () => {
    const { limiter, calls } = fakeLimiter(true); // even a blocked IP gets a plain 401
    const app = makeApp(limiter);
    const res = await app.request('/auth/me', {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('returns 429 before touching auth when the limiter reports blocked', async () => {
    const { limiter, calls } = fakeLimiter(true);
    const app = makeApp(limiter);
    const res = await app.request('/auth/me', {
      headers: { authorization: 'Bearer admin', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.status).toBe(429);
    expect(calls).toEqual([{ method: 'isBlocked', key: '203.0.113.9' }]);
  });

  it('clears the window on successful auth', async () => {
    const { limiter, calls } = fakeLimiter();
    const app = makeApp(limiter);
    const res = await app.request('/auth/me', {
      headers: { authorization: 'Bearer admin', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['isBlocked', 'clear']);
  });
});

describe('clientIp', () => {
  it('prefers CF-Connecting-IP (not client-forgeable)', () => {
    expect(clientIp({ cfConnectingIp: '9.9.9.9', forwardedFor: '1.1.1.1' })).toBe('9.9.9.9');
  });

  it('parses X-Forwarded-For from the right by trusted-proxy depth', () => {
    // With 1 trusted proxy, the client is the last (proxy-written) hop.
    expect(clientIp({ forwardedFor: '1.1.1.1, 2.2.2.2, 3.3.3.3', trustedProxyCount: 1 })).toBe(
      '3.3.3.3',
    );
    // A client-prepended spoof entry is ignored — still the real proxy-written hop.
    expect(clientIp({ forwardedFor: 'spoof, 3.3.3.3', trustedProxyCount: 1 })).toBe('3.3.3.3');
    // Two trusted proxies → the client is 2nd from the end.
    expect(clientIp({ forwardedFor: 'spoof, 2.2.2.2, 3.3.3.3', trustedProxyCount: 2 })).toBe(
      '2.2.2.2',
    );
  });

  it('defaults to one trusted proxy (rightmost hop)', () => {
    expect(clientIp({ forwardedFor: '1.1.1.1, 2.2.2.2' })).toBe('2.2.2.2');
  });

  it('ignores X-Forwarded-For entirely when no proxies are trusted', () => {
    expect(clientIp({ forwardedFor: '1.1.1.1', realIp: '3.3.3.3', trustedProxyCount: 0 })).toBe(
      '3.3.3.3',
    );
  });

  it('falls back to real IP then unknown', () => {
    expect(clientIp({ realIp: '3.3.3.3' })).toBe('3.3.3.3');
    expect(clientIp({})).toBe('unknown');
  });
});

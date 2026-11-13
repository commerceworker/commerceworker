import { beforeEach, describe, expect, it, vi } from 'vitest';

// /.well-known/security.txt through the web Worker's own `fetch`, with the real setup gate: a
// workspace that has no people yet must still tell a researcher where to report.

const env: Record<string, string | undefined> = {
  PRINCIPAL_KEY: 'test-principal-key-0123456789abcdef',
};
vi.mock('cloudflare:workers', () => ({
  env,
  waitUntil: () => {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
vi.mock('virtual:react-router/server-build', () => ({}));
const page = vi.fn(async () => new Response('<html>app</html>'));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  createRequestHandler: () => page,
}));
const people = { n: 0 };
vi.mock('~/lib/wire.server', () => ({
  authStore: () => ({ userCount: async () => people.n }),
  d1Writable: async () => {},
}));
vi.mock('~/lib/env.server', () => ({
  docs: () => ({}),
  engine: () => ({}),
  catalog: () => ({}),
  afterResponse: () => {},
}));

const { default: worker } = await import('../workers/app');
const { forgetUserCount } = await import('../app/lib/auth.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(
    new Request(`https://acme.commerceworker.com${path}`, init) as never,
    env as never,
    ctx,
  );

describe('GET /.well-known/security.txt through the web Worker', () => {
  beforeEach(() => {
    env.DEMO_MODE = undefined;
    people.n = 0;
    forgetUserCount();
    page.mockClear();
  });

  it('answers while the workspace is awaiting setup, with its security headers', async () => {
    // The gate is up: anything else is refused until the first admin signs up.
    expect((await call('/api/v1/orders', { method: 'POST' })).status).toBe(503);

    const res = await call('/.well-known/security.txt', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    const text = await res.text();
    expect(text).toContain('Canonical: https://acme.commerceworker.com/.well-known/security.txt');
    expect(Date.parse(text.match(/^Expires: (.+)$/m)![1]!)).toBeGreaterThan(Date.now());
    // Never rendered by the app.
    expect(page).not.toHaveBeenCalled();
  });

  it('answers under the demo lock and refuses a write', async () => {
    people.n = 1;
    env.DEMO_MODE = 'true';
    expect((await call('/api/v1/integrations')).status).toBe(403);
    expect((await call('/.well-known/security.txt')).status).toBe(200);
    expect((await call('/.well-known/security.txt', { method: 'POST' })).status).toBe(405);
  });
});

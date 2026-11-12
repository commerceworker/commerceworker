import { describe, expect, it, vi } from 'vitest';

// /.well-known/security.txt through the studio Worker's own `fetch`: the studio's page, not the
// api's (gateway.test.ts), and answered before the setup gate.

vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: () => {}, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
const api = vi.fn(async () => new Response('api'));
vi.mock('~/lib/env.server', () => ({ api: () => ({ fetch: api }), delivery: () => undefined }));
// No one has signed up: every other path would be refused.
vi.mock('~/lib/auth.server', async (original) => ({
  ...(await original<typeof import('~/lib/auth.server')>()),
  awaitingSetup: async () => true,
}));

const { default: worker } = await import('../workers/app');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://cms.acme.com${path}`, init) as never, {} as never, ctx);

describe('GET /.well-known/security.txt through the studio Worker', () => {
  it('answers 200 as UTF-8 plain text with a future Expires, before setup, and never asks the api', async () => {
    expect((await call('/dashboard', { method: 'POST' })).status).toBe(503);

    const res = await call('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await res.text();
    expect(text).toContain('Canonical: https://cms.acme.com/.well-known/security.txt');
    expect(Date.parse(text.match(/^Expires: (.+)$/m)![1]!)).toBeGreaterThan(Date.now());
    expect(api).not.toHaveBeenCalled();
  });
});

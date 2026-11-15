import { readFileSync } from 'node:fs';
import { signCartGuestSession } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The buyer's surfaces are the storefront's (apps/storefront), not the admin's: a cart's start link
 * and page, a buyer's cookie, and UCP. This holds the admin to serving none of them, so a buyer's
 * credential opens nothing here and a buyer never loads the admin.
 */
const env = { PRINCIPAL_KEY: 'web-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const principal = vi.fn(async (_r: Request): Promise<null> => null);

vi.mock('cloudflare:workers', () => ({
  env,
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ fetch: engineFetch }), docs: () => ({}) }));
vi.mock('~/lib/auth.server', () => ({
  principal,
  apiPrincipal: vi.fn(),
  awaitingSetup: async () => false,
  sessionId: async () => 'ses_1',
  setupDue: () => null,
  Throttled: class extends Error {},
  TokenExpired: class extends Error {},
}));

const { webHandler: worker } = await import('../workers/app');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, { headers }) as never, env as never, ctx);

describe('the admin serves no buyer surface', () => {
  beforeEach(() => {
    engineFetch.mockClear();
    principal.mockClear();
  });

  it('refuses a buyer’s cookie on a cart’s socket: staff only here', async () => {
    const cookie = `ol_cart_1=${await signCartGuestSession(env.PRINCIPAL_KEY, { cartId: 'cart_1', id: 'guest:b1', name: 'Pat' }, Date.now() + 60_000)}`;
    for (const query of ['', '?as=guest']) {
      const res = await call(`/agents/cart-agent/cart_1${query}`, {
        upgrade: 'websocket',
        origin: 'https://app.test',
        cookie,
      });
      expect(res.status).toBe(401);
    }
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('forwards nothing to the engine for UCP or a start link', async () => {
    for (const path of ['/ucp/v1/checkout-sessions', '/.well-known/ucp', '/cart/start/cart_1/ab']) {
      // They reach the app's router, which has no route for them (the mock build has none at all).
      await call(path, { 'x-api-key': `cmw_ucp_${'k'.repeat(43)}` }).catch(() => null);
    }
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('has no route of the buyer’s in the app', () => {
    const routes = readFileSync(new URL('../app/routes.ts', import.meta.url), 'utf8');
    expect(routes).not.toMatch(/cart\/start|route\('cart\/:cartId'|cart-buy|cart-start/);
  });
});

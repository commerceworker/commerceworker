import {
  PRINCIPAL_HEADER,
  verifyCartGuest,
  verifyPlatform,
  verifyPrincipal,
} from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { STOREFRONT_KEY: 'storefront-test-key' };
const KEY = `cmw_ucp_${'k'.repeat(43)}`;

/**
 * The platforms the engine knows (by key hash) and whether agentic checkout is on: the engine
 * holds both, this Worker no database.
 */
let platforms = new Map<string, { id: string; name: string; profileUrl: string }>();
let checkoutOn = true;
const ucpPlatform = vi.fn(async (hash: string) => platforms.get(hash) ?? null);
const ucpCheckoutOn = vi.fn(async () => checkoutOn);
let engineHealth = vi.fn(async () => ({ ok: true }));
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const ucpProfile = vi.fn(async (_origin: string): Promise<Record<string, unknown> | null> => null);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: engineFetch,
    ucpProfile,
    ucpPlatform,
    ucpCheckoutOn,
    health: () => engineHealth(),
  }),
}));
/** Which budget each request was counted against, and the one a test makes refuse. */
const overBudget = vi.fn(async (_budget: string, _key: string): Promise<Response | null> => null);
vi.mock('~/lib/rate-limit', () => ({ overBudget: (b: string, k: string) => overBudget(b, k) }));

const { forgetUcpSettings, ucpDiscovery, ucpFetch } = await import('~/lib/ucp.server');
const { default: worker } = await import('../workers/app');
const { sha256Hex } = await import('@commerceworker/security/credentials');

const PROFILE = 'https://agent.example/profile';
const call = (path: string, headers: Record<string, string> = {}) =>
  ucpFetch(
    new Request(`https://shop.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{"line_items":[]}',
    }),
  );
const asPlatform = { 'x-api-key': KEY, 'ucp-agent': `profile="${PROFILE}"` };

describe('UCP on the storefront', () => {
  beforeEach(async () => {
    engineFetch.mockClear();
    overBudget.mockClear();
    forgetUcpSettings();
    platforms = new Map([
      [await sha256Hex(KEY), { id: 'ucp_1', name: 'Agent', profileUrl: PROFILE }],
    ]);
    checkoutOn = true;
  });

  it('refuses a request without a platform key', async () => {
    expect((await call('/ucp/v1/checkout-sessions')).status).toBe(401);
    expect((await call('/ucp/v1/checkout-sessions', { 'x-api-key': 'cmw_live_x' })).status).toBe(
      401,
    );
    // A revoked key lets nobody in (the engine no longer knows it).
    platforms.clear();
    expect((await call('/ucp/v1/checkout-sessions', asPlatform)).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
    // Only a hash of the key left this Worker.
    for (const [hash] of ucpPlatform.mock.calls) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("needs UCP-Agent on REST, naming the key's own profile", async () => {
    const noAgent = await call('/ucp/v1/checkout-sessions', { 'x-api-key': KEY });
    expect(noAgent.status).toBe(400);
    expect(await noAgent.json()).toMatchObject({ code: 'invalid_profile_url' });
    const other = await call('/ucp/v1/checkout-sessions', {
      'x-api-key': KEY,
      'ucp-agent': 'profile="https://evil.example/p"',
    });
    expect(other.status).toBe(403);
    // MCP names the profile in each call's meta, which the engine checks.
    expect((await call('/ucp/mcp', { 'x-api-key': KEY })).status).toBe(200);
  });

  it('answers 404 while agentic checkout is off', async () => {
    checkoutOn = false;
    expect((await call('/ucp/v1/checkout-sessions', asPlatform)).status).toBe(404);
  });

  it('forwards with a signed platform header and without the key', async () => {
    const res = await call('/ucp/v1/checkout-sessions', {
      ...asPlatform,
      authorization: 'Bearer ignored',
      cookie: 'session=x',
      [PRINCIPAL_HEADER]: 'forged',
    });
    expect(res.status).toBe(200);
    const sent = engineFetch.mock.calls[0]![0];
    expect(new URL(sent.url).pathname).toBe('/ucp/v1/checkout-sessions');
    expect(sent.headers.get('x-api-key')).toBeNull();
    expect(sent.headers.get('authorization')).toBeNull();
    expect(sent.headers.get('cookie')).toBeNull();
    expect(
      await verifyPlatform(
        [env.STOREFRONT_KEY],
        sent.headers.get(PRINCIPAL_HEADER),
        '/ucp/v1/checkout-sessions',
      ),
    ).toEqual({ id: 'ucp_1', name: 'Agent', profileUrl: PROFILE, origin: 'https://shop.example' });
    // Under the storefront key alone: the principal key (which this Worker never holds) opens it not.
    expect(
      await verifyPlatform(
        ['some-principal-key'],
        sent.headers.get(PRINCIPAL_HEADER),
        '/ucp/v1/checkout-sessions',
      ),
    ).toBeNull();
    expect(await sent.text()).toBe('{"line_items":[]}');
  });

  it('serves the profile publicly, and 404 while off', async () => {
    const off = await ucpDiscovery(new URL('https://shop.example/.well-known/ucp'));
    expect(off.status).toBe(404);
    ucpProfile.mockResolvedValueOnce({ ucp: { version: '2026-08-25' } });
    const on = await ucpDiscovery(new URL('https://shop.example/.well-known/ucp'));
    expect(on.status).toBe(200);
    expect(on.headers.get('cache-control')).toBe('public, max-age=300');
    expect(ucpProfile).toHaveBeenLastCalledWith('https://shop.example');
  });
});

describe('UCP on the Worker’s routes', () => {
  const viaWorker = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://shop.example${path}`, init) as never);

  beforeEach(async () => {
    engineFetch.mockClear();
    forgetUcpSettings();
    platforms = new Map([
      [await sha256Hex(KEY), { id: 'ucp_1', name: 'Agent', profileUrl: PROFILE }],
    ]);
    checkoutOn = true;
  });

  it('serves the profile at /.well-known/ucp and forwards /ucp/* by key, from any origin', async () => {
    ucpProfile.mockResolvedValueOnce({ ucp: { version: '2026-08-25' } });
    expect((await viaWorker('/.well-known/ucp')).status).toBe(200);
    // A platform is no browser: a foreign Origin on its POST is no cross-site forgery, so it goes
    // through on its key alone, signed as its own envelope that no other route accepts.
    const res = await viaWorker('/ucp/v1/checkout-sessions', {
      method: 'POST',
      headers: {
        ...asPlatform,
        origin: 'https://agent.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const header = engineFetch.mock.calls[0]![0].headers.get(PRINCIPAL_HEADER);
    const path = '/ucp/v1/checkout-sessions';
    expect(await verifyPlatform([env.STOREFRONT_KEY], header, path)).toMatchObject({ id: 'ucp_1' });
    expect(await verifyPrincipal([env.STOREFRONT_KEY], header, path)).toBeNull();
    expect(await verifyCartGuest([env.STOREFRONT_KEY], header, path)).toBeNull();
    // Signed for the path it was forwarded to, no other.
    expect(await verifyPlatform([env.STOREFRONT_KEY], header, '/ucp/mcp')).toBeNull();
  });

  it('refuses a key-less /ucp call at the Worker, before the engine', async () => {
    expect((await viaWorker('/ucp/v1/checkout-sessions', { method: 'POST' })).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('has no database or bucket to check: its deep health asks only the engine', async () => {
    const health = vi.fn(async () => ({ ok: true }));
    engineHealth = health;
    const res = await viaWorker('/health/deep');
    expect(res.status).toBe(200);
    expect(health).toHaveBeenCalledTimes(1);
    health.mockResolvedValueOnce({ ok: false });
    expect((await viaWorker('/health/deep')).status).toBe(503);
  });
});

describe('the catalog budget on the storefront', () => {
  const rpc = (name: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: {} },
  });
  const send = (path: string, body: unknown, headers: Record<string, string> = asPlatform) =>
    ucpFetch(
      new Request(`https://shop.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    engineFetch.mockClear();
    overBudget.mockClear();
    forgetUcpSettings();
    platforms = new Map([
      [await sha256Hex(KEY), { id: 'ucp_1', name: 'Agent', profileUrl: PROFILE }],
    ]);
    checkoutOn = true;
  });

  it('counts the catalog’s REST paths against CATALOG_LIMIT and checkout against AGENT_LIMIT', async () => {
    // Each spelling the engine routes to a catalog read, so none can be sent as a checkout call.
    for (const path of [
      '/ucp/v1/catalog/search',
      '/ucp/v1/catalog/lookup',
      '/ucp/v1/catalog/product',
      '/ucp/v1/catalog/search/',
      '/ucp/v1//catalog//search',
    ])
      await send(path, {});
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(Array(5).fill('CATALOG_LIMIT'));
    expect(overBudget.mock.calls[0]).toEqual(['CATALOG_LIMIT', '/ucp/catalog:ucp_1']);
    overBudget.mockClear();
    await send('/ucp/v1/checkout-sessions', {});
    await send('/ucp/v1/catalog', {});
    await send('/ucp/v1/orders/o1', {});
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('AGENT_LIMIT'));
    expect(overBudget.mock.calls[0]).toEqual(['AGENT_LIMIT', '/ucp:ucp_1']);
  });

  it('counts an MCP call of a catalog tool against CATALOG_LIMIT, and hands the engine the whole call', async () => {
    const body = JSON.stringify(rpc('search_catalog'));
    expect((await send('/ucp/mcp', body)).status).toBe(200);
    expect(overBudget.mock.calls).toEqual([['CATALOG_LIMIT', '/ucp/catalog:ucp_1']]);
    expect(await engineFetch.mock.calls[0]![0].text()).toBe(body);
    for (const tool of ['lookup_catalog', 'get_product']) await send('/ucp/mcp', rpc(tool));
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('CATALOG_LIMIT'));
  });

  it('counts every other MCP call, and any it cannot read, against AGENT_LIMIT', async () => {
    await send('/ucp/mcp', rpc('create_checkout'));
    await send('/ucp/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await send('/ucp/mcp', 'not json');
    await send('/ucp/mcp', rpc('search_catalog'.padEnd(300 * 1024, 'x')));
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(Array(4).fill('AGENT_LIMIT'));
    // The engine got each as it was sent, the oversized one too: it is the one that refuses it.
    expect(engineFetch).toHaveBeenCalledTimes(4);
  });

  it('counts a catalog call whose body is not declared JSON against AGENT_LIMIT, unread', async () => {
    const plain = { ...asPlatform, 'content-type': 'text/plain' };
    await send('/ucp/mcp', rpc('search_catalog'), plain);
    await send('/ucp/mcp', rpc('lookup_catalog'), plain);
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(['AGENT_LIMIT', 'AGENT_LIMIT']);
  });

  it('charges a lookup one unit an id, over REST and MCP, and stops at the first refusal', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);
    await send('/ucp/v1/catalog/lookup', { ids: ids(7) });
    expect(overBudget.mock.calls.filter((c) => c[0] === 'CATALOG_LIMIT')).toHaveLength(7);
    overBudget.mockClear();
    await send('/ucp/mcp', {
      ...rpc('lookup_catalog'),
      params: { name: 'lookup_catalog', arguments: { catalog: { ids: ids(3) } } },
    });
    expect(overBudget.mock.calls).toHaveLength(3);
    overBudget.mockClear();
    // More than a lookup takes costs what it takes; no ids, or junk, costs one.
    await send('/ucp/v1/catalog/lookup', { ids: ids(500) });
    expect(overBudget.mock.calls).toHaveLength(50);
    overBudget.mockClear();
    await send('/ucp/v1/catalog/lookup', { ids: 'x' });
    await send('/ucp/v1/catalog/lookup', 'not json');
    await send(
      '/ucp/v1/catalog/lookup',
      { ids: ids(9) },
      { ...asPlatform, 'content-type': 'text/plain' },
    );
    expect(overBudget.mock.calls).toHaveLength(3);
    overBudget.mockClear();
    // Search and product cost one each.
    await send('/ucp/v1/catalog/search', { query: 'x' });
    await send('/ucp/v1/catalog/product', { id: 'x' });
    expect(overBudget.mock.calls).toHaveLength(2);
    // A refusal on the third id stops the rest and the engine is not reached.
    overBudget.mockClear();
    engineFetch.mockClear();
    let n = 0;
    overBudget.mockImplementation(async () =>
      ++n === 3 ? new Response('slow', { status: 429 }) : null,
    );
    expect((await send('/ucp/v1/catalog/lookup', { ids: ids(20) })).status).toBe(429);
    expect(overBudget.mock.calls).toHaveLength(3);
    expect(engineFetch).not.toHaveBeenCalled();
    overBudget.mockImplementation(async () => null);
  });

  it('refuses a platform over its catalog budget without spending its checkout budget', async () => {
    overBudget.mockImplementation(async (budget) =>
      budget === 'CATALOG_LIMIT' ? new Response('slow down', { status: 429 }) : null,
    );
    expect((await send('/ucp/v1/catalog/search', {})).status).toBe(429);
    expect((await send('/ucp/mcp', rpc('search_catalog'))).status).toBe(429);
    expect(engineFetch).not.toHaveBeenCalled();
    expect(overBudget.mock.calls.map((c) => c[0])).toEqual(['CATALOG_LIMIT', 'CATALOG_LIMIT']);
    // Checkout still goes through.
    expect((await send('/ucp/v1/checkout-sessions', {})).status).toBe(200);
    overBudget.mockImplementation(async () => null);
  });

  it('keeps a platform’s catalog budget its own, and answers 404 while checkout is off', async () => {
    await send('/ucp/v1/catalog/search', {});
    expect(overBudget.mock.calls[0]![1]).toContain('ucp_1');
    overBudget.mockClear();
    checkoutOn = false;
    forgetUcpSettings();
    expect((await send('/ucp/v1/catalog/search', {})).status).toBe(404);
    expect(overBudget).not.toHaveBeenCalled();
  });
});

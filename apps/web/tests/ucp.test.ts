import { PRINCIPAL_HEADER, UCP_SETTINGS_KEY, verifyPlatform } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'web-test-key' };
const KEY = `cmw_ucp_${'k'.repeat(43)}`;

/** The platform behind KEY and the UCP settings, in memory. */
const { InMemoryUcpStore, InMemoryWorkspaceStore } = await import(
  '@commerceworker/test-kit/commerce'
);
let ucp = new InMemoryUcpStore();
let workspace = new InMemoryWorkspaceStore();
vi.mock('~/lib/wire.server', () => ({ ucpStore: () => ucp, workspaceStore: () => workspace }));
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const ucpProfile = vi.fn(async (_origin: string): Promise<Record<string, unknown> | null> => null);

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, ucpProfile }),
  afterResponse: (work: PromiseLike<unknown>) => void Promise.resolve(work),
}));
vi.mock('~/lib/rate-limit', () => ({ overBudget: async () => null }));

const { forgetUcpSettings, ucpDiscovery, ucpFetch } = await import('~/lib/ucp.server');
const { sha256Hex } = await import('~/lib/credentials');

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

describe('UCP on the web Worker', () => {
  beforeEach(async () => {
    engineFetch.mockClear();
    forgetUcpSettings();
    ucp = new InMemoryUcpStore({
      platforms: [
        { id: 'ucp_1', name: 'Agent', profileUrl: PROFILE, keyHash: await sha256Hex(KEY) },
      ],
    });
    workspace = new InMemoryWorkspaceStore({
      settings: { [UCP_SETTINGS_KEY]: JSON.stringify({ checkoutFlowId: 'tpl-storefront-order' }) },
    });
  });

  it('refuses a request without a platform key', async () => {
    expect((await call('/ucp/v1/checkout-sessions')).status).toBe(401);
    expect((await call('/ucp/v1/checkout-sessions', { 'x-api-key': 'cmw_live_x' })).status).toBe(
      401,
    );
    // A revoked key lets nobody in.
    await ucp.revokePlatform('ucp_1', 1);
    expect((await call('/ucp/v1/checkout-sessions', asPlatform)).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
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
    workspace = new InMemoryWorkspaceStore();
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
        [env.PRINCIPAL_KEY],
        sent.headers.get(PRINCIPAL_HEADER),
        '/ucp/v1/checkout-sessions',
      ),
    ).toEqual({ id: 'ucp_1', name: 'Agent', profileUrl: PROFILE, origin: 'https://shop.example' });
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

import type { Principal } from '@commerceworker/core/roles';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  verifyPrincipal,
} from '@commerceworker/security/principal';
import { InMemoryAdminAuth } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const key = 'content-gateway-test-key-0123456789';
const api = { fetch: vi.fn(async (_request: Request) => new Response('ok')) };
const env: { CONTENT_API?: typeof api } = {};
let caller: Principal | null;
let due: string | null;
let store: InMemoryAdminAuth;
vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/auth.server', () => ({
  principal: async () => caller,
  sessionId: async () => 'session-hash',
  setupDue: () => due,
}));
vi.mock('~/lib/principal.server', () => ({ principalKey: () => key }));
vi.mock('~/lib/wire.server', () => ({ contentAuthStore: () => store }));
const { contentPerson, forwardContent, contentApiPath } = await import('~/lib/content.server');

const request = (path = '/content-api/spaces/s1', method = 'GET', headers = {}) =>
  new Request(`https://admin.example.com${path}`, { method, headers });

describe('content in the commerce admin', () => {
  beforeEach(() => {
    env.CONTENT_API = api;
    api.fetch.mockClear();
    caller = { kind: 'user', id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'operator' };
    due = null;
    store = new InMemoryAdminAuth({
      users: [{ id: 'legacy', email: 'ada@example.com', name: 'Old Ada', role: 'admin' }],
    });
  });

  it('does not inherit a legacy subject or admin role from a matching email', async () => {
    expect(await contentPerson(caller!)).toMatchObject({ id: 'commerce:u1', role: 'member' });
    await store.linkCommerceSubject('legacy', 'commerce:someone-else');
    expect(await contentPerson(caller!)).toMatchObject({ id: 'commerce:u1', role: 'member' });
  });

  it('preserves a legacy subject only after explicit linking and refuses its disabled account', async () => {
    await store.linkCommerceSubject('legacy', 'commerce:u1');
    expect(await contentPerson(caller!)).toMatchObject({ id: 'legacy', role: 'member' });
    store.users.set('legacy', { ...store.users.get('legacy')!, disabledAt: 1 });
    expect((await forwardContent(request())).status).toBe(403);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('strips browser credentials and forged principals, signing only the authenticated member and exact target', async () => {
    const response = await forwardContent(
      request('/content-api/spaces/s1?x=1', 'POST', {
        cookie: 'session=secret',
        authorization: 'Bearer forged',
        [PRINCIPAL_HEADER]: 'forged',
        origin: 'https://admin.example.com',
        'x-agents-name': 'victim',
      }),
    );
    expect(response.status).toBe(200);
    const forwarded = api.fetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/spaces/s1');
    expect(new URL(forwarded.url).search).toBe('?x=1');
    for (const name of ['cookie', 'authorization', 'x-agents-name'])
      expect(forwarded.headers.has(name)).toBe(false);
    expect(
      await verifyPrincipal(
        key,
        forwarded.headers.get(PRINCIPAL_HEADER),
        principalTarget('POST', '/spaces/s1'),
      ),
    ).toMatchObject({ sub: 'commerce:u1', role: 'member', sid: 'session-hash' });
    expect(
      await verifyPrincipal(
        key,
        forwarded.headers.get(PRINCIPAL_HEADER),
        principalTarget('DELETE', '/spaces/s1'),
      ),
    ).toBeNull();
  });

  it('uses the assistant key exclusively on content sockets', async () => {
    await forwardContent(request('/content-api/agents/assistant-agent/commerce%3Au1'));
    const forwarded = api.fetch.mock.calls[0]![0];
    const target = principalTarget('GET', '/agents/assistant-agent/commerce%3Au1');
    const signed = forwarded.headers.get(PRINCIPAL_HEADER);
    expect(await verifyPrincipal(key, signed, target)).toBeNull();
    expect(
      await verifyPrincipal(await deriveAssistantPrincipalKey(key), signed, target),
    ).toMatchObject({ sub: 'commerce:u1' });
  });

  it('refuses cross-origin writes and sockets without forwarding them', async () => {
    expect(
      (
        await forwardContent(
          request('/content-api/spaces/s1', 'POST', { origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await forwardContent(
          request('/content-api/agents/assistant-agent/victim', 'GET', {
            origin: 'https://evil.example',
            upgrade: 'websocket',
          }),
        )
      ).status,
    ).toBe(403);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('refuses missing sessions, setup-due people, and deployments without content', async () => {
    caller = null;
    expect((await forwardContent(request())).status).toBe(401);
    caller = { kind: 'user', id: 'u1', name: 'Ada', role: 'admin' };
    due = 'Set up two-factor sign-in';
    expect((await forwardContent(request())).status).toBe(403);
    delete env.CONTENT_API;
    expect((await forwardContent(request())).status).toBe(404);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('keeps media signatures intact and exposes no other upstream paths', () => {
    expect(contentApiPath('/media/uploads/one')).toBe('/media/uploads/one');
    expect(contentApiPath('/content-api/health/deep')).toBeNull();
    expect(contentApiPath('/content-api/scim/v2/Users')).toBeNull();
    expect(contentApiPath('/content-api/spaces-not-real')).toBeNull();
  });

  it('sends signed-out OAuth consent through commerce sign-in with the original return path', async () => {
    caller = null;
    const response = await forwardContent(request('/content-api/oauth/authorize?client_id=client'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/content-api/oauth/authorize?client_id=client');
  });
});

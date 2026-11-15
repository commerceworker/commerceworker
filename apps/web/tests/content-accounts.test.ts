import type { Principal } from '@commerceworker/core/roles';
import { InMemoryAdminAuth } from '@commerceworker/test-kit';
import { InMemoryAuthStore } from '@commerceworker/test-kit/commerce';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let caller: Principal;
let auth: InMemoryAuthStore;
let content: InMemoryAdminAuth;
let failure: string | null;
const audit = vi.fn();
vi.mock('~/lib/content.server', () => ({ contentEnabled: () => true }));
vi.mock('~/lib/auth.server', () => ({
  requireUser: async (_request: Request, role: string) => {
    if (role !== 'admin' || caller.role !== 'admin')
      throw new Response('Forbidden', { status: 403 });
    return caller;
  },
  stepUp: async () => failure,
  stepUpMethod: async () => 'password',
}));
vi.mock('~/lib/audit.server', () => ({ audit }));
vi.mock('~/lib/wire.server', () => ({
  authStore: () => auth,
  contentAuthStore: () => content,
  contentTeamStore: () => ({}),
  workspaceStore: () => ({}),
}));
const { action } = await import('~/routes/content-accounts');
const call = (commerce = 'u1', legacy = 'legacy') =>
  action({
    request: new Request('https://app.example/content/accounts', {
      method: 'POST',
      body: new URLSearchParams({ commerce, content: legacy, password: 'correct' }),
    }),
    url: new URL('https://app.example/content/accounts'),
    pattern: '/content/accounts',
    params: {},
    context: {} as never,
  });

describe('explicit content account migration', () => {
  beforeEach(() => {
    caller = { kind: 'user', id: 'admin', name: 'Admin', role: 'admin' };
    auth = new InMemoryAuthStore({
      users: [{ id: 'u1', email: 'new@example.com', name: 'New account', role: 'operator' }],
    });
    content = new InMemoryAdminAuth({
      users: [
        {
          id: 'legacy',
          email: 'old@example.com',
          name: 'Old account',
          role: 'member',
          externalSub: 'old-oidc',
        },
      ],
    });
    failure = null;
    audit.mockClear();
  });

  it('requires an admin and successful step-up before linking', async () => {
    caller = { ...caller, role: 'operator' };
    await expect(call()).rejects.toMatchObject({ status: 403 });
    caller = { ...caller, role: 'admin' };
    failure = 'Confirm who you are';
    expect((await call()).init?.status).toBe(403);
    expect(await content.userByCommerceSubject('commerce:u1')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('links only the selected accounts once and leaves OIDC identity intact', async () => {
    expect((await call()).data.ok).toBe(true);
    expect((await content.userByCommerceSubject('commerce:u1'))?.id).toBe('legacy');
    expect((await content.userBySub('old-oidc'))?.id).toBe('legacy');
    expect((await call()).init?.status).toBe(409);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('refuses missing and disabled accounts', async () => {
    expect((await call('missing')).init?.status).toBe(400);
    auth.users.set('u1', { ...auth.users.get('u1')!, disabledAt: 1 });
    expect((await call()).init?.status).toBe(400);
    expect(await content.userByCommerceSubject('commerce:u1')).toBeUndefined();
  });
});

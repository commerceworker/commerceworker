import type { Principal } from '@commerceworker/core/roles';
import { InMemoryAdminAuth } from '@commerceworker/test-kit';
import { InMemoryAuthStore } from '@commerceworker/test-kit/commerce';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let auth: InMemoryAuthStore;
let content: InMemoryAdminAuth;
let live: { caller: Principal; seenAt: number } | null;
vi.mock('cloudflare:workers', () => ({ env: {}, WorkerEntrypoint: class {} }));
vi.mock('~/lib/wire.server', () => ({ authStore: () => auth, contentAuthStore: () => content }));
vi.mock('~/lib/auth.server', () => ({ sessionPerson: async () => live }));
const { ContentIdentity } = await import('../workers/content-identity');

describe('content sockets use the commerce identity', () => {
  beforeEach(() => {
    auth = new InMemoryAuthStore({
      users: [{ id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'operator' }],
    });
    content = new InMemoryAdminAuth({
      users: [{ id: 'legacy', email: 'ada@example.com', name: 'Old Ada', role: 'admin' }],
    });
    live = {
      caller: { kind: 'user', id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'operator' },
      seenAt: 100,
    };
  });

  it('accepts only the content subject belonging to the live commerce session', async () => {
    const identity = new ContentIdentity({} as never, {} as Env);
    expect(await identity.personNow({ sub: 'commerce:u1', sid: 'hash' }, 100)).toMatchObject({
      id: 'commerce:u1',
      role: 'member',
      seenAt: 100,
    });
    expect(await identity.personNow({ sub: 'commerce:someone-else', sid: 'hash' }, 100)).toBeNull();
    expect(await identity.personNow({ sub: 'legacy', sid: 'hash' }, 100)).toBeNull();
    await content.linkCommerceSubject('legacy', 'commerce:u1');
    expect(await identity.personNow({ sub: 'legacy', sid: 'hash' }, 100)).toMatchObject({
      id: 'legacy',
      role: 'member',
    });
    expect(await identity.personNow({ sub: 'commerce:u1', sid: 'hash' }, 100)).toBeNull();
  });

  it('refuses ended sessions and distinguishes them from deleted or disabled people without email fallback', async () => {
    const identity = new ContentIdentity({} as never, {} as Env);
    live = null;
    expect(await identity.personNow({ sub: 'commerce:u1', sid: 'ended' }, 100)).toBeNull();
    expect(await identity.personNow({ sub: 'commerce:u1' }, 100)).toMatchObject({
      id: 'commerce:u1',
    });
    expect(await identity.personNow({ sub: 'legacy' }, 100)).toBeNull();
    await content.linkCommerceSubject('legacy', 'commerce:u1');
    expect(await identity.personNow({ sub: 'legacy' }, 100)).toMatchObject({ id: 'legacy' });
    auth.users.set('u1', { ...auth.users.get('u1')!, disabledAt: 1 });
    expect(await identity.personNow({ sub: 'legacy' }, 100)).toBeNull();
  });
});

import { SESSION_TOUCH_MS, sessionIdleMs } from '@commerceworker/core';
import { InMemoryIdentityStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { livePrincipal, stillActive } from '../src/commerce';

const now = 10 ** 10;
const identity = (seen: number) =>
  new InMemoryIdentityStore({
    users: [
      { id: 'u_admin', email: 'a@x', name: 'A', role: 'admin' },
      { id: 'u_viewer', email: 'v@x', name: 'V', role: 'viewer', disabledAt: 1 },
    ],
    tokens: [
      { id: 't_live', role: 'operator', expiresAt: now + 1 },
      { id: 't_expired', role: 'operator', expiresAt: now },
    ],
    sessions: [
      {
        tokenHash: 's_admin',
        userId: 'u_admin',
        createdAt: 0,
        expiresAt: now + 1,
        lastSeenAt: seen,
      },
    ],
  });
const person = {
  kind: 'user',
  id: 'u_admin',
  name: 'A',
  role: 'admin',
  session: 's_admin',
} as never;

describe('principals as they are now', () => {
  it('opens local dev only until anyone has an account', async () => {
    const open = { kind: 'open', id: 'open', name: 'Local', role: 'admin' } as never;
    expect(await livePrincipal({ identity: identity(now) }, open, now)).toBeNull();
    expect(await livePrincipal({ identity: new InMemoryIdentityStore() }, open, now)).toMatchObject(
      {
        kind: 'open',
      },
    );
  });

  it("takes a token's current role, and nothing once it has expired", async () => {
    const tok = (id: string) => ({ kind: 'token', id, name: id, role: 'admin' }) as never;
    expect(await livePrincipal({ identity: identity(now) }, tok('t_live'), now)).toMatchObject({
      role: 'operator',
    });
    expect(await livePrincipal({ identity: identity(now) }, tok('t_expired'), now)).toBeNull();
  });

  it("ends an admin's session sooner, and counts a use only after a while", async () => {
    const idle = sessionIdleMs('admin');
    expect(await livePrincipal({ identity: identity(now - idle - 1) }, person, now)).toBeNull();
    const ids = identity(now - SESSION_TOUCH_MS - 1);
    expect(await livePrincipal({ identity: ids }, person, now, { touch: false })).toMatchObject({
      kind: 'user',
    });
    expect((await ids.session('s_admin', now, idle))?.seen).toBe(now - SESSION_TOUCH_MS - 1);
    await livePrincipal({ identity: ids }, person, now);
    expect((await ids.session('s_admin', now, idle))?.seen).toBe(now);
  });

  it('says whether a person or token may still hear about their orders', async () => {
    const ids = identity(now);
    expect(await stillActive({ identity: ids }, 'user', 'u_admin', now)).toBe(true);
    expect(await stillActive({ identity: ids }, 'user', 'u_viewer', now)).toBe(false);
    expect(await stillActive({ identity: ids }, 'token', 't_expired', now)).toBe(false);
    expect(await stillActive({ identity: ids }, 'token', 't_unknown', now)).toBe(true);
    expect(await stillActive({ identity: ids }, 'guest', 'x', now)).toBe(false);
  });
});

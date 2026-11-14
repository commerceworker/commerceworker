import { InMemoryAdminTeam } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '~/lib/roles';

vi.mock('cloudflare:workers', () => ({ env: {} }));
let store: InMemoryAdminTeam;
let writes: { table: string; op: 'update' | 'delete'; set?: unknown }[] = [];
const audit = vi.fn(async () => {});
let pepper: string | undefined;
const apiFetch = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ revokedTokens: 1, revokedGrants: 2 })),
);
vi.mock('~/lib/env.server', () => ({
  passwordPepper: () => pepper,
  api: () => ({ fetch: apiFetch }),
}));
vi.mock('~/lib/wire.server', () => ({
  adminTeam: () => store,
  adminAuth: () => store,
  adminPasskeys: () => ({
    clear: async () => {
      writes.push({ table: 'passkeys', op: 'delete' });
      return 1;
    },
  }),
}));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
const inviteRole = vi.fn<(me: Principal, id: string) => Promise<'member' | 'admin' | null>>();
vi.mock('~/lib/invites.server', () => ({ inviteRole }));

const { endAccess } = await import('~/lib/access.server');
const {
  needsStepUp,
  resetPassword,
  setDisabled,
  setRole,
  ownSessions,
  endOwnSession,
  endOtherSessions,
} = await import('~/lib/team.server');
const { resetTwoFactor } = await import('~/lib/two-factor.server');

const admin: Principal = { kind: 'user', id: 'usr_admin', name: 'Boss', role: 'admin' };
const request = new Request('https://app.test/team', { method: 'POST' });
const ann = { email: 'ann@example.com', role: 'admin' };

const touched = () =>
  writes.map((w) => (['sessions', 'passkeys'].includes(w.table) ? w.table : `${w.op} other`));

beforeEach(() => {
  store = new InMemoryAdminTeam({
    users: [
      { id: 'usr_admin', email: 'boss@example.com', name: 'Boss', role: 'admin' },
      { id: 'usr_ann', ...ann, name: 'Ann', passwordHash: 'old' },
    ],
    sessions: [
      { tokenHash: 'ann-a', userId: 'usr_ann', createdAt: 1, expiresAt: Date.now() + 10000 },
      { tokenHash: 'ann-b', userId: 'usr_ann', createdAt: 1, expiresAt: Date.now() + 10000 },
    ],
  });
  writes = [];
  const role = store.setRole.bind(store);
  vi.spyOn(store, 'setRole').mockImplementation(async (id, next) => {
    writes.push({ table: 'users', op: 'update' });
    return role(id, next);
  });
  const disabled = store.setDisabled.bind(store);
  vi.spyOn(store, 'setDisabled').mockImplementation(async (id, at) => {
    writes.push({ table: 'users', op: 'update' });
    return disabled(id, at);
  });
  const password = store.setPassword.bind(store);
  vi.spyOn(store, 'setPassword').mockImplementation(async (id, hash, temporary) => {
    writes.push({ table: 'users', op: 'update', set: { passwordHash: hash } });
    return password(id, hash, temporary);
  });
  const end = store.endSessions.bind(store);
  vi.spyOn(store, 'endSessions').mockImplementation(async (id, except) => {
    writes.push({ table: 'sessions', op: 'delete' });
    return end(id, except);
  });
  const disable = store.disableTotp.bind(store);
  vi.spyOn(store, 'disableTotp').mockImplementation(async (id) => {
    writes.push({ table: 'users', op: 'update' }, { table: 'codes', op: 'delete' });
    return disable(id);
  });
  audit.mockClear();
  apiFetch.mockClear();
});

describe('endAccess', () => {
  it('ends only what it is asked to, and counts it', async () => {
    const person = { id: 'usr_ann', email: 'ann@example.com' };
    expect(await endAccess(request, person, { sessions: true })).toEqual({
      sessions: 2,
      passkeys: 0,
      tokens: 0,
    });
    expect(touched()).toEqual(['sessions']);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(
      await endAccess(request, person, { sessions: { except: 'hash' }, passkeys: true }),
    ).toEqual({ sessions: 0, passkeys: 1, tokens: 0 });
  });

  it('ends the api’s tokens for them through the signed people route', async () => {
    const { verifyPrincipal, DEV_PRINCIPAL_KEY, principalTarget } = await import(
      '@commerceworker/security/principal'
    );
    const ended = await endAccess(
      request,
      { id: 'usr_ann', email: 'ann@example.com' },
      { tokens: true },
    );
    expect(ended.tokens).toBe(3);
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    const path = '/deployment/people/usr_ann/credentials';
    expect(url).toBe(`https://api${path}`);
    expect(init.method).toBe('DELETE');
    const signed = new Headers(init.headers).get('x-cw-principal');
    expect(
      await verifyPrincipal(DEV_PRINCIPAL_KEY, signed, principalTarget('DELETE', path)),
    ).toMatchObject({ role: 'admin' });
  });

  it('fails visibly when the api refuses, so the action can be repeated', async () => {
    apiFetch.mockResolvedValueOnce(new Response('no', { status: 503 }));
    await expect(
      endAccess(request, { id: 'usr_ann', email: 'ann@example.com' }, { tokens: true }),
    ).rejects.toThrow(/refused/);
  });
});

describe('the Team page ends what no longer fits', () => {
  it('disabling ends sessions; enabling brings none back', async () => {
    await setDisabled(request, admin, 'usr_ann', true);
    expect(touched()).toEqual(['update other', 'sessions']);
    expect(audit).toHaveBeenCalledWith(request, 'team.user_disabled', {
      actor: admin,
      target: ann.email,
      // The api revoked their tokens and grants too (1 + 2 in the fake).
      detail: { sessions: 2, tokens: 3 },
    });

    writes = [];
    await setDisabled(request, admin, 'usr_ann', false);
    expect(touched()).toEqual(['update other']);
  });

  it('a role change is recorded and takes effect on the next forwarded request', async () => {
    await setRole(request, admin, 'usr_ann', 'member');
    expect(touched()).toEqual(['update other']);
    expect(audit).toHaveBeenCalledWith(request, 'team.role_changed', {
      actor: admin,
      target: ann.email,
      detail: { from: 'admin', to: 'member' },
    });
  });

  it('refuses a role that is not a deployment role', async () => {
    await expect(setRole(request, admin, 'usr_ann', 'operator')).rejects.toThrow(/member or admin/);
  });

  it('a password reset ends sessions and passkeys', async () => {
    const { password } = await resetPassword(request, admin, 'usr_ann');
    expect(password).toBeTruthy();
    expect(touched()).toEqual(['update other', 'sessions', 'passkeys']);
  });

  it('peppers the password a reset sets, when the deployment has a pepper', async () => {
    pepper = 'p'.repeat(64);
    try {
      await resetPassword(request, admin, 'usr_ann');
      const set = writes.find((w) => w.op === 'update')?.set as { passwordHash?: string };
      expect(set.passwordHash).toMatch(/^pbkdf2p:/);
    } finally {
      pepper = undefined;
    }
  });

  it('a two-factor reset ends sessions and passkeys too', async () => {
    await store.enableTotp('usr_ann', 'sealed', 1, 1);
    await resetTwoFactor(request, admin, 'usr_ann');
    expect(touched()).toEqual(['sessions', 'passkeys', 'update other', 'delete other']);
    expect(audit).toHaveBeenCalledWith(request, 'team.two_factor_reset', {
      actor: admin,
      target: ann.email,
      detail: { sessions: 2, passkeys: 'removed', tokens: 3 },
    });
  });
});

describe('which Team page changes ask for a step-up', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it('asks before handing out access, and not for everyday changes', async () => {
    for (const intent of [
      'scim-token',
      'reset',
      'reset-two-factor',
      'sso-settings',
      'two-factor-requirement',
    ])
      expect(await needsStepUp(intent, form({ intent }))).toBe(true);
    for (const intent of ['disable', 'scim-revoke'])
      expect(await needsStepUp(intent, form({ intent }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'member' }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'admin' }))).toBe(true);
  });

  it('asks before inviting an admin, not a member', async () => {
    expect(await needsStepUp('invite', form({ role: 'admin' }), admin)).toBe(true);
    expect(await needsStepUp('invite', form({ role: 'member' }), admin)).toBe(false);
  });

  it('asks before resending unless the api says the invitation is a member’s', async () => {
    const resend = form({ intent: 'invite-resend', id: 'inv-1' });
    inviteRole.mockResolvedValueOnce('member');
    expect(await needsStepUp('invite-resend', resend, admin)).toBe(false);
    expect(inviteRole).toHaveBeenLastCalledWith(admin, 'inv-1');
    inviteRole.mockResolvedValueOnce('admin');
    expect(await needsStepUp('invite-resend', resend, admin)).toBe(true);
    // Not found (an admin's invitation pushed off any page, or gone): ask.
    inviteRole.mockResolvedValueOnce(null);
    expect(await needsStepUp('invite-resend', resend, admin)).toBe(true);
    // The lookup failing outright: ask, never wave it through.
    inviteRole.mockRejectedValueOnce(new Error('api down'));
    await expect(needsStepUp('invite-resend', resend, admin)).resolves.toBe(true);
    // A form claiming a member's role changes nothing: the api's answer decides.
    inviteRole.mockResolvedValueOnce('admin');
    expect(await needsStepUp('invite-resend', form({ id: 'inv-1', role: 'member' }), admin)).toBe(
      true,
    );
  });

  it('asks before making someone an admin, not when they already are one', async () => {
    await store.setRole('usr_ann', 'member');
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(true);
    await store.setRole('usr_ann', 'admin');
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(false);
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'member' }))).toBe(false);
  });

  it('asks before a group is mapped to Admin, and before enabling an admin', async () => {
    expect(await needsStepUp('scim-roles', form({ 'role:grp_1': 'admin' }))).toBe(true);
    expect(
      await needsStepUp('scim-roles', form({ 'role:grp_1': 'member', 'role:grp_2': '' })),
    ).toBe(false);
    await store.setRole('usr_ann', 'admin');
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(true);
    await store.setRole('usr_ann', 'member');
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(false);
  });
});

describe('own session management', () => {
  const me = { ...admin, id: 'usr_ann', email: ann.email };
  const current = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const foreign = 'c'.repeat(64);
  const put = (hash: string, userId = me.id, createdAt = Date.now()) =>
    store.startSession({
      tokenHash: hash,
      userId,
      createdAt,
      expiresAt: Date.now() + 100_000,
      ip: '203.0.113.7',
      userAgent: 'Safari',
    });
  it('lists only the person’s unexpired, non-idle sessions with the current browser first', async () => {
    await put(current);
    await put(other);
    await put(foreign, admin.id);
    await put('d'.repeat(64), me.id, Date.now() - 86_400_000);
    const listed = await ownSessions(me, current);
    expect(listed.map((r) => [r.ref, r.current])).toEqual([
      [current.slice(0, 16), true],
      [other.slice(0, 16), false],
    ]);
    expect(
      await ownSessions({ kind: 'open', id: 'local', name: 'local', role: 'admin' }, current),
    ).toEqual([]);
  });
  it('refuses the current browser, malformed references and another person’s session', async () => {
    await put(current);
    await put(foreign, admin.id);
    await expect(endOwnSession(request, me, current.slice(0, 16), current)).rejects.toThrow(
      /Sign out/,
    );
    await expect(endOwnSession(request, me, 'invalid', current)).rejects.toThrow(/no longer/);
    await expect(endOwnSession(request, me, foreign.slice(0, 16), current)).rejects.toThrow(
      /no longer/,
    );
    expect(await store.session(current)).toBeDefined();
    expect(await store.session(foreign)).toBeDefined();
  });
  it('ends an owned session by reference and audits it', async () => {
    await put(other);
    await endOwnSession(request, me, other.slice(0, 16), current);
    expect(await store.session(other)).toBeUndefined();
    expect(audit).toHaveBeenLastCalledWith(request, 'auth.session_ended', {
      actor: me,
      target: ann.email,
      detail: { device: expect.any(String), ip: '203.0.113.7' },
    });
  });
  it('ends other sessions once, preserves the current browser and foreign sessions, and audits the actual count', async () => {
    await store.endSessions(me.id);
    await put(current);
    await put(other);
    await put(foreign, admin.id);
    expect(await endOtherSessions(request, me, current)).toBe(1);
    expect(await endOtherSessions(request, me, current)).toBe(0);
    expect(await store.session(current)).toBeDefined();
    expect(await store.session(foreign)).toBeDefined();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(request, 'auth.other_sessions_ended', {
      actor: me,
      target: ann.email,
      detail: { count: 1 },
    });
  });
});

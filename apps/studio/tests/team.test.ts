import { passkeys, sessions } from '@commerceworker/store/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '~/lib/roles';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** What the next `select … get()` reads, in order; what was written, and to which table. */
let rows: unknown[] = [];
let writes: { table: unknown; op: 'update' | 'delete'; set?: unknown }[] = [];
/** How many rows each table's write `returning()` reports. */
let returned = new Map<unknown, number>();
const done = (table: unknown) =>
  Object.assign(Promise.resolve(), {
    returning: async () => Array.from({ length: returned.get(table) ?? 0 }, (_, i) => ({ id: i })),
  });
const fakeDb = {
  select: () => {
    const q = { from: () => q, where: () => q, get: async () => rows.shift() };
    return q;
  },
  insert: () => ({ values: async () => {} }),
  update: (table: unknown) => ({
    set: (set: unknown) => ({
      where: () => {
        writes.push({ table, op: 'update', set });
        return done(table);
      },
    }),
  }),
  delete: (table: unknown) => ({
    where: () => {
      writes.push({ table, op: 'delete' });
      return done(table);
    },
  }),
};
const audit = vi.fn(async () => {});

let pepper: string | undefined;
/** The api's people route: answers how many credentials it revoked. */
const apiFetch = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ revokedTokens: 1, revokedGrants: 2 })),
);
vi.mock('~/lib/env.server', () => ({
  passwordPepper: () => pepper,
  db: () => fakeDb,
  api: () => ({ fetch: apiFetch }),
}));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
/** An invitation's role as the api reads it by id; rejects or answers null like the real one. */
const inviteRole = vi.fn<(me: Principal, id: string) => Promise<'member' | 'admin' | null>>();
vi.mock('~/lib/invites.server', () => ({ inviteRole }));

const { endAccess } = await import('~/lib/access.server');
const { needsStepUp, resetPassword, setDisabled, setRole } = await import('~/lib/team.server');
const { resetTwoFactor } = await import('~/lib/two-factor.server');

const admin: Principal = { kind: 'user', id: 'usr_admin', name: 'Boss', role: 'admin' };
const request = new Request('https://app.test/team', { method: 'POST' });
const ann = { email: 'ann@example.com', role: 'admin' };

const touched = () =>
  writes.map((w) =>
    w.table === sessions ? 'sessions' : w.table === passkeys ? 'passkeys' : `${w.op} other`,
  );

beforeEach(() => {
  rows = [];
  writes = [];
  returned = new Map<unknown, number>([
    [sessions, 2],
    [passkeys, 1],
  ]);
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
    ).toEqual({ sessions: 2, passkeys: 1, tokens: 0 });
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
    rows = [{ id: 'usr_other_admin' }, ann];
    await setDisabled(request, admin, 'usr_ann', true);
    expect(touched()).toEqual(['update other', 'sessions']);
    expect(audit).toHaveBeenCalledWith(request, 'team.user_disabled', {
      actor: admin,
      target: ann.email,
      // The api revoked their tokens and grants too (1 + 2 in the fake).
      detail: { sessions: 2, tokens: 3 },
    });

    writes = [];
    rows = [ann];
    await setDisabled(request, admin, 'usr_ann', false);
    expect(touched()).toEqual(['update other']);
  });

  it('a role change is recorded and takes effect on the next forwarded request', async () => {
    rows = [{ id: 'usr_other_admin' }, ann];
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
    rows = [ann];
    const { password } = await resetPassword(request, admin, 'usr_ann');
    expect(password).toBeTruthy();
    expect(touched()).toEqual(['update other', 'sessions', 'passkeys']);
  });

  it('peppers the password a reset sets, when the deployment has a pepper', async () => {
    pepper = 'p'.repeat(64);
    try {
      rows = [ann];
      await resetPassword(request, admin, 'usr_ann');
      const set = writes.find((w) => w.op === 'update')?.set as { passwordHash?: string };
      expect(set.passwordHash).toMatch(/^pbkdf2p:/);
    } finally {
      pepper = undefined;
    }
  });

  it('a two-factor reset ends sessions and passkeys too', async () => {
    rows = [{ email: ann.email, enabledAt: 1 }];
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
    rows = [{ role: 'member' }];
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(true);
    rows = [{ role: 'admin' }];
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(false);
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'member' }))).toBe(false);
  });

  it('asks before a group is mapped to Admin, and before enabling an admin', async () => {
    expect(await needsStepUp('scim-roles', form({ 'role:grp_1': 'admin' }))).toBe(true);
    expect(
      await needsStepUp('scim-roles', form({ 'role:grp_1': 'member', 'role:grp_2': '' })),
    ).toBe(false);
    rows = [{ role: 'admin' }];
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(true);
    rows = [{ role: 'member' }];
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(false);
  });
});

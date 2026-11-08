import type { Principal } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/**
 * The team in memory: Boss (an admin, who makes the changes), another admin, and Ann (an admin
 * with two sessions, an admin token and a passkey), the same people in the auth and workspace
 * stores as in D1's one `users` table.
 */
const { InMemoryAuthStore, InMemoryWorkspaceStore } = await import(
  '@commerceworker/test-kit/commerce'
);
type Person = { id: string; email: string; name: string; role: string; disabledAt: number | null };
const people: Person[] = [
  { id: 'usr_admin', email: 'boss@example.com', name: 'Boss', role: 'admin', disabledAt: null },
  { id: 'usr_other_admin', email: 'o@example.com', name: 'Other', role: 'admin', disabledAt: null },
  { id: 'usr_ann', email: 'ann@example.com', name: 'Ann', role: 'admin', disabledAt: null },
];
let auth: InstanceType<typeof InMemoryAuthStore>;
let workspace: InstanceType<typeof InMemoryWorkspaceStore>;
/** Ann's passkeys, which the passkey store clears. */
let passkeys = 0;
function seed(over: Partial<Person>[] = []) {
  const team = people.map((p, i) => ({ ...p, ...over[i] }));
  auth = new InMemoryAuthStore({
    users: team.map((p) => ({ ...p, passwordHash: 'pbkdf2$old' })),
    sessions: ['s1', 's2'].map((tokenHash) => ({
      tokenHash,
      userId: 'usr_ann',
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    })),
  });
  workspace = new InMemoryWorkspaceStore({
    members: team,
    tokens: [
      { id: 'tok_ann', role: 'admin', createdById: 'usr_ann', createdBy: 'ann@example.com' },
    ],
  });
  passkeys = 1;
}
vi.mock('~/lib/wire.server', () => ({
  authStore: () => auth,
  workspaceStore: () => workspace,
  passkeyStore: () => ({
    clear: async () => {
      const n = passkeys;
      passkeys = 0;
      return n;
    },
  }),
}));

/** Connected apps, a page of the provider's listing at a time. */
let grantPages: { items: { id: string }[]; cursor?: string }[] = [];
const revokeGrant = vi.fn(async () => {});
const audit = vi.fn(async (..._args: unknown[]) => {});
const dropA2aPushes = vi.fn(async () => ({ configs: 0 }));
let pepper: string | undefined;
vi.mock('~/lib/env.server', () => ({
  passwordPepper: () => pepper,
  engine: () => ({ dropA2aPushes }),
}));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/oauth.server', () => ({
  oauthApi: () => ({
    listUserGrants: async (_id: string, o?: { cursor?: string }) =>
      grantPages[o?.cursor ? Number(o.cursor) : 0] ?? { items: [] },
    revokeGrant,
  }),
}));

const { endAccess } = await import('~/lib/access.server');
const { createToken, needsStepUp, resetPassword, revokeToken, setDisabled, TeamError } =
  await import('~/lib/team.server');
const { resetTwoFactor } = await import('~/lib/two-factor.server');

const admin: Principal = { kind: 'user', id: 'usr_admin', name: 'Boss', role: 'admin' };
const request = new Request('https://app.test/team', { method: 'POST' });
const ann = { id: 'usr_ann', email: 'ann@example.com' };

/** What Ann still has. */
const left = async () => ({
  sessions: (await auth.sessionsOf('usr_ann', 0)).length,
  tokens: workspace.tokens.filter((t) => !t.revokedAt).length,
  passkeys,
});

beforeEach(() => {
  seed();
  grantPages = [{ items: [{ id: 'grant_1' }, { id: 'grant_2' }] }];
  dropA2aPushes.mockClear();
  revokeGrant.mockClear();
  audit.mockClear();
});

describe('endAccess', () => {
  it('ends only what it is asked to, and counts it', async () => {
    expect(await endAccess(request, ann, { sessions: true })).toEqual({
      sessions: 2,
      apps: 0,
      tokens: 0,
      passkeys: 0,
    });
    expect(await left()).toEqual({ sessions: 0, tokens: 1, passkeys: 1 });
    seed();
    expect(
      await endAccess(request, ann, {
        sessions: { except: 's1' },
        tokens: true,
        apps: true,
        passkeys: true,
      }),
    ).toEqual({ sessions: 1, apps: 2, tokens: 1, passkeys: 1 });
    expect(await left()).toEqual({ sessions: 1, tokens: 0, passkeys: 0 });
    expect(revokeGrant.mock.calls).toEqual([
      ['grant_1', 'usr_ann'],
      ['grant_2', 'usr_ann'],
    ]);
    // An A2A app's push configs go with its grant.
    expect(dropA2aPushes).toHaveBeenCalledWith('user', 'usr_ann', ['grant_1', 'grant_2']);
  });

  it('revokes every page of connected apps', async () => {
    grantPages = [
      { items: [{ id: 'grant_1' }], cursor: '1' },
      { items: [{ id: 'grant_2' }], cursor: '2' },
      { items: [{ id: 'grant_3' }] },
    ];
    const ended = await endAccess(request, ann, { apps: true });
    expect(ended.apps).toBe(3);
    expect(revokeGrant).toHaveBeenCalledTimes(3);
  });

  it('has no token above admin to revoke', async () => {
    await endAccess(request, ann, { tokens: { above: 'admin' } });
    expect(await left()).toEqual({ sessions: 2, tokens: 1, passkeys: 1 });
  });
});

describe('the Team page ends what no longer fits', () => {
  it('disabling ends sessions, connected apps and their tokens; enabling brings none back', async () => {
    await setDisabled(request, admin, 'usr_ann', true);
    expect((await workspace.member('usr_ann'))?.disabledAt).toEqual(expect.any(Number));
    expect(await left()).toEqual({ sessions: 0, tokens: 0, passkeys: 1 });
    expect(revokeGrant).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(request, 'team.user_disabled', {
      actor: admin,
      target: ann.email,
      detail: { sessions: 2, tokens: 1, apps: 2 },
    });

    revokeGrant.mockClear();
    await setDisabled(request, admin, 'usr_ann', false);
    expect((await workspace.member('usr_ann'))?.disabledAt).toBeNull();
    expect(await left()).toEqual({ sessions: 0, tokens: 0, passkeys: 1 });
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('keeps the last active admin', async () => {
    seed([{}, { disabledAt: 5 }, { role: 'viewer' }]);
    await expect(setDisabled(request, admin, 'usr_admin', true)).rejects.toThrow(/yourself/);
    seed([{}, { disabledAt: 5 }]);
    // Ann is the other active admin; with her gone, Boss would be the last.
    await setDisabled(request, admin, 'usr_ann', true);
    seed([{ disabledAt: 5 }, { disabledAt: 5 }]);
    const boss = { ...admin, id: 'usr_other_admin' };
    await expect(setDisabled(request, boss, 'usr_ann', true)).rejects.toThrow(/no admin/);
  });

  it('a password reset sets a temporary password and ends sessions, connected apps and passkeys', async () => {
    const { password } = await resetPassword(request, admin, 'usr_ann');
    expect(password).toBeTruthy();
    expect(await auth.user('usr_ann')).toMatchObject({
      passwordChangeDue: true,
      passwordExpiresAt: expect.any(Number),
    });
    expect((await auth.user('usr_ann'))?.passwordHash).not.toBe('pbkdf2$old');
    expect(await left()).toEqual({ sessions: 0, tokens: 1, passkeys: 0 });
    expect(revokeGrant).toHaveBeenCalledTimes(2);
  });

  it('peppers the password a reset sets, when the deployment has a pepper', async () => {
    pepper = 'p'.repeat(64);
    try {
      await resetPassword(request, admin, 'usr_ann');
      expect((await auth.user('usr_ann'))?.passwordHash).toMatch(/^pbkdf2p:/);
    } finally {
      pepper = undefined;
    }
  });

  it('a two-factor reset ends sessions, connected apps and passkeys too', async () => {
    seed();
    await auth.enableTotp('usr_ann', 'sealed', 1, 1);
    await resetTwoFactor(request, admin, 'usr_ann');
    expect((await auth.user('usr_ann'))?.totpEnabledAt).toBeNull();
    expect(await left()).toEqual({ sessions: 0, tokens: 1, passkeys: 0 });
    expect(revokeGrant).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(request, 'team.two_factor_reset', {
      actor: admin,
      target: ann.email,
      detail: { sessions: 2, apps: 2, passkeys: 'removed' },
    });
  });

  it('takes back a token whose maker was disabled or demoted while it was being made', async () => {
    const input = { name: 'ERP sync', role: 'admin', lifetime: '30' };
    expect((await createToken(request, admin, input)).token).toMatch(/^cmw_live_/);
    const made = () => workspace.tokens.filter((t) => t.createdById === 'usr_admin');
    expect(made()).toMatchObject([{ revokedAt: null }]);

    for (const now of [{ disabledAt: 5 }, { role: 'operator' }]) {
      seed([now]);
      // The maker as they are once the row exists: the request still carries the old principal.
      await expect(createToken(request, admin, input)).rejects.toBeInstanceOf(TeamError);
      expect(made()).toMatchObject([{ revokedAt: expect.any(Number) }]);
    }
  });

  it('revokes a token once, and audits it once', async () => {
    await revokeToken(request, admin, 'tok_ann');
    await revokeToken(request, admin, 'tok_ann');
    await revokeToken(request, admin, 'tok_none');
    expect(await left()).toMatchObject({ tokens: 0 });
    expect(audit.mock.calls.filter((c) => c[1] === 'token.revoked')).toHaveLength(1);
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
      'add-token',
      'scim-token',
      'reset',
      'reset-two-factor',
      'sso-settings',
      'two-factor-requirement',
    ])
      expect(await needsStepUp(intent, form({ intent }))).toBe(true);
    for (const intent of ['disable', 'revoke', 'scim-revoke', 'approval-separation'])
      expect(await needsStepUp(intent, form({ intent }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'operator' }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'admin' }))).toBe(true);
  });

  it('asks before making someone an admin, not when they already are one', async () => {
    seed([{}, {}, { role: 'operator' }]);
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(true);
    seed();
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(false);
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'viewer' }))).toBe(false);
  });

  it('asks before a group is mapped to Admin, and before enabling anyone above Viewer', async () => {
    expect(await needsStepUp('scim-roles', form({ 'role:grp_1': 'admin' }))).toBe(true);
    expect(
      await needsStepUp('scim-roles', form({ 'role:grp_1': 'operator', 'role:grp_2': '' })),
    ).toBe(false);
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(true);
    seed([{}, {}, { role: 'viewer' }]);
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(false);
  });
});

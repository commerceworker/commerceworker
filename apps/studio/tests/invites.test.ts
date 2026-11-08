import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

// ── People: just enough of drizzle to look them up by one column, add one, and change a role ──
type Person = {
  id: string;
  email: string;
  name: string;
  role: string;
  externalSub?: string | null;
  passwordHash?: string | null;
  disabledAt?: number | null;
};
let people: Person[] = [];
let insertFails = false;
const COLUMN: Record<string, keyof Person> = {
  id: 'id',
  email: 'email',
  external_sub: 'externalSub',
};

/** The column and value an `eq(column, value)` condition names. */
function condition(cond: unknown): { key: keyof Person; value: unknown } {
  const chunks = (cond as { queryChunks: unknown[] }).queryChunks;
  let key: keyof Person = 'id';
  let value: unknown;
  for (const c of chunks) {
    const o = c as { name?: string; value?: unknown; constructor: { name: string } };
    if (o && typeof o === 'object' && 'columnType' in o && o.name) key = COLUMN[o.name] ?? key;
    if (o && typeof o === 'object' && o.constructor.name === 'Param') value = o.value;
  }
  return { key, value };
}
const fakeDb = {
  select: () => ({
    from: () => ({
      where: (cond: unknown) => ({
        get: async () => {
          const { key, value } = condition(cond);
          return people.find((p) => p[key] === value);
        },
      }),
    }),
  }),
  insert: () => ({
    values: async (row: Person) => {
      // As drizzle's: the failed statement's parameters, password hash included, in the message.
      if (insertFails || people.some((p) => p.email === row.email))
        throw new Error(
          `Failed query: insert into "users" params: ${row.id},${row.email},${row.passwordHash} | UNIQUE constraint failed: users.email`,
        );
      people.push(row);
    },
  }),
  update: () => ({
    set: (v: Partial<Person>) => ({
      where: async (cond: unknown) => {
        const { key, value } = condition(cond);
        for (const p of people) if (p[key] === value) Object.assign(p, v);
      },
    }),
  }),
};

// ── The api, over the binding: who each call was signed for, and what it answers ──
type Call = { path: string; by: { id: string; role: string }; body: Record<string, unknown> };
let calls: Call[] = [];
let answers: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }>;
const apiFetcher = {
  fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Headers;
    const by = JSON.parse(headers.get('x-test-principal') ?? '{}');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, by, body });
    const answer = answers[path]?.(body) ?? { status: 404, body: {} };
    return Response.json(answer.body, { status: answer.status });
  },
};
vi.mock('~/lib/env.server', () => ({
  db: () => fakeDb,
  api: () => apiFetcher,
  passwordPepper: () => undefined,
}));
vi.mock('~/lib/principal.server', () => ({
  setPrincipalHeader: async (h: Headers, p: { id: string; role: string }) =>
    h.set('x-test-principal', JSON.stringify({ id: p.id, role: p.role })),
}));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.9' }));
const recordFailure = vi.fn();
let wait = 0;
class Throttled extends Error {}
vi.mock('~/lib/auth.server', () => ({
  waitFor: async () => wait,
  recordFailure,
  Throttled,
  forgetUserCount: () => {},
}));
let ssoOnly = false;
vi.mock('~/lib/settings.server', () => ({ ssoOnlyInEffect: async () => ssoOnly }));

const {
  acceptSignedIn,
  createInvite,
  InviteError,
  inviteRole,
  joinWithPassword,
  joinWithSso,
  readInvite,
} = await import('~/lib/invites.server');
const { INVITE_INVALID, INVITE_NOT_ACCEPTED } = await import('~/lib/invites');

const TOKEN = `cwi_${'a'.repeat(43)}`;
const req = () => new Request('https://acme.commerceworker.com/invite/x', { method: 'POST' });
const preview = (over: Record<string, unknown> = {}) => ({
  invite: {
    id: 'inv-1',
    email: 'grace@example.com',
    role: 'member',
    grants: [{ spaceId: 'blog', roleId: 'r1' }],
    status: 'pending',
    expiresAt: '2026-11-08T00:00:00.000Z',
    invitedBy: { kind: 'user', id: 'usr_ada' },
    ...over,
  },
  spaces: [{ spaceId: 'blog', name: 'Blog', roleId: 'r1', role: 'Editor' }],
});
const invalid = { status: 400, body: { error: { code: 'invalid_invite', message: 'x' } } };

/** Nothing the module wrote to the audit log or the console carries the token. */
function expectTokenNowhere() {
  expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN);
}

describe('accepting an invitation', () => {
  beforeEach(() => {
    people = [{ id: 'usr_ada', email: 'ada@example.com', name: 'Ada', role: 'admin' }];
    insertFails = false;
    calls = [];
    wait = 0;
    ssoOnly = false;
    audit.mockReset();
    recordFailure.mockReset();
    answers = {
      '/deployment/invites/lookup': () => ({ status: 200, body: preview() }),
      '/deployment/invites/accept': () => ({
        status: 200,
        body: { role: 'member', grants: [{ spaceId: 'blog', outcome: 'added' }] },
      }),
    };
  });

  it('shows who invited them, read as the deployment', async () => {
    const found = await readInvite(req(), TOKEN);
    expect(found?.page).toMatchObject({ email: 'grace@example.com', inviter: 'Ada' });
    expect(calls[0]).toMatchObject({ by: { id: 'system:web' }, body: { token: TOKEN } });
  });

  it('counts and audits a link that doesn’t work, without the token', async () => {
    answers['/deployment/invites/lookup'] = () => invalid;
    expect(await readInvite(req(), TOKEN)).toBeNull();
    expect(recordFailure).toHaveBeenCalledWith(['invite-ip:203.0.113.9']);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.invite_failed', {
      actor: null,
      detail: { reason: 'invalid link' },
    });
    expectTokenNowhere();
  });

  it('stops honouring an inviter who is no longer an admin', async () => {
    people[0]!.role = 'member';
    expect(await readInvite(req(), TOKEN)).toBeNull();
    people[0]!.role = 'admin';
    people[0]!.disabledAt = 1;
    expect(await readInvite(req(), TOKEN)).toBeNull();
  });

  it('redeems before creating the person, under the id they then get', async () => {
    const id = await joinWithPassword(req(), TOKEN, {
      name: 'Grace',
      password: 'a long passphrase here',
    });
    const accept = calls.find((c) => c.path === '/deployment/invites/accept');
    expect(accept?.by.id).toBe('system:web');
    expect(accept?.body.person).toEqual({ subject: id, email: 'grace@example.com' });
    const grace = people.find((p) => p.id === id);
    expect(grace).toMatchObject({ email: 'grace@example.com', role: 'member', name: 'Grace' });
    expect(grace?.passwordHash).toMatch(/^pbkdf2/);
    expect(audit).toHaveBeenCalledWith(
      expect.any(Request),
      'team.invite_accepted',
      expect.objectContaining({ target: 'grace@example.com' }),
    );
    expectTokenNowhere();
  });

  it('refuses a weak password before spending the link', async () => {
    await expect(
      joinWithPassword(req(), TOKEN, { name: '', password: 'short' }),
    ).rejects.toBeInstanceOf(InviteError);
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
  });

  it('says the same thing whether the address has an account or the link lost a race', async () => {
    people.push({ id: 'usr_g', email: 'grace@example.com', name: 'G', role: 'member' });
    const taken = await joinWithPassword(req(), TOKEN, {
      name: '',
      password: 'a long passphrase here',
    }).catch((e: Error) => e.message);
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
    people.pop();
    answers['/deployment/invites/accept'] = () => invalid;
    const raced = await joinWithPassword(req(), TOKEN, {
      name: '',
      password: 'a long passphrase here',
    }).catch((e: Error) => e.message);
    expect(taken).toBe(INVITE_NOT_ACCEPTED);
    expect(raced).toBe(INVITE_NOT_ACCEPTED);
    // Nobody was created from the lost race.
    expect(people.map((p) => p.email)).toEqual(['ada@example.com']);
  });

  it('fails closed when the account can’t be written after the link is spent', async () => {
    insertFails = true;
    await expect(
      joinWithPassword(req(), TOKEN, { name: '', password: 'a long passphrase here' }),
    ).rejects.toThrow(INVITE_NOT_ACCEPTED);
    expect(people).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.invite_failed', {
      target: 'grace@example.com',
      detail: { reason: 'account not created after accepting', constraint: 'users_email' },
    });
    // The error (and the password hash in it) is never recorded.
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/pbkdf2|Failed query/);
  });

  it('is throttled per address, before asking the api anything', async () => {
    wait = 60_000;
    await expect(
      joinWithPassword(req(), TOKEN, { name: '', password: 'a long passphrase here' }),
    ).rejects.toBeInstanceOf(Throttled);
    expect(calls).toHaveLength(0);
  });

  it('takes no password where the workspace is SSO-only', async () => {
    ssoOnly = true;
    await expect(
      joinWithPassword(req(), TOKEN, { name: '', password: 'a long passphrase here' }),
    ).rejects.toThrow(/single sign-on only/);
    expect(calls).toHaveLength(0);
  });

  it('accepts for a signed-in person only at their own address, and raises them to admin', async () => {
    people.push({ id: 'usr_g', email: 'grace@example.com', name: 'G', role: 'member' });
    const me = {
      kind: 'user' as const,
      id: 'usr_g',
      name: 'G',
      email: 'grace@example.com',
      role: 'member' as const,
    };
    const other = { ...me, id: 'usr_m', email: 'mallory@example.com' };
    await expect(acceptSignedIn(req(), other, TOKEN)).rejects.toThrow(INVITE_INVALID);
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);

    answers['/deployment/invites/accept'] = () => ({
      status: 200,
      body: { role: 'admin', grants: [] },
    });
    await acceptSignedIn(req(), me, TOKEN);
    expect(calls.find((c) => c.path.endsWith('/accept'))?.body.person).toEqual({
      subject: 'usr_g',
      email: 'grace@example.com',
    });
    expect(people.find((p) => p.id === 'usr_g')?.role).toBe('admin');
    expect(audit).toHaveBeenCalledWith(
      expect.any(Request),
      'team.role_changed',
      expect.objectContaining({ detail: { from: 'member', to: 'admin', via: 'invite' } }),
    );
  });

  it('joins with single sign-on only for the invited, verified address', async () => {
    const identity = { sub: 'idp|1', email: 'grace@example.com', name: 'Grace' };
    expect(
      await joinWithSso(req(), { ...identity, email: 'mallory@example.com' }, TOKEN).catch(
        (e) => e,
      ),
    ).toBeInstanceOf(InviteError);
    expect(
      await joinWithSso(req(), { ...identity, email: null }, TOKEN).catch((e) => e),
    ).toBeInstanceOf(InviteError);
    const id = await joinWithSso(req(), identity, TOKEN);
    expect(people.find((p) => p.id === id)).toMatchObject({
      externalSub: 'idp|1',
      passwordHash: null,
    });
    // Someone the identity provider already signs in here goes the usual way, then accepts.
    expect(await joinWithSso(req(), identity, TOKEN)).toBeNull();
  });
});

describe('managing invitations', () => {
  beforeEach(() => {
    calls = [];
    audit.mockReset();
    answers = {
      '/deployment/invites': (body) => ({
        status: 201,
        body: { invite: { ...preview().invite, email: body.email }, token: TOKEN },
      }),
    };
  });

  it('signs as the admin acting, and audits without the link', async () => {
    const me = {
      kind: 'user' as const,
      id: 'usr_ada',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'admin' as const,
    };
    const made = await createInvite(req(), me, {
      email: ' Grace@Example.com ',
      role: 'member',
      space: 'blog',
      spaceRole: 'editor',
    });
    expect(made.link).toBe(`https://acme.commerceworker.com/invite/${TOKEN}`);
    expect(calls[0]).toMatchObject({
      by: { id: 'usr_ada', role: 'admin' },
      body: {
        email: 'grace@example.com',
        role: 'member',
        grants: [{ space: 'blog', role: 'editor' }],
      },
    });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'team.invite_created', {
      actor: me,
      target: 'grace@example.com',
      detail: { role: 'member', space: 'blog', spaceRole: 'editor' },
    });
    expectTokenNowhere();
  });

  it('reads an invitation’s role by id, and knows none when it can’t be read', async () => {
    const me = { kind: 'user' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };
    answers['/deployment/invites/inv-9'] = () => ({
      status: 200,
      body: { ...preview().invite, id: 'inv-9', role: 'admin' },
    });
    expect(await inviteRole(me, 'inv-9')).toBe('admin');
    expect(calls.at(-1)).toMatchObject({
      path: '/deployment/invites/inv-9',
      by: { id: 'usr_ada' },
    });
    // Gone, refused, or the api down: no role, which callers read as "ask first".
    expect(await inviteRole(me, 'inv-404')).toBeNull();
    answers['/deployment/invites/inv-9'] = () => {
      throw new Error('binding down');
    };
    expect(await inviteRole(me, 'inv-9')).toBeNull();
  });

  it('passes the api’s refusal on', async () => {
    answers['/deployment/invites'] = () => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'You can’t grant "space:admin"' } },
    });
    const me = { kind: 'user' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };
    await expect(
      createInvite(req(), me, { email: 'g@example.com', role: 'admin' }),
    ).rejects.toThrow(/can’t grant/);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('the invitation page’s inputs', async () => {
  const { forgetInviteToken, inviteTokenFrom, isInviteToken, keepInviteToken, openInvites } =
    await import('~/lib/invites');
  const { crossOrigin } = await import('~/lib/origin');
  const { describeEvent } = await import('~/lib/audit');

  it('keeps the token in path-scoped, HttpOnly cookies, never in a URL it builds', () => {
    const set = keepInviteToken(TOKEN);
    expect(set).toEqual([
      `cw_invite=${TOKEN}; Path=/invite; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      `cw_invite=${TOKEN}; Path=/login/sso/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    ]);
    for (const c of forgetInviteToken()) expect(c).toMatch(/^cw_invite=; Path=\S+; .*Max-Age=0$/);
    const carrying = (cookie: string) =>
      new Request('https://acme.commerceworker.com/invite', { headers: { cookie } });
    expect(inviteTokenFrom(carrying(`theme=dark; cw_invite=${TOKEN}`))).toBe(TOKEN);
    expect(inviteTokenFrom(carrying('cw_invite=cwi_short'))).toBeNull();
    expect(inviteTokenFrom(new Request('https://acme.commerceworker.com/invite'))).toBeNull();
    expect(isInviteToken(`${TOKEN}x`)).toBe(false);
  });

  it('refuses a cross-site accept, as every form here (the Worker checks before the route)', () => {
    const from = (origin: string) =>
      new Request(`https://acme.commerceworker.com/invite/${TOKEN}`, {
        method: 'POST',
        headers: { origin },
      });
    expect(crossOrigin(from('https://evil.example'), 'https://acme.commerceworker.com')).toBe(true);
    expect(
      crossOrigin(from('https://acme.commerceworker.com'), 'https://acme.commerceworker.com'),
    ).toBe(false);
  });

  it('lists only what can still be resent or revoked, and audits in plain words', () => {
    const base = preview().invite as never as import('~/lib/invites').Invite;
    expect(
      openInvites([
        base,
        { ...base, status: 'expired' },
        { ...base, status: 'accepted' },
        { ...base, status: 'revoked' },
      ]).map((i) => i.status),
    ).toEqual(['pending', 'expired']);
    expect(
      describeEvent({
        action: 'team.invite_created',
        actor: 'ada@example.com',
        target: 'grace@example.com',
        detail: { role: 'member', space: 'blog' },
      }),
    ).toBe('Invited a person: grace@example.com, Member, space blog');
  });
});

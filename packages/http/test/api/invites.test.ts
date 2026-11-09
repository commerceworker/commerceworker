import { loadConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

const KEY = 'test-principal-key-0123456789abcdef';
const ORIGIN = 'https://admin.example.com';
const config = loadConfig({
  ROLE: 'all',
  ADMIN_TOKEN: 'admin',
  CMA_KEY: 'cma',
  CDA_KEY: 'cda',
  CPA_KEY: 'cpa',
  SEED_SPACE_ID: 's1',
  PRINCIPAL_KEY: KEY,
} as NodeJS.ProcessEnv);

const json = { 'Content-Type': 'application/json' };
const admin = { Authorization: 'Bearer admin', ...json };
/** The seeded CMA key: space:admin, but only in s1. */
const spaceKey = { Authorization: 'Bearer cma', ...json };

interface Issued {
  invite: { id: string; status: string; email: string };
  token: string;
  url?: string;
}

describe('invitations over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(
      ctx,
      config,
      rag,
      blob,
      ai,
      inMemoryEdge(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        inviteOrigin: ORIGIN,
      },
    );
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = admin) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const create = async (body: unknown = {}) => {
    const res = await post('/deployment/invites', {
      email: 'grace@example.com',
      grants: [{ space: 's1', role: 'editor' }],
      ...(body as object),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Issued;
  };

  it('creates, lists (without the token), resends and revokes', async () => {
    const issued = await create();
    expect(issued.url).toBe(`${ORIGIN}/invite/${issued.token}`);
    const list = await app.request('/deployment/invites?status=pending', { headers: admin });
    const text = await list.text();
    expect(list.status).toBe(200);
    expect(text).toContain(issued.invite.id);
    expect(text).not.toContain(issued.token);
    expect(text).not.toMatch(/tokenHash/);

    const again = await post(`/deployment/invites/${issued.invite.id}/resend`, {});
    expect(again.status).toBe(200);
    const resent = (await again.json()) as Issued;
    expect(resent.token).not.toBe(issued.token);
    // The old link stopped working.
    expect((await post('/deployment/invites/lookup', { token: issued.token })).status).toBe(400);

    const revoked = await post(`/deployment/invites/${issued.invite.id}/revoke`, {});
    expect(((await revoked.json()) as { status: string }).status).toBe('revoked');
    expect((await post('/deployment/invites/lookup', { token: resent.token })).status).toBe(400);
  });

  it('refuses a space’s own admin key and a member, and lets a deployment admin in', async () => {
    expect((await post('/deployment/invites', { email: 'x@example.com' }, spaceKey)).status).toBe(
      403,
    );
    expect((await app.request('/deployment/invites', { headers: spaceKey })).status).toBe(403);
    const signed = async (role: 'admin' | 'member', method: string, path: string) => ({
      'x-cw-principal': await signPrincipal(
        KEY,
        { sub: `usr_${role}`, email: `${role}@example.com`, name: role, role },
        principalTarget(method, path),
      ),
      ...json,
    });
    expect(
      (
        await post(
          '/deployment/invites',
          { email: 'x@example.com' },
          await signed('member', 'POST', '/deployment/invites'),
        )
      ).status,
    ).toBe(403);
    const byAdmin = await post(
      '/deployment/invites',
      { email: 'y@example.com', role: 'admin' },
      await signed('admin', 'POST', '/deployment/invites'),
    );
    expect(byAdmin.status).toBe(201);
    expect(((await byAdmin.json()) as { invite: { invitedBy: unknown } }).invite.invitedBy).toEqual(
      { kind: 'user', id: 'usr_admin' },
    );
    // Nobody unauthenticated, and no unsigned person.
    expect(
      (
        await app.request('/deployment/invites/lookup', {
          method: 'POST',
          headers: json,
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });

  it('accepts once; every failure is the same 400', async () => {
    const issued = await create();
    const preview = await post('/deployment/invites/lookup', { token: issued.token });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { spaces: { role: string }[] }).spaces[0]?.role).toBe(
      'Editor',
    );
    const person = { subject: 'usr_grace', email: 'grace@example.com' };
    const first = await post('/deployment/invites/accept', { token: issued.token, person });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { grants: { outcome: string }[] }).grants).toEqual([
      expect.objectContaining({ spaceId: 's1', outcome: 'added' }),
    ]);
    const bodies = await Promise.all(
      [
        post('/deployment/invites/accept', { token: issued.token, person }),
        post('/deployment/invites/accept', { token: `cwi_${'Z'.repeat(43)}`, person }),
        post('/deployment/invites/lookup', { token: 'garbage' }),
      ].map(async (r) => {
        const res = await r;
        return { status: res.status, body: await res.text() };
      }),
    );
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]?.status).toBe(400);
    expect(bodies[0]?.body).toContain('invalid_invite');
    // The person is on s1's team now.
    const team = (await (await app.request('/spaces/s1/team', { headers: admin })).json()) as {
      people: { email: string; role: { preset?: string } | null }[];
    };
    expect(team.people.find((p) => p.email === 'grace@example.com')?.role?.preset).toBe('editor');
  });

  it('reads one by id, and refuses an admin invitation from the root token', async () => {
    const issued = await create();
    const one = await app.request(`/deployment/invites/${issued.invite.id}`, { headers: admin });
    expect(one.status).toBe(200);
    const text = await one.text();
    expect(JSON.parse(text)).toMatchObject({ id: issued.invite.id, role: 'member' });
    expect(text).not.toContain(issued.token);
    expect((await app.request('/deployment/invites/nope', { headers: admin })).status).toBe(404);
    expect(
      (await app.request(`/deployment/invites/${issued.invite.id}`, { headers: spaceKey })).status,
    ).toBe(403);
    const rooted = await post('/deployment/invites', { email: 'boss@example.com', role: 'admin' });
    expect(rooted.status).toBe(403);
  });

  it('validates the body', async () => {
    expect((await post('/deployment/invites', { email: 'nope' })).status).toBe(422);
    expect(
      (await post('/deployment/invites', { email: 'a@example.com', expiresInDays: 90 })).status,
    ).toBe(422);
    await create();
    expect((await post('/deployment/invites', { email: 'grace@example.com' })).status).toBe(409);
  });
});

import { loadConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

const config = loadConfig({
  ROLE: 'all',
  ADMIN_TOKEN: 'admin',
  CMA_KEY: 'cma',
  CDA_KEY: 'cda',
  CPA_KEY: 'cpa',
  SEED_SPACE_ID: 's1',
} as NodeJS.ProcessEnv);

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const T = '/spaces/s1';

interface TeamKey {
  id: string;
  name?: string;
  admin: boolean;
  role: { id: string; preset?: string } | null;
}

describe('team and role presets over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  });

  const team = async () =>
    (await (await app.request(`${T}/team`, { headers: admin })).json()) as {
      adminCount: number;
      keys: TeamKey[];
      people: { id: string; email: string; role: { preset?: string } | null }[];
    };

  it('lists the presets, seeded into the space as roles', async () => {
    const res = await app.request(`${T}/role-presets`, { headers: admin });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { preset: string; name: string }[] };
    expect(items.map((p) => p.name)).toEqual([
      'Viewer',
      'Approver',
      'Editor',
      'Manager',
      'Administrator',
    ]);
    const roles = (await (await app.request(`${T}/roles`, { headers: admin })).json()) as {
      items: { preset?: string }[];
    };
    expect(roles.items.filter((r) => r.preset)).toHaveLength(5);
  });

  it('changes a key’s role by preset name and protects the last admin', async () => {
    const before = await team();
    // The seeded dev CMA key is the space's only administrator.
    expect(before.adminCount).toBe(1);
    const cma = before.keys.find((k) => k.admin);
    const cda = before.keys.find((k) => k.name === 'dev-cda');
    if (!cma || !cda) throw new Error('seed keys missing');

    const demote = await app.request(`${T}/api-keys/${cma.id}/role`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: { code: string } }).error.code).toBe('last_admin');
    const revoke = await app.request(`${T}/api-keys/${cma.id}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(revoke.status).toBe(409);

    // Promote the delivery key; now the old admin can be demoted.
    const promote = await app.request(`${T}/api-keys/${cda.id}/role`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promote.status).toBe(200);
    const ok = await app.request(`${T}/api-keys/${cma.id}/role`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(ok.status).toBe(200);
    const after = await team();
    expect(after.keys.find((k) => k.id === cma.id)?.role?.preset).toBe('viewer');
    expect(after.adminCount).toBe(1);
  });

  it('adds people, changes their role, and refuses a duplicate email', async () => {
    const add = await app.request(`${T}/members`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email: 'Ada@Example.com', role: 'approver' }),
    });
    expect(add.status).toBe(201);
    const person = (await add.json()) as { id: string; email: string };
    expect(person.email).toBe('ada@example.com');
    const dup = await app.request(`${T}/members`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email: 'ada@example.com', role: 'viewer' }),
    });
    expect(dup.status).toBe(409);
    const change = await app.request(`${T}/members/${person.id}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(change.status).toBe(200);
    expect((await team()).people[0]?.role?.preset).toBe('editor');
    const removed = await app.request(`${T}/members/${person.id}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(removed.status).toBe(204);
  });

  it('refuses SSO-only without SSO configured', async () => {
    const res = await app.request(`${T}/access-settings`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ ssoOnly: true }),
    });
    expect(res.status).toBe(422);
  });

  it('needs space:admin', async () => {
    const res = await app.request(`${T}/team`, { headers: { Authorization: 'Bearer cda' } });
    expect(res.status).toBe(403);
  });

  it('refuses to delete a preset role', async () => {
    const { items } = (await (
      await app.request(`${T}/role-presets`, { headers: admin })
    ).json()) as {
      items: { roleId: string }[];
    };
    const res = await app.request(`${T}/roles/${items[0]?.roleId}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(res.status).toBe(422);
    const clone = await app.request(`${T}/roles/${items[0]?.roleId}/clone`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: 'Reader' }),
    });
    expect(clone.status).toBe(201);
  });
});

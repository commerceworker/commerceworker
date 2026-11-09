import { addMember, findMemberForSignIn } from '@commerceworker/application';
import { loadConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

/**
 * Creating a space over HTTP, with and without the sample starter: who may (the admin token, a
 * person signed in as a deployment admin) and who may not (a member, even an admin of one space;
 * any space's own API key), and that the starter lands in the new space only.
 */
const KEY = 'test-principal-key-0123456789abcdef';
const config = loadConfig({
  ROLE: 'all',
  ADMIN_TOKEN: 'admin',
  CMA_KEY: 'cma',
  CDA_KEY: 'cda',
  CPA_KEY: 'cpa',
  SEED_SPACE_ID: 's1',
  PRINCIPAL_KEY: KEY,
} as NodeJS.ProcessEnv);

const person = (role: 'admin' | 'member') => ({
  sub: `usr_${role}`,
  email: `${role}@example.com`,
  name: role,
  role,
});
const json = { 'content-type': 'application/json' };
const signed = async (role: 'admin' | 'member', method: string, path: string) => ({
  'x-cw-principal': await signPrincipal(KEY, person(role), principalTarget(method, path)),
});

describe('POST /spaces', () => {
  let wired: ReturnType<typeof wire>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    wired = wire(config);
    app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  });

  const create = (headers: Record<string, string>, body: Record<string, unknown>) =>
    app.request('/spaces', {
      method: 'POST',
      headers: { ...json, ...headers },
      body: JSON.stringify(body),
    });
  const entries = async (spaceId: string) => {
    const res = await app.request(`/preview/${spaceId}/main/entries?limit=100`, {
      headers: { authorization: 'Bearer admin' },
    });
    return ((await res.json()) as { items: unknown[] }).items;
  };

  it('lets a signed-in deployment admin create a space with sample content', async () => {
    const res = await create(await signed('admin', 'POST', '/spaces'), {
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
      starter: 'sample',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      starter: string;
      installed: { contentTypes: number; entries: number; assets: number };
    };
    expect(body).toMatchObject({ id: 'acme', name: 'Acme', starter: 'sample' });
    expect(body.installed.contentTypes).toBe(8);
    expect(body.installed.entries).toBe(39);
    expect(body.installed.assets).toBeGreaterThan(0);
    const installed = (await entries('acme')) as { createdBy: string | null }[];
    expect(installed).toHaveLength(39);
    // Credited to the admin who asked for it, as the MCP tool credits its caller.
    expect(new Set(installed.map((e) => e.createdBy))).toEqual(new Set(['usr_admin']));
    // The seeded space next door is untouched.
    expect(await entries('s1')).toEqual([]);

    // The admin who created it lands in it: it is on their list.
    const list = await app.request('/spaces', { headers: await signed('admin', 'GET', '/spaces') });
    const ids = ((await list.json()) as { items: { id: string }[] }).items.map((s) => s.id);
    expect(ids).toContain('acme');
  });

  it('creates an empty space by default, as it always has', async () => {
    const res = await create(
      { authorization: 'Bearer admin' },
      {
        spaceId: 'blank',
        name: 'Blank',
        defaultLocale: 'en-US',
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'blank', name: 'Blank', starter: 'empty' });
    expect(await entries('blank')).toEqual([]);
  });

  it('finishes a repeated sample create without duplicating it', async () => {
    const body = { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US', starter: 'sample' };
    expect((await create({ authorization: 'Bearer admin' }, body)).status).toBe(201);
    expect((await create({ authorization: 'Bearer admin' }, body)).status).toBe(201);
    expect(await entries('acme')).toHaveLength(39);
  });

  it('refuses a signed-in member, even one who administers a space’s team', async () => {
    await addMember(wired.ctx, 's1', { email: 'member@example.com', role: 'admin' });
    await findMemberForSignIn(wired.ctx, 's1', 'usr_member', 'member@example.com');
    const res = await create(await signed('member', 'POST', '/spaces'), {
      spaceId: 'mine',
      name: 'Mine',
      defaultLocale: 'en-US',
      starter: 'sample',
    });
    expect(res.status).toBe(403);
    expect(await wired.ctx.store.spaces.getConfig({ spaceId: 'mine', environmentId: 'main' })).toBe(
      null,
    );
  });

  it("refuses a space's own API keys: management (space:admin in s1) and delivery", async () => {
    for (const token of ['cma', 'cda']) {
      const res = await create(
        { authorization: `Bearer ${token}` },
        { spaceId: `by-${token}`, name: 'Nope', defaultLocale: 'en-US', starter: 'sample' },
      );
      expect(res.status, token).toBe(403);
    }
  });

  it('refuses a header signed for another path', async () => {
    const res = await create(await signed('admin', 'POST', '/spaces/s1/api-keys'), {
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
    });
    expect(res.status).toBe(401);
  });

  it('refuses an id the media bucket keeps for its own data, as a validation error', async () => {
    for (const spaceId of ['versions', 'imports', 'plugins', 'dlq', 'zips', 'Versions']) {
      const res = await create(
        { authorization: 'Bearer admin' },
        { spaceId, name: 'Reserved', defaultLocale: 'en-US', starter: 'sample' },
      );
      expect(res.status, spaceId).toBe(422);
      const body = (await res.json()) as { error: { issues: { field: string }[] } };
      expect(body.error.issues[0]?.field).toBe('spaceId');
      expect(await wired.ctx.store.spaces.getConfig({ spaceId, environmentId: 'main' })).toBe(null);
    }
  });

  it('validates the space id and the starter as the docs say', async () => {
    for (const body of [
      { spaceId: '*', name: 'Star', defaultLocale: 'en-US' },
      { spaceId: 'has space', name: 'Bad', defaultLocale: 'en-US' },
      { spaceId: 'a/b', name: 'Bad', defaultLocale: 'en-US' },
      { spaceId: 'x'.repeat(65), name: 'Long', defaultLocale: 'en-US' },
      { spaceId: 'ok', name: 'Ok', defaultLocale: 'en-US', starter: 'everything' },
    ]) {
      const res = await create({ authorization: 'Bearer admin' }, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

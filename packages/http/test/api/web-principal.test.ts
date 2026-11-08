import {
  addMember,
  createRole,
  createSpace,
  findMemberForSignIn,
} from '@commerceworker/application';
import { loadConfig } from '@commerceworker/platform/config';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

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

const path = '/spaces/s1/environments/main/content-types';
const person = (role: 'admin' | 'member') => ({
  sub: role === 'admin' ? 'usr_admin' : 'usr_member',
  email: `${role}@example.com`,
  name: role,
  role,
});

describe('the web principal (x-cw-principal)', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
  });

  it('lets a deployment admin in with a header signed for this path', async () => {
    const header = await signPrincipal(KEY, person('admin'), principalTarget('GET', path));
    const res = await app.request(path, { headers: { 'x-cw-principal': header } });
    expect(res.status).toBe(200);
  });

  it('refuses a header signed with another key, or for another path', async () => {
    const forged = await signPrincipal(
      'some-other-key-0123456789abcdef!!',
      person('admin'),
      principalTarget('GET', path),
    );
    expect((await app.request(path, { headers: { 'x-cw-principal': forged } })).status).toBe(401);
    const elsewhere = await signPrincipal(
      KEY,
      person('admin'),
      principalTarget('GET', '/spaces/s1/team'),
    );
    expect((await app.request(path, { headers: { 'x-cw-principal': elsewhere } })).status).toBe(
      401,
    );
  });

  it('refuses an expired header', async () => {
    const old = await signPrincipal(
      KEY,
      person('admin'),
      principalTarget('GET', path),
      Date.now() - 5 * 60_000,
    );
    expect((await app.request(path, { headers: { 'x-cw-principal': old } })).status).toBe(401);
  });

  it('refuses a header signed for another method on the same path', async () => {
    const asDelete = await signPrincipal(KEY, person('admin'), principalTarget('DELETE', path));
    expect((await app.request(path, { headers: { 'x-cw-principal': asDelete } })).status).toBe(401);
  });

  it('refuses the reserved `*` space and spaces that do not exist, even for an admin', async () => {
    for (const target of [
      '/spaces/*/api-keys',
      '/spaces/%2A/personal-access-tokens',
      '/spaces/nope/api-keys',
    ]) {
      const header = await signPrincipal(KEY, person('admin'), principalTarget('POST', target));
      const res = await app.request(target, {
        method: 'POST',
        headers: { 'x-cw-principal': header, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'cma', name: 'x' }),
      });
      expect(res.status, target).toBe(403);
    }
  });

  it('lists a member only the spaces they are on the team of', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app2 = createApp(ctx, config, rag, blob, ai);
    const asMember = async () =>
      app2.request('/spaces', {
        headers: {
          'x-cw-principal': await signPrincipal(
            KEY,
            person('member'),
            principalTarget('GET', '/spaces'),
          ),
        },
      });
    expect(((await (await asMember()).json()) as { items: unknown[] }).items).toEqual([]);
    await addMember(ctx, 's1', { email: 'member@example.com', role: 'viewer' });
    await findMemberForSignIn(ctx, 's1', 'usr_member', 'member@example.com');
    const items = ((await (await asMember()).json()) as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toEqual(['s1']);
  });

  it('describes a person as they are in the space asked about', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app2 = createApp(ctx, config, rag, blob, ai);
    await createSpace(ctx, { spaceId: 's2', name: 'Two', defaultLocale: 'en-US' });
    // A member limited to one content type in s1, an editor in s2, and on no team in s3.
    const limited = await createRole(ctx, 's1', {
      name: 'Posts only',
      scopes: ['content:write', 'content:publish', 'preview:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }],
    } as Parameters<typeof createRole>[2]);
    await addMember(ctx, 's1', { email: 'member@example.com', role: limited.id });
    await addMember(ctx, 's2', { email: 'member@example.com', role: 'editor' });
    await findMemberForSignIn(ctx, 's1', 'usr_member', 'member@example.com');
    await findMemberForSignIn(ctx, 's2', 'usr_member', 'member@example.com');
    const me = async (space: string, who: 'admin' | 'member' = 'member') => {
      const target = `/spaces/${space}/auth/me`;
      return app2.request(target, {
        headers: {
          'x-cw-principal': await signPrincipal(KEY, person(who), principalTarget('GET', target)),
        },
      });
    };
    type Me = { spaceId: string; scopes: string[]; restricted: boolean };
    const inS1 = (await (await me('s1')).json()) as Me;
    expect(inS1).toMatchObject({ spaceId: 's1', restricted: true });
    expect(inS1.scopes).toContain('content:publish');
    // Its role in s2, not s1's: an editor holds space-wide grants but no content:manage there.
    const inS2 = (await (await me('s2')).json()) as Me;
    expect(inS2.spaceId).toBe('s2');
    expect(inS2.scopes).toContain('workflow:approve');
    expect(inS1.scopes).not.toContain('workflow:approve');
    expect((await me('s3')).status).toBe(403);
    // A deployment admin has no per-type grants in any space.
    expect(await (await me('s1', 'admin')).json()).toMatchObject({ restricted: false });
  });

  it('lets a member with the Administrator preset run bulk jobs over entries, and not a narrower one', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app2 = createApp(ctx, config, rag, blob, ai);
    const limited = await createRole(ctx, 's1', {
      name: 'Posts only',
      scopes: ['content:write', 'content:publish', 'preview:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }],
    } as Parameters<typeof createRole>[2]);
    await addMember(ctx, 's1', { email: 'admin-member@example.com', role: 'admin' });
    await addMember(ctx, 's1', { email: 'member@example.com', role: limited.id });
    const adminMember = { ...person('member'), sub: 'usr_adm', email: 'admin-member@example.com' };
    await findMemberForSignIn(ctx, 's1', 'usr_adm', 'admin-member@example.com');
    await findMemberForSignIn(ctx, 's1', 'usr_member', 'member@example.com');
    const call = async (who: typeof adminMember, method: string, target: string, body?: unknown) =>
      app2.request(target, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-cw-principal': await signPrincipal(KEY, who, principalTarget(method, target)),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const jobs = '/spaces/s1/environments/main/bulk/jobs';
    const ids = ['01-a', '01-b'];

    for (const action of ['trash', 'restore', 'purge', 'publish']) {
      const res = await call(adminMember, 'POST', jobs, { action, entryIds: ids });
      expect(res.status, action).toBe(202);
    }
    const started = (await (
      await call(adminMember, 'POST', jobs, { action: 'trash', entryIds: ids })
    ).json()) as { id: string };
    expect((await call(adminMember, 'GET', `${jobs}/${started.id}/report`)).status).toBe(200);
    expect((await call(adminMember, 'POST', `${jobs}/${started.id}/cancel`)).status).toBe(200);
    expect(await (await call(adminMember, 'GET', '/spaces/s1/auth/me')).json()).toMatchObject({
      bulkJobs: ['publish', 'unpublish', 'trash', 'restore', 'purge'],
    });

    // A full `*` grant that withholds unpublish can't trash in bulk (it would take live entries
    // down), as it can't trash one live entry; it can still restore.
    const noUnpublish = await createRole(ctx, 's1', {
      name: 'Everything but unpublish',
      scopes: ['content:write', 'content:publish', 'preview:read'],
      contentGrants: [
        {
          contentTypeApiId: '*',
          actions: ['read', 'write', 'publish'],
          deniedActions: ['unpublish'],
        },
      ],
    } as Parameters<typeof createRole>[2]);
    await addMember(ctx, 's1', { email: 'keeper@example.com', role: noUnpublish.id });
    await findMemberForSignIn(ctx, 's1', 'usr_keep', 'keeper@example.com');
    const keeper = { ...person('member'), sub: 'usr_keep', email: 'keeper@example.com' };
    expect((await call(keeper, 'POST', jobs, { action: 'trash', entryIds: ids })).status).toBe(403);
    expect((await call(keeper, 'POST', jobs, { action: 'restore', entryIds: ids })).status).toBe(
      202,
    );
    expect(await (await call(keeper, 'GET', '/spaces/s1/auth/me')).json()).toMatchObject({
      bulkJobs: ['publish', 'restore', 'purge'],
    });

    const narrower = person('member');
    expect((await call(narrower, 'POST', jobs, { action: 'trash', entryIds: ids })).status).toBe(
      403,
    );
    expect((await call(narrower, 'GET', `${jobs}/${started.id}/report`)).status).toBe(403);
    expect(await (await call(narrower, 'GET', '/spaces/s1/auth/me')).json()).toMatchObject({
      bulkJobs: [],
    });
  });

  it('refuses a key asking about a space it has no standing in', async () => {
    const res = await app.request('/spaces/other/auth/me', {
      headers: { Authorization: 'Bearer cma' },
    });
    expect(res.status).toBe(403);
  });

  it('forbids a member who is not on the space team', async () => {
    const header = await signPrincipal(KEY, person('member'), principalTarget('GET', path));
    expect((await app.request(path, { headers: { 'x-cw-principal': header } })).status).toBe(403);
  });

  it('refuses a header signed with the assistant’s derived key (what the engine holds)', async () => {
    const assistantKey = await deriveAssistantPrincipalKey(KEY);
    const header = await signPrincipal(assistantKey, person('admin'), principalTarget('GET', path));
    expect((await app.request(path, { headers: { 'x-cw-principal': header } })).status).toBe(401);
  });
});

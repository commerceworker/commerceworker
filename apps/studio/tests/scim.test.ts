import { InMemoryAdminScimDirectory } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '~/lib/roles';
import {
  groupPatch,
  parseFilter,
  personFromBody,
  personPatch,
  roleFromGroups,
  ScimBadRequest,
} from '~/lib/scim';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => ({}) }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn() }));
vi.mock('~/lib/rate-limit', () => ({ overBudget: async () => null }));

const { handleScim } = await import('~/lib/scim.server');
type Store = Parameters<typeof handleScim>[2];
// biome-ignore lint/suspicious/noExplicitAny: SCIM response bodies, read loosely
type Json = Record<string, any>;

describe('SCIM parsing', () => {
  it('reads the eq filters identity providers send, and refuses the rest', () => {
    expect(parseFilter('userName eq "Ann@Example.com"')).toEqual({
      attr: 'userName',
      value: 'Ann@Example.com',
    });
    expect(parseFilter('externalId eq "00u1"')).toEqual({ attr: 'externalId', value: '00u1' });
    expect(parseFilter('displayName eq "Ops \\"West\\""')).toEqual({
      attr: 'displayName',
      value: 'Ops "West"',
    });
    expect(parseFilter(null)).toBeNull();
    expect(() => parseFilter('userName sw "a"')).toThrow(ScimBadRequest);
    expect(() => parseFilter('title eq "x"')).toThrow(ScimBadRequest);
  });

  it('reads a User, with userName as the email', () => {
    expect(
      personFromBody({
        userName: 'Ann@Example.com',
        name: { givenName: 'Ann', familyName: 'Lee' },
        externalId: 'ext-1',
      }),
    ).toEqual({ email: 'ann@example.com', name: 'Ann Lee', active: true, externalId: 'ext-1' });
    // Entra may send a userName that isn't an email, with the address in emails.
    expect(
      personFromBody({
        userName: 'ann',
        emails: [{ value: 'ann@example.com', primary: true }],
        active: 'False',
      }).active,
    ).toBe(false);
    expect(() => personFromBody({ userName: 'ann' })).toThrow(/email/);
  });

  it('reads Entra’s and Okta’s User PATCH shapes', () => {
    // Entra: capitalised ops, string booleans, a path per attribute.
    expect(
      personPatch({
        Operations: [
          { op: 'Replace', path: 'active', value: 'False' },
          { op: 'Replace', path: 'name.givenName', value: 'Ann' },
          { op: 'Replace', path: 'name.familyName', value: 'Lee' },
          { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ann@new.com' },
          { op: 'Add', path: 'title', value: 'Buyer' },
        ],
      }),
    ).toEqual({ active: false, name: 'Ann Lee', email: 'ann@new.com' });
    // Okta: a path-less replace with an object.
    expect(personPatch({ Operations: [{ op: 'replace', value: { active: true } }] })).toEqual({
      active: true,
    });
    expect(() => personPatch({ Operations: [{ op: 'move', path: 'active' }] })).toThrow();
    expect(() => personPatch({})).toThrow(/Operations/);
  });

  it('reads Group PATCH shapes: add, filtered remove, remove-by-value, replace and rename', () => {
    expect(
      groupPatch({
        Operations: [
          { op: 'Add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] },
          { op: 'Remove', path: 'members[value eq "u3"]' },
          { op: 'Remove', path: 'members', value: [{ value: 'u4' }] },
          { op: 'replace', value: { displayName: 'Buyers' } },
        ],
      }),
    ).toEqual({ add: ['u1', 'u2'], remove: ['u3', 'u4'], displayName: 'Buyers' });
    expect(
      groupPatch({ Operations: [{ op: 'replace', path: 'members', value: [{ value: 'u9' }] }] })
        .members,
    ).toEqual(['u9']);
  });

  it('gives the highest mapped role of someone’s groups, or member', () => {
    const map: Record<string, Role> = { g1: 'member', g2: 'admin' };
    expect(roleFromGroups(['g1', 'g2', 'g3'], map)).toBe('admin');
    expect(roleFromGroups(['g1'], map)).toBe('member');
    expect(roleFromGroups(['g3'], map)).toBe('member');
  });
});

/** The same fake used by the storage contract, with protocol effects recorded separately. */
function memoryStore() {
  const directory = new InMemoryAdminScimDirectory();
  const map: Record<string, Role> = {};
  const revoked: string[] = [];
  const revokedAs: string[] = [];
  const store: Store = Object.assign(directory, {
    roleMap: async () => map,
    async revokeAccess(p: { id: string; email: string }) {
      revoked.push(p.id);
      revokedAs.push(p.email);
      return { sessions: 1 };
    },
  });
  return {
    store,
    people: directory.persons,
    map,
    revoked,
    revokedAs,
    passwords: directory.passwords,
    linked: directory.linked,
  };
}

describe('the SCIM protocol', () => {
  let mem: ReturnType<typeof memoryStore>;
  const record = vi.fn(async () => {});

  beforeEach(() => {
    mem = memoryStore();
    record.mockClear();
    // The admin who set things up, outside SCIM.
    mem.people.set('usr_admin', {
      id: 'usr_admin',
      email: 'boss@example.com',
      name: 'Boss',
      role: 'admin',
      disabledAt: null,
      scimExternalId: null,
      createdAt: 0,
    });
    mem.passwords.add('usr_admin');
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleScim(
      new Request(`https://app.test/scim/v2${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      path.split('?')[0]!,
      mem.store,
      record,
      1_000,
    );
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as Json };
  };

  it('creates a person once, finds them by userName, and refuses a duplicate', async () => {
    const created = await call('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'ann@example.com',
      name: { givenName: 'Ann', familyName: 'Lee' },
      externalId: '00u1',
      active: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      userName: 'ann@example.com',
      active: true,
      externalId: '00u1',
    });
    expect(mem.people.get(created.body.id)?.role).toBe('member');

    const found = await call('GET', '/Users?filter=userName%20eq%20%22ann@example.com%22');
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].id).toBe(created.body.id);
    expect(
      (await call('GET', '/Users?filter=userName%20eq%20%22nobody@x.com%22')).body.totalResults,
    ).toBe(0);

    const again = await call('POST', '/Users', { userName: 'ANN@example.com' });
    expect(again).toMatchObject({ status: 409, body: { scimType: 'uniqueness' } });
  });

  it('deactivating ends access; reactivating lets them back; DELETE deactivates and leaves groups', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    const off = await call('PATCH', `/Users/${ann.id}`, {
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.body.active).toBe(false);
    expect(mem.revoked).toEqual([ann.id]);
    expect(record).toHaveBeenCalledWith(
      'team.user_disabled',
      expect.objectContaining({ target: 'ann@example.com' }),
    );

    const on = await call('PATCH', `/Users/${ann.id}`, {
      Operations: [{ op: 'replace', value: { active: true } }],
    });
    expect(on.body.active).toBe(true);

    const { body: g } = await call('POST', '/Groups', {
      displayName: 'Buyers',
      members: [{ value: ann.id }],
    });
    expect((await call('DELETE', `/Users/${ann.id}`)).status).toBe(204);
    expect(mem.people.get(ann.id)?.disabledAt).toBe(1_000);
    expect((await call('GET', `/Groups/${g.id}`)).body.members).toEqual([]);
  });

  it('revokes by the address tokens were made under when a rename and a deactivate come together', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    await call('PATCH', `/Users/${ann.id}`, {
      Operations: [
        { op: 'replace', path: 'userName', value: 'ann@new.example' },
        { op: 'replace', path: 'active', value: false },
      ],
    });
    expect(mem.revoked).toEqual([ann.id]);
    expect(mem.revokedAs).toEqual(['ann@example.com']);
  });

  it('never changes the email of someone who signs in with a password and has not linked SSO', async () => {
    // SSO links an unlinked person by email, so a new address would hand over their account.
    const res = await call('PATCH', '/Users/usr_admin', {
      Operations: [{ op: 'replace', path: 'userName', value: 'someone@else.example' }],
    });
    expect(res).toMatchObject({ status: 400, body: { scimType: 'mutability' } });
    expect(mem.people.get('usr_admin')?.email).toBe('boss@example.com');
    expect(record).not.toHaveBeenCalledWith('team.user_updated', expect.anything());

    // Their name may still follow the provider, and once they've linked SSO, so may their email.
    const renamed = await call('PATCH', '/Users/usr_admin', {
      Operations: [{ op: 'replace', path: 'displayName', value: 'The Boss' }],
    });
    expect(renamed.status).toBe(200);
    expect(
      (await call('PUT', '/Users/usr_admin', { userName: 'someone@else.example' })).status,
    ).toBe(400);
    mem.linked.add('usr_admin');
    const moved = await call('PATCH', '/Users/usr_admin', {
      Operations: [{ op: 'replace', path: 'userName', value: 'boss@new.example' }],
    });
    expect(moved.body.userName).toBe('boss@new.example');
  });

  it('never changes the email of someone unlinked whose role SCIM’s groups don’t give', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    const rename = (to: string) =>
      call('PATCH', `/Users/${ann.id}`, {
        Operations: [{ op: 'replace', path: 'userName', value: to }],
      });
    // A member, as provisioned: the provider may move their address.
    expect((await rename('ann@new.example')).status).toBe(200);
    // Promoted on the Team page before they ever signed in: no longer.
    mem.people.get(ann.id)!.role = 'admin';
    expect(await rename('eve@evil.example')).toMatchObject({
      status: 400,
      body: { scimType: 'mutability' },
    });
    // The same role from a mapped group is SCIM's to give, so the address may follow it.
    mem.map.g_admins = 'admin';
    await mem.store.addGroup({
      id: 'g_admins',
      displayName: 'Admins',
      externalId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await mem.store.addMembers('g_admins', [ann.id]);
    expect((await rename('ann@newer.example')).status).toBe(200);
  });

  it('never deactivates the last active admin', async () => {
    const res = await call('PATCH', '/Users/usr_admin', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(res.status).toBe(409);
    expect(mem.people.get('usr_admin')?.disabledAt).toBeNull();
  });

  it('keeps an active admin when deactivation requests race', async () => {
    mem.people.set('usr_second', {
      ...mem.people.get('usr_admin')!,
      id: 'usr_second',
      email: 'second@example.com',
    });
    const results = await Promise.all([
      call('PATCH', '/Users/usr_admin', {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
      call('PATCH', '/Users/usr_second', {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await mem.store.otherAdmins('none')).toBe(1);
    expect(mem.revoked).toHaveLength(1);
  });

  it('roles follow mapped groups: highest wins, leaving drops to member, the last admin stays', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    const { body: ops } = await call('POST', '/Groups', { displayName: 'Ops' });
    const { body: admins } = await call('POST', '/Groups', { displayName: 'Admins' });
    mem.map[ops.id] = 'member';
    mem.map[admins.id] = 'admin';

    await call('PATCH', `/Groups/${ops.id}`, {
      Operations: [
        { op: 'Add', path: 'members', value: [{ value: ann.id }, { value: 'usr_ghost' }] },
      ],
    });
    expect(mem.people.get(ann.id)?.role).toBe('member');
    expect(
      (await call('GET', `/Groups/${ops.id}`)).body.members.map((m: { value: string }) => m.value),
    ).toEqual([ann.id]);

    await call('PATCH', `/Groups/${admins.id}`, {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: ann.id }, { value: 'usr_admin' }] },
      ],
    });
    expect(mem.people.get(ann.id)?.role).toBe('admin');

    await call('PATCH', `/Groups/${admins.id}`, {
      Operations: [{ op: 'Remove', path: `members[value eq "${ann.id}"]` }],
    });
    expect(mem.people.get(ann.id)?.role).toBe('member');

    // Deleting the admins group would demote the last admin: they keep it.
    expect((await call('DELETE', `/Groups/${admins.id}`)).status).toBe(204);
    expect(mem.people.get('usr_admin')?.role).toBe('admin');

    await call('PATCH', `/Groups/${ops.id}`, {
      Operations: [{ op: 'replace', path: 'members', value: [] }],
    });
    expect(mem.people.get(ann.id)?.role).toBe('member');
  });

  it('an unmapped group changes nobody’s role', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    mem.people.get(ann.id)!.role = 'admin';
    await call('POST', '/Groups', { displayName: 'Everyone', members: [{ value: ann.id }] });
    expect(mem.people.get(ann.id)?.role).toBe('admin');
  });

  it('answers discovery, errors in SCIM shape, and 404 for the unknown', async () => {
    expect((await call('GET', '/ServiceProviderConfig')).body.patch.supported).toBe(true);
    expect((await call('GET', '/ResourceTypes')).body.totalResults).toBe(2);
    expect(await call('GET', '/Users/usr_nobody')).toMatchObject({
      status: 404,
      body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'] },
    });
    expect((await call('GET', '/Users?filter=title%20eq%20%22x%22')).body.scimType).toBe(
      'invalidFilter',
    );
    expect((await call('GET', '/Widgets')).status).toBe(404);
  });

  it('pages with 1-based startIndex and count', async () => {
    for (const n of [1, 2, 3]) await call('POST', '/Users', { userName: `p${n}@example.com` });
    const p = await call('GET', '/Users?startIndex=2&count=2');
    expect(p.body).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    expect((await call('GET', '/Users?count=0')).body).toMatchObject({
      totalResults: 4,
      itemsPerPage: 0,
    });
  });
});

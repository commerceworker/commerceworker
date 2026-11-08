/**
 * The behaviour every `ScimDirectory` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). `make` seeds a fresh store holding only the fixture's people and
 * groups. Ids start `sc_`.
 */
import type { ScimDirectory } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { ScimDirectoryFixture } from './scim-directory';

const person = (id: string, createdAt: number, over: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  disabledAt: null,
  scimExternalId: null,
  createdAt,
  ...over,
});

const group = (id: string, displayName: string, createdAt: number) => ({
  id,
  displayName,
  externalId: null,
  createdAt,
  updatedAt: createdAt,
});

export const SCIM_FIXTURE: ScimDirectoryFixture = {
  people: [
    person('sc_boss', 1, { role: 'admin', password: true }),
    person('sc_ann', 2, { scimExternalId: '00u1', name: 'Ann Lee', linked: true }),
    person('sc_bo', 3, { role: 'admin', disabledAt: 9 }),
  ],
  groups: [group('sc_g_ops', 'Ops', 2), group('sc_g_buy', 'Buyers', 1)],
  members: [
    { groupId: 'sc_g_ops', userId: 'sc_ann' },
    { groupId: 'sc_g_ops', userId: 'sc_boss' },
    { groupId: 'sc_g_buy', userId: 'sc_ann' },
  ],
};

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

export function describeScimDirectoryContract(
  name: string,
  make: (fixture: ScimDirectoryFixture) => Promise<ScimDirectory>,
) {
  describe(`${name}: the SCIM directory contract`, () => {
    const fresh = () => make(SCIM_FIXTURE);

    it('pages people oldest first, filtered by userName (any case), externalId, id or name', async () => {
      const s = await fresh();
      expect(await s.people(null, 0, 2)).toMatchObject({ total: 3 });
      expect(ids((await s.people(null, 1, 2)).rows)).toEqual(['sc_ann', 'sc_bo']);
      // A count alone, for a client that asks for no rows.
      expect(await s.people(null, 0, 0)).toEqual({ total: 3, rows: [] });
      const one = (attr: 'userName' | 'externalId' | 'id' | 'displayName', value: string) =>
        s.people({ attr, value }, 0, 10).then((p) => ids(p.rows));
      expect(await one('userName', 'SC_ANN@example.com')).toEqual(['sc_ann']);
      expect(await one('externalId', '00u1')).toEqual(['sc_ann']);
      expect(await one('id', 'sc_bo')).toEqual(['sc_bo']);
      expect(await one('displayName', 'Ann Lee')).toEqual(['sc_ann']);
      expect(await one('userName', 'nobody@example.com')).toEqual([]);
      expect(await s.person('sc_ann')).toEqual(
        person('sc_ann', 2, { scimExternalId: '00u1', name: 'Ann Lee' }),
      );
      expect((await s.personByEmail('sc_bo@example.com'))?.id).toBe('sc_bo');
      expect(await s.person('sc_none')).toBeUndefined();
    });

    it('adds a person as a viewer with no password, and changes their details', async () => {
      const s = await fresh();
      await s.addPerson(person('sc_new', 4, { email: 'new@example.com', name: 'New' }));
      expect(await s.role('sc_new')).toBe('viewer');
      expect(await s.signsInWith('sc_new')).toEqual({ password: false, linked: false });
      await expect(
        s.addPerson(person('sc_dup', 5, { email: 'new@example.com' })),
      ).rejects.toThrow();
      await s.updatePerson('sc_new', { email: 'renamed@example.com', scimExternalId: 'x9' });
      await s.updatePerson('sc_new', { name: 'Renamed' });
      expect(await s.person('sc_new')).toMatchObject({
        email: 'renamed@example.com',
        name: 'Renamed',
        scimExternalId: 'x9',
      });
    });

    it('reads how someone signs in, sets roles, counts the other active admins and disables', async () => {
      const s = await fresh();
      expect(await s.signsInWith('sc_boss')).toEqual({ password: true, linked: false });
      expect(await s.signsInWith('sc_ann')).toEqual({ password: false, linked: true });
      expect(await s.role('sc_none')).toBe('viewer');
      // Bo is an admin but disabled.
      expect(await s.otherAdmins('sc_boss')).toBe(0);
      await s.setRole('sc_ann', 'admin');
      expect(await s.role('sc_ann')).toBe('admin');
      expect(await s.otherAdmins('sc_boss')).toBe(1);
      await s.setDisabled('sc_ann', 7);
      expect(await s.otherAdmins('sc_boss')).toBe(0);
      expect((await s.person('sc_ann'))?.disabledAt).toBe(7);
      await s.setDisabled('sc_ann', null);
      expect((await s.person('sc_ann'))?.disabledAt).toBeNull();
    });

    it('pages groups oldest first, filtered by name, externalId or id, and sizes them by name', async () => {
      const s = await fresh();
      expect(ids((await s.groups(null, 0, 10)).rows)).toEqual(['sc_g_buy', 'sc_g_ops']);
      expect(await s.groups({ attr: 'displayName', value: 'Ops' }, 0, 10)).toMatchObject({
        total: 1,
        rows: [{ id: 'sc_g_ops' }],
      });
      expect((await s.groups({ attr: 'id', value: 'sc_g_buy' }, 0, 10)).total).toBe(1);
      expect(await s.groups(null, 0, 0)).toEqual({ total: 2, rows: [] });
      expect(await s.groupSizes()).toEqual([
        { id: 'sc_g_buy', displayName: 'Buyers', members: 1 },
        { id: 'sc_g_ops', displayName: 'Ops', members: 2 },
      ]);
    });

    it('adds, renames and deletes a group with its memberships', async () => {
      const s = await fresh();
      await s.addGroup({ ...group('sc_g_new', 'New', 5), externalId: 'e1' });
      await s.updateGroup('sc_g_new', { displayName: 'Newer', updatedAt: 6 });
      expect(await s.group('sc_g_new')).toEqual({
        id: 'sc_g_new',
        displayName: 'Newer',
        externalId: 'e1',
        createdAt: 5,
        updatedAt: 6,
      });
      expect((await s.groups({ attr: 'externalId', value: 'e1' }, 0, 10)).total).toBe(1);
      await s.deleteGroup('sc_g_ops');
      expect(await s.group('sc_g_ops')).toBeUndefined();
      expect(await s.members('sc_g_ops')).toEqual([]);
      expect(await s.groupsOf('sc_ann')).toEqual(['sc_g_buy']);
    });

    it('adds members once, removes them, and takes a person out of every group', async () => {
      const s = await fresh();
      await s.addMembers('sc_g_buy', ['sc_boss', 'sc_ann', 'sc_boss']);
      expect((await s.members('sc_g_buy')).sort()).toEqual(['sc_ann', 'sc_boss']);
      await s.removeMembers('sc_g_buy', ['sc_ann', 'sc_nobody']);
      expect(await s.members('sc_g_buy')).toEqual(['sc_boss']);
      expect((await s.groupsOf('sc_boss')).sort()).toEqual(['sc_g_buy', 'sc_g_ops']);
      await s.leaveGroups('sc_boss');
      expect(await s.groupsOf('sc_boss')).toEqual([]);
      expect(await s.members('sc_g_ops')).toEqual(['sc_ann']);
    });

    it('says which of many ids are people, in the order given', async () => {
      const s = await fresh();
      const many = Array.from({ length: 150 }, (_, i) => `sc_none_${i}`);
      expect(await s.existing(['sc_bo', ...many, 'sc_ann', 'sc_bo'])).toEqual([
        'sc_bo',
        'sc_ann',
        'sc_bo',
      ]);
      expect(await s.existing([])).toEqual([]);
    });
  });
}

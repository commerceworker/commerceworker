import type { AdminScimDirectory } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import type { AdminScimDirectoryFixture } from './admin-scim-directory';

export const ADMIN_SCIM_FIXTURE: AdminScimDirectoryFixture = {
  people: [
    {
      id: 'sd_ada',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
      disabledAt: null,
      scimExternalId: 'ada-ext',
      createdAt: 1,
      password: true,
    },
    {
      id: 'sd_bob',
      email: 'bob@example.com',
      name: 'Bob',
      role: 'admin',
      disabledAt: null,
      scimExternalId: null,
      createdAt: 2,
      linked: true,
    },
    {
      id: 'sd_off',
      email: 'off@example.com',
      name: 'Off',
      role: 'admin',
      disabledAt: 5,
      scimExternalId: null,
      createdAt: 3,
    },
  ],
};
const person = (id: string, at = 10) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  disabledAt: null,
  scimExternalId: null,
  createdAt: at,
});
const group = (id: string) => ({
  id,
  displayName: id,
  externalId: null,
  createdAt: 1,
  updatedAt: 1,
});

export function describeAdminScimDirectoryContract(
  name: string,
  make: (fixture: AdminScimDirectoryFixture) => Promise<AdminScimDirectory>,
) {
  describe(`${name}: Studio SCIM storage`, () => {
    it('pages and filters people, including count-only reads, without returning credentials', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      expect(await s.people(null, 1, 1)).toEqual({
        total: 3,
        rows: [expect.objectContaining({ id: 'sd_bob' })],
      });
      expect(await s.people(null, 0, 0)).toEqual({ total: 3, rows: [] });
      expect((await s.people({ attr: 'userName', value: 'ADA@EXAMPLE.COM' }, 0, 10)).total).toBe(1);
      expect((await s.people({ attr: 'externalId', value: 'ada-ext' }, 0, 10)).rows[0]?.id).toBe(
        'sd_ada',
      );
      expect((await s.people({ attr: 'displayName', value: 'Ada' }, 0, 10)).rows[0]?.id).toBe(
        'sd_ada',
      );
      expect(await s.person('sd_ada')).not.toHaveProperty('passwordHash');
      expect(await s.signsInWith('sd_ada')).toEqual({ password: true, linked: false });
      expect(await s.signsInWith('sd_bob')).toEqual({ password: false, linked: true });
      expect(await s.person('missing')).toBeUndefined();
    });
    it('adds passwordless members and updates only the named person', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      await s.addPerson(person('sd_new'));
      expect(await s.role('sd_new')).toBe('member');
      expect(await s.signsInWith('sd_new')).toEqual({ password: false, linked: false });
      await s.updatePerson('sd_new', {
        email: 'new@example.com',
        name: 'New',
        scimExternalId: 'new-ext',
      });
      expect(await s.personByEmail('new@example.com')).toMatchObject({
        id: 'sd_new',
        name: 'New',
        scimExternalId: 'new-ext',
      });
      expect(await s.personByEmail('sd_new@example.com')).toBeUndefined();
      expect(await s.person('sd_ada')).toMatchObject({ email: 'ada@example.com' });
      await expect(s.addPerson(person('sd_new'))).rejects.toThrow();
    });
    it('guards simultaneous demotions, ignoring disabled admins', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      expect(await s.otherAdmins('sd_ada')).toBe(1);
      const results = await Promise.all([
        s.setRole('sd_ada', 'member'),
        s.setRole('sd_bob', 'member'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.otherAdmins('sd_off')).toBe(1);
    });
    it('guards deactivation racing with a demotion and supports reactivation', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      const results = await Promise.all([
        s.setDisabled('sd_ada', 100),
        s.setRole('sd_bob', 'member'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.otherAdmins('sd_off')).toBe(1);
      expect(await s.setDisabled('sd_off', null)).toBe(true);
      expect(await s.otherAdmins('missing')).toBe(2);
      expect(await s.setRole('missing', 'admin')).toBe(false);
      expect(await s.setDisabled('missing', null)).toBe(false);
    });
    it('pages, filters and updates groups, including count-only reads', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      await s.addGroup(group('sg_one'));
      await s.addGroup({ ...group('sg_two'), createdAt: 2, externalId: 'ext' });
      expect(await s.groups(null, 1, 1)).toMatchObject({ total: 2, rows: [{ id: 'sg_two' }] });
      expect(await s.groups(null, 0, 0)).toEqual({ total: 2, rows: [] });
      expect((await s.groups({ attr: 'externalId', value: 'ext' }, 0, 10)).rows[0]?.id).toBe(
        'sg_two',
      );
      await s.updateGroup('sg_one', { displayName: 'New', externalId: 'updated', updatedAt: 5 });
      expect((await s.groups({ attr: 'displayName', value: 'New' }, 0, 10)).rows[0]).toMatchObject({
        id: 'sg_one',
        externalId: 'updated',
        updatedAt: 5,
      });
    });
    it('handles membership lists beyond D1’s bind limit, preserves duplicates in existence lookup and deletes groups with their members', async () => {
      const s = await make(ADMIN_SCIM_FIXTURE);
      const ids = Array.from({ length: 215 }, (_, i) => `sd_many_${i}`);
      for (const id of ids) await s.addPerson(person(id));
      await s.addGroup(group('sg_many'));
      await s.addGroup(group('sg_keep'));
      expect(await s.existing([...ids, 'missing', ids[0]!])).toEqual([...ids, ids[0]!]);
      await s.addMembers('sg_many', [...ids, ids[0]!]);
      await s.addMembers('sg_keep', [ids[0]!]);
      expect(await s.members('sg_many')).toHaveLength(215);
      expect((await s.groupSizes()).find((g) => g.id === 'sg_many')?.members).toBe(215);
      await s.removeMembers('sg_many', ids.slice(0, 120));
      expect(await s.members('sg_many')).toHaveLength(95);
      await s.leaveGroups(ids[0]!);
      expect(await s.groupsOf(ids[0]!)).toEqual([]);
      await s.deleteGroup('sg_many');
      expect(await s.group('sg_many')).toBeUndefined();
      expect(await s.members('sg_many')).toEqual([]);
      expect(await s.group('sg_keep')).toBeDefined();
      expect(await s.existing([])).toEqual([]);
      await s.addMembers('sg_keep', []);
      await s.removeMembers('sg_keep', []);
    });
  });
}

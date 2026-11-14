import type { AdminTeam } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';

export const ADMIN_TEAM_FIXTURE = [
  { id: 'at_ada', email: 'ada@example.com', name: 'Ada', role: 'admin', createdAt: 1 },
  { id: 'at_bob', email: 'bob@example.com', name: 'Bob', role: 'admin', createdAt: 2 },
  { id: 'at_cy', email: 'cy@example.com', name: 'Cy', role: 'member', createdAt: 3 },
  {
    id: 'at_disabled',
    email: 'disabled@example.com',
    name: 'Disabled',
    role: 'admin',
    createdAt: 4,
    disabledAt: 10,
  },
];
export function describeAdminTeamContract(name: string, make: () => Promise<AdminTeam>) {
  describe(`${name}: Studio team storage`, () => {
    it('lists the team without credentials and returns only active admins by name', async () => {
      const s = await make();
      const people = await s.people();
      expect(people.map((p) => p.email)).toEqual(ADMIN_TEAM_FIXTURE.map((u) => u.email));
      expect(people[0]).toEqual({
        ...ADMIN_TEAM_FIXTURE[0],
        lastLoginAt: null,
        disabledAt: null,
        twoFactorAt: null,
        passwordChangeDue: false,
      });
      expect(await s.admins(1)).toEqual([{ name: 'Ada', email: 'ada@example.com' }]);
      expect(await s.hasOtherAdmin('at_ada')).toBe(true);
      expect(await s.setRole('at_bob', 'member')).toBe(true);
      expect(await s.hasOtherAdmin('at_ada')).toBe(false);
    });
    it('refuses simultaneous demotions that would leave no active admin', async () => {
      const s = await make();
      const results = await Promise.all([
        s.setRole('at_ada', 'member'),
        s.setRole('at_bob', 'member'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.admins(10)).toHaveLength(1);
    });
    it('refuses simultaneous disabling that would leave no active admin', async () => {
      const s = await make();
      const results = await Promise.all([
        s.setDisabled('at_ada', 100),
        s.setDisabled('at_bob', 100),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.admins(10)).toHaveLength(1);
    });
    it('guards a demotion racing with disabling another admin', async () => {
      const s = await make();
      const results = await Promise.all([
        s.setRole('at_ada', 'member'),
        s.setDisabled('at_bob', 100),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.admins(10)).toHaveLength(1);
    });
    it('promotes, disables and re-enables only the named person, and refuses missing ids', async () => {
      const s = await make();
      expect(await s.setRole('at_cy', 'admin')).toBe(true);
      expect(await s.setDisabled('at_cy', 100)).toBe(true);
      expect((await s.people()).find((p) => p.id === 'at_cy')).toMatchObject({
        role: 'admin',
        disabledAt: 100,
      });
      expect(await s.setDisabled('at_cy', null)).toBe(true);
      expect(await s.admins(10)).toHaveLength(3);
      expect(await s.setRole('missing', 'admin')).toBe(false);
      expect(await s.setDisabled('missing', null)).toBe(false);
    });
  });
}

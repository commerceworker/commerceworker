/**
 * The behaviour every `CompanyDirectory` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Ids start `cd_`; the D1 run deletes those rows before each case.
 */
import type { Company, CompanyTeam } from '@commerceworker/core';
import type { CompanyDirectory, MemberWrite } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const ALL = { all: true } as const;

const customer = (id: string, name = id, kind = 'business') => ({
  id,
  name,
  email: `${id}@example.test`,
  kind,
  tier: 'standard',
  terms: 'net_30',
});

const company = (id: string, over: Partial<Company> = {}): Company => ({
  customerId: id,
  status: 'active',
  legalName: `${id} Ltd`,
  taxId: null,
  parentCompanyId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const member = (id: string, over: Partial<MemberWrite> = {}): MemberWrite => ({
  id,
  name: id,
  email: `${id}@example.test`,
  role: 'buyer',
  teamId: null,
  status: 'active',
  orderLimit: null,
  ...over,
});

const team = (id: string, companyId: string, parent: CompanyTeam | null): CompanyTeam => ({
  id,
  companyId,
  parentId: parent?.id ?? null,
  name: id,
  path: `${parent?.path ?? '/'}${id}/`,
});

/** A customer and its active company. */
async function seed(s: CompanyDirectory, id: string, name = id, over: Partial<Company> = {}) {
  expect(await s.createCustomer(customer(id, name), company(id, over))).toBe(true);
}

export function describeCompanyDirectoryContract(
  name: string,
  make: () => Promise<CompanyDirectory>,
) {
  describe(`${name}: the company directory contract`, () => {
    it('creates a customer with its company, once by id, and none for a consumer', async () => {
      const s = await make();
      await seed(s, 'cd_a', 'Acme', { taxId: 'GB123' });
      expect(await s.createCustomer(customer('cd_a', 'Other'), company('cd_a'))).toBe(false);
      expect(await s.createCustomer(customer('cd_c', 'Carol', 'consumer'), null)).toBe(true);
      expect(await s.customer(ALL, 'cd_a')).toMatchObject({
        name: 'Acme',
        kind: 'business',
        creditLimit: 0,
        balance: 0,
      });
      expect(await s.company(ALL, 'cd_a')).toMatchObject({
        customerId: 'cd_a',
        name: 'Acme',
        status: 'active',
        legalName: 'cd_a Ltd',
        taxId: 'GB123',
        tier: 'standard',
      });
      expect(await s.company(ALL, 'cd_c')).toBeUndefined();
      expect((await s.customerByEmail(ALL, 'CD_A@example.test'))?.id).toBe('cd_a');
      expect(await s.createCompany(company('cd_c'))).toBe(true);
      expect(await s.createCompany(company('cd_c'))).toBe(false);
    });

    it('changes the account fields it is given and nothing else', async () => {
      const s = await make();
      await seed(s, 'cd_u', 'Before');
      expect(await s.updateCustomer('cd_u', { name: 'After', tier: 'gold' })).toBe(true);
      expect(await s.customer(ALL, 'cd_u')).toMatchObject({
        name: 'After',
        tier: 'gold',
        email: 'cd_u@example.test',
        terms: 'net_30',
        creditLimit: 0,
      });
      expect((await s.company(ALL, 'cd_u'))?.name).toBe('After');
      expect(await s.updateCustomer('cd_nobody', { name: 'X' })).toBe(false);
    });

    it('pages companies by name with a total, a status filter and a literal search', async () => {
      const s = await make();
      await seed(s, 'cd_p1', 'Pg Bravo');
      await seed(s, 'cd_p2', 'Pg Alpha');
      await seed(s, 'cd_p3', 'Pg Charlie', { status: 'suspended' });
      await seed(s, 'cd_p4', 'Pg 100% Delta');
      const first = await s.companies(ALL, { search: 'Pg ', limit: 3 });
      expect(first.rows.map((c) => c.name)).toEqual(['Pg 100% Delta', 'Pg Alpha', 'Pg Bravo']);
      expect(first.total).toBe(4);
      expect(first.next).toEqual({ name: 'Pg Bravo', id: 'cd_p1' });
      const second = await s.companies(ALL, { search: 'Pg ', limit: 3, after: first.next! });
      expect(second.rows.map((c) => c.name)).toEqual(['Pg Charlie']);
      expect(second.total).toBe(4);
      expect(second.next).toBeNull();
      const held = await s.companies(ALL, { search: 'Pg', status: 'suspended', limit: 10 });
      expect(held.rows.map((c) => c.customerId)).toEqual(['cd_p3']);
      expect(held.total).toBe(1);
      // A search is literal: `%` is a percent sign, not a wildcard, and `_` isn't one either.
      expect((await s.companies(ALL, { search: '100%', limit: 10 })).total).toBe(1);
      expect((await s.companies(ALL, { search: 'cd_p_', limit: 10 })).total).toBe(0);
      expect((await s.companies(ALL, { search: 'LEGAL?', limit: 10 })).total).toBe(0);
    });

    it('never reads or changes another company through a company scope', async () => {
      const s = await make();
      await seed(s, 'cd_sa', 'Scope A');
      await seed(s, 'cd_sb', 'Scope B');
      await s.upsertMembers('cd_sa', [member('cd_sa_m')], 5);
      await s.upsertMembers('cd_sb', [member('cd_sb_m')], 5);
      await s.putTeam(team('cd_sb_t', 'cd_sb', null));
      const a = { companyId: 'cd_sa' };
      expect(
        (await s.companies(a, { search: 'Scope', limit: 10 })).rows.map((c) => c.customerId),
      ).toEqual(['cd_sa']);
      expect((await s.companies(a, { search: 'Scope', limit: 10 })).total).toBe(1);
      expect(await s.company(a, 'cd_sb')).toBeUndefined();
      expect(await s.customer(a, 'cd_sb')).toBeUndefined();
      expect(await s.customerByEmail(a, 'cd_sb@example.test')).toBeUndefined();
      expect(await s.teams(a, 'cd_sb')).toEqual([]);
      expect(await s.member(a, 'cd_sb', 'cd_sb_m')).toBeUndefined();
      expect(await s.membersByEmail(a, 'cd_sb', ['cd_sb_m@example.test'])).toEqual([]);
      // Naming the other company in the filter doesn't widen the scope.
      expect(await s.members(a, { companyId: 'cd_sb', limit: 10 })).toEqual({
        rows: [],
        total: 0,
        next: null,
      });
      expect((await s.members(a, { limit: 10 })).rows.map((m) => m.id)).toEqual(['cd_sa_m']);
      expect(await s.access(a, 'cd_sb', 'cd_sb_m')).toEqual({});
      expect(await s.ancestry(a, 'cd_sb')).toEqual([]);
      expect(await s.transitionCompany(a, 'cd_sb', 'active', 'suspended', 9)).toBe(false);
      expect(await s.transitionMember(a, 'cd_sb', 'cd_sb_m', 'active', 'inactive', 9)).toBe(false);
      expect((await s.company(ALL, 'cd_sb'))?.status).toBe('active');
      expect((await s.member(ALL, 'cd_sb', 'cd_sb_m'))?.status).toBe('active');
      // Everything is every company's.
      expect((await s.members(ALL, { companyId: 'cd_sb', limit: 10 })).total).toBe(1);
    });

    it('moves a company only from the status it read, and one of two racing moves wins', async () => {
      const s = await make();
      await seed(s, 'cd_r');
      expect(await s.transitionCompany(ALL, 'cd_r', 'pending', 'rejected', 2)).toBe(false);
      expect((await s.company(ALL, 'cd_r'))?.status).toBe('active');
      const raced = await Promise.all([
        s.transitionCompany(ALL, 'cd_r', 'active', 'suspended', 3),
        s.transitionCompany(ALL, 'cd_r', 'active', 'closed', 4),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      const after = await s.company(ALL, 'cd_r');
      expect(after?.status).toBe(raced[0] ? 'suspended' : 'closed');
      expect(after?.updatedAt).toBe(raced[0] ? 3 : 4);
      expect(await s.transitionCompany(ALL, 'cd_missing', 'active', 'closed', 5)).toBe(false);
    });

    it('moves a member only from the status it read, and one of two racing moves wins', async () => {
      const s = await make();
      await seed(s, 'cd_mr');
      await s.upsertMembers('cd_mr', [member('cd_mr_1')], 2);
      const raced = await Promise.all([
        s.transitionMember(ALL, 'cd_mr', 'cd_mr_1', 'active', 'inactive', 3),
        s.transitionMember(ALL, 'cd_mr', 'cd_mr_1', 'active', 'removed', 4),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      expect((await s.member(ALL, 'cd_mr', 'cd_mr_1'))?.status).toBe(
        raced[0] ? 'inactive' : 'removed',
      );
      expect(await s.transitionMember(ALL, 'cd_mr', 'cd_mr_1', 'invited', 'active', 5)).toBe(false);
    });

    it('adds members by email, changes one already there, and adds a removed one again', async () => {
      const s = await make();
      await seed(s, 'cd_m');
      await s.upsertMembers(
        'cd_m',
        [member('cd_m_1', { status: 'invited', orderLimit: 500 }), member('cd_m_2')],
        10,
      );
      await s.upsertMembers(
        'cd_m',
        [
          member('cd_m_x', {
            email: 'CD_M_1@Example.test',
            name: 'Renamed',
            role: 'approver',
            status: 'active',
            orderLimit: null,
          }),
        ],
        20,
      );
      const one = await s.member(ALL, 'cd_m', 'cd_m_1');
      expect(one).toMatchObject({
        id: 'cd_m_1',
        name: 'Renamed',
        email: 'cd_m_1@example.test',
        role: 'approver',
        status: 'invited',
        orderLimit: null,
        createdAt: 10,
        updatedAt: 20,
      });
      expect(await s.member(ALL, 'cd_m', 'cd_m_x')).toBeUndefined();
      expect(
        (await s.membersByEmail(ALL, 'cd_m', ['cd_m_1@example.test'])).map((m) => m.id),
      ).toEqual(['cd_m_1']);
      expect((await s.members(ALL, { companyId: 'cd_m', limit: 10 })).total).toBe(2);
      // Removing keeps the row; the same email can then be a member again, as a new row.
      expect(await s.transitionMember(ALL, 'cd_m', 'cd_m_2', 'active', 'removed', 30)).toBe(true);
      await s.upsertMembers('cd_m', [member('cd_m_2b', { email: 'cd_m_2@example.test' })], 40);
      const both = await s.membersByEmail(ALL, 'cd_m', ['cd_m_2@example.test']);
      expect(both.map((m) => [m.id, m.status]).sort()).toEqual([
        ['cd_m_2', 'removed'],
        ['cd_m_2b', 'active'],
      ]);
    });

    it('writes more members than one statement can bind, and pages them with filters', async () => {
      const s = await make();
      await seed(s, 'cd_big');
      await s.putTeam(team('cd_big_t', 'cd_big', null));
      const many = Array.from({ length: 250 }, (_, i) =>
        member(`cd_big_${String(i).padStart(3, '0')}`, {
          role: i % 5 === 0 ? 'approver' : 'buyer',
          teamId: i % 2 === 0 ? 'cd_big_t' : null,
          status: i < 100 ? 'invited' : 'active',
        }),
      );
      await s.upsertMembers('cd_big', many, 7);
      const first = await s.members(ALL, { companyId: 'cd_big', limit: 100 });
      expect(first.total).toBe(250);
      expect(first.rows).toHaveLength(100);
      const seen = [...first.rows];
      let next = first.next;
      while (next) {
        const page = await s.members(ALL, { companyId: 'cd_big', limit: 100, after: next });
        expect(page.total).toBe(250);
        seen.push(...page.rows);
        next = page.next;
      }
      expect(seen.map((m) => m.id)).toEqual(many.map((m) => m.id));
      const filtered = await s.members(ALL, {
        companyId: 'cd_big',
        status: 'invited',
        role: 'approver',
        teamId: 'cd_big_t',
        limit: 100,
      });
      expect(filtered.total).toBe(10);
      expect(filtered.rows.every((m) => m.status === 'invited' && m.role === 'approver')).toBe(
        true,
      );
    });

    it('keeps teams as a tree, and moving one moves what is under it', async () => {
      const s = await make();
      await seed(s, 'cd_t');
      const root = team('cd_t_root', 'cd_t', null);
      const mid = team('cd_t_mid', 'cd_t', root);
      const leaf = team('cd_t_leaf', 'cd_t', mid);
      const other = team('cd_t_other', 'cd_t', null);
      for (const t of [leaf, other, root, mid]) await s.putTeam(t);
      expect((await s.teams(ALL, 'cd_t')).map((t) => t.id)).toEqual([
        'cd_t_other',
        'cd_t_root',
        'cd_t_mid',
        'cd_t_leaf',
      ]);
      // Rename, and move `mid` (with `leaf`) under `other`.
      await s.putTeam({ ...team('cd_t_mid', 'cd_t', other), name: 'Middle' });
      const moved = await s.teams(ALL, 'cd_t');
      expect(moved.find((t) => t.id === 'cd_t_mid')).toMatchObject({
        name: 'Middle',
        parentId: 'cd_t_other',
        path: '/cd_t_other/cd_t_mid/',
      });
      expect(moved.find((t) => t.id === 'cd_t_leaf')?.path).toBe('/cd_t_other/cd_t_mid/cd_t_leaf/');
      expect(moved.find((t) => t.id === 'cd_t_root')?.path).toBe('/cd_t_root/');
    });

    it('answers what an order is held to in one read, finding the buyer in its own company only', async () => {
      const s = await make();
      await seed(s, 'cd_x1', 'X One');
      await seed(s, 'cd_x2', 'X Two', { status: 'suspended' });
      await s.upsertMembers('cd_x1', [member('cd_x1_m')], 1);
      await s.upsertMembers('cd_x2', [member('cd_x2_m')], 1);
      const ok = await s.access(ALL, 'cd_x1', 'cd_x1_m');
      expect(ok.company?.status).toBe('active');
      expect(ok.buyer?.id).toBe('cd_x1_m');
      expect((await s.access(ALL, 'cd_x1', 'cd_x2_m')).buyer).toBeUndefined();
      expect((await s.access(ALL, 'cd_x2', 'cd_x2_m')).company?.status).toBe('suspended');
      expect(await s.access(ALL, 'cd_nobody', 'cd_x1_m')).toEqual({});
      expect(await s.access(ALL, 'cd_x1')).toMatchObject({ company: { customerId: 'cd_x1' } });
    });

    it('follows a company’s parents', async () => {
      const s = await make();
      await seed(s, 'cd_g1');
      await seed(s, 'cd_g2', 'g2', { parentCompanyId: 'cd_g1' });
      await seed(s, 'cd_g3', 'g3', { parentCompanyId: 'cd_g2' });
      expect(await s.ancestry(ALL, 'cd_g3')).toEqual(['cd_g2', 'cd_g1']);
      expect(await s.ancestry(ALL, 'cd_g1')).toEqual([]);
    });
  });
}

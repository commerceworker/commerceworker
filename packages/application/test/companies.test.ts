import { type Company, MAX_COMPANY_TEAMS, MAX_TEAM_DEPTH } from '@commerceworker/core';
import type { CompanyDirectory } from '@commerceworker/ports/commerce';
import { InMemoryCompanyDirectory } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  addMembers,
  createCustomer,
  getCompany,
  listCompanies,
  listCompanyMembers,
  putTeam,
  removeMember,
  setCompanyStatus,
  updateCustomer,
} from '../src/commerce';

const ALL = { all: true } as const;
const now = 1_000;
let n = 0;
const nextId = () => `id_${++n}`;

const customer = (id: string, kind = 'business') => ({
  id,
  name: `Name ${id}`,
  email: `${id}@example.test`,
  kind,
  tier: 'standard',
  creditLimit: 5000,
  balance: 100,
  terms: 'net_30',
  stripeCustomerId: null,
  stripePaymentMethodId: null,
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

function setup() {
  const companies = new InMemoryCompanyDirectory({
    customers: [customer('acme'), customer('globex'), customer('solo', 'consumer')],
    companies: [company('acme'), company('globex')],
  });
  return { companies };
}

describe('creating a customer', () => {
  it('gives a business customer an active company, and a consumer none', async () => {
    const p = setup();
    const r = await createCustomer(
      p,
      {
        name: 'Initech',
        email: 'ops@initech.test',
        company: { legalName: 'Initech LLC', taxId: 'US9' },
      },
      'cus_new',
      now,
    );
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      customerId: 'cus_new',
      audit: {
        action: 'customer.created',
        target: 'cus_new',
        detail: { kind: 'business', company: true },
      },
    });
    expect(await p.companies.company(ALL, 'cus_new')).toMatchObject({
      status: 'active',
      legalName: 'Initech LLC',
      taxId: 'US9',
      tier: 'standard',
    });
    expect(await p.companies.customer(ALL, 'cus_new')).toMatchObject({
      kind: 'business',
      terms: 'net_30',
      creditLimit: 0,
    });
    const c = await createCustomer(
      p,
      { name: 'Pat', email: 'pat@x.test', kind: 'consumer' },
      'cus_pat',
      now,
    );
    expect(c).toMatchObject({ ok: true });
    expect(await p.companies.company(ALL, 'cus_pat')).toBeUndefined();
  });

  it('refuses a taken email, a company on a consumer, a bad body and an unknown parent', async () => {
    const p = setup();
    expect(await createCustomer(p, { name: 'X', email: 'ACME@example.test' }, 'c1', now)).toEqual({
      ok: false,
      error: 'A customer with the email ACME@example.test already exists.',
    });
    expect(
      await createCustomer(
        p,
        { name: 'X', email: 'x@x.test', kind: 'consumer', company: {} },
        'c2',
        now,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Only a business customer') });
    expect(await createCustomer(p, { name: '', email: 'nope' }, 'c3', now)).toMatchObject({
      ok: false,
    });
    expect(
      await createCustomer(
        p,
        { name: 'X', email: 'x@x.test', company: { parentCompanyId: 'ghost' } },
        'c4',
        now,
      ),
    ).toEqual({ ok: false, error: 'No company ghost to be its parent.' });
    expect(await p.companies.customer(ALL, 'c4')).toBeUndefined();
    const child = await createCustomer(
      p,
      { name: 'Child', email: 'child@x.test', company: { parentCompanyId: 'acme' } },
      'c5',
      now,
    );
    expect(child).toMatchObject({ ok: true });
    expect((await p.companies.company(ALL, 'c5'))?.parentCompanyId).toBe('acme');
  });
});

describe('editing a customer', () => {
  it('changes name, email, tier and terms, never the credit limit, and records what moved', async () => {
    const p = setup();
    const r = await updateCustomer(
      p,
      { customerId: 'acme', name: 'Acme Corp', tier: 'gold', terms: 'net_60', creditLimit: 1 },
      now,
    );
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      audit: {
        action: 'customer.updated',
        detail: { fields: ['name', 'tier', 'terms'], tier: { from: 'standard', to: 'gold' } },
      },
    });
    // A name's old and new value are personal data: the audit says only that it moved.
    expect(JSON.stringify(r)).not.toContain('Name acme');
    expect(await p.companies.customer(ALL, 'acme')).toMatchObject({
      name: 'Acme Corp',
      tier: 'gold',
      terms: 'net_60',
      creditLimit: 5000,
      balance: 100,
    });
    expect(await updateCustomer(p, { customerId: 'acme', tier: 'gold' }, now)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
  });

  it('refuses another customer’s email and an unknown customer', async () => {
    const p = setup();
    expect(
      await updateCustomer(p, { customerId: 'acme', email: 'globex@example.test' }, now),
    ).toMatchObject({
      ok: false,
    });
    expect(await updateCustomer(p, { customerId: 'ghost', tier: 'gold' }, now)).toEqual({
      ok: false,
      error: 'No such customer.',
    });
  });

  it('keeps a customer’s kind and its company together', async () => {
    const p = setup();
    expect(await updateCustomer(p, { customerId: 'acme', kind: 'consumer' }, now)).toMatchObject({
      ok: false,
      error: expect.stringContaining('close or reject it first'),
    });
    await setCompanyStatus(p, ALL, { companyId: 'acme', status: 'closed' }, now);
    expect(await updateCustomer(p, { customerId: 'acme', kind: 'consumer' }, now)).toMatchObject({
      ok: true,
      changed: true,
    });
    // Back to business is refused: the closed company is final.
    expect(await updateCustomer(p, { customerId: 'acme', kind: 'business' }, now)).toMatchObject({
      ok: false,
      error: expect.stringContaining('final'),
    });
    // A consumer made a business customer gets an active company.
    expect(
      await updateCustomer(p, { customerId: 'solo', kind: 'business', name: 'Solo GmbH' }, now),
    ).toMatchObject({
      ok: true,
      audit: { detail: { company: true } },
    });
    expect(await p.companies.company(ALL, 'solo')).toMatchObject({
      status: 'active',
      legalName: 'Solo GmbH',
    });
  });
});

describe('a company’s status', () => {
  it('follows its lifecycle, and repeating a move changes nothing', async () => {
    const p = setup();
    const to = (status: Parameters<typeof setCompanyStatus>[2]['status']) =>
      setCompanyStatus(p, ALL, { companyId: 'acme', status }, now);
    expect(await to('suspended')).toMatchObject({
      ok: true,
      changed: true,
      audit: { action: 'company.status_changed', detail: { from: 'active', to: 'suspended' } },
    });
    expect(await to('suspended')).toMatchObject({ ok: true, changed: false, audit: null });
    expect(await to('pending')).toMatchObject({
      ok: false,
      error: 'A suspended company can’t become pending: it can become active or closed.',
    });
    expect(await to('active')).toMatchObject({ ok: true, changed: true });
    expect(await to('closed')).toMatchObject({ ok: true, changed: true });
    expect(await to('active')).toEqual({
      ok: false,
      error: 'Name acme is closed, which is final.',
    });
    expect(await setCompanyStatus(p, ALL, { companyId: 'ghost', status: 'active' }, now)).toEqual({
      ok: false,
      error: 'No such company.',
    });
  });

  it('says so when the company moved between the read and the write', async () => {
    const p = setup();
    // A directory that lets a rival move the company just before our write lands.
    const rival = (to: 'suspended' | 'closed'): CompanyDirectory =>
      new Proxy(p.companies, {
        get(target, prop, receiver) {
          if (prop !== 'transitionCompany') return Reflect.get(target, prop, receiver);
          return async (...args: Parameters<CompanyDirectory['transitionCompany']>) => {
            await target.transitionCompany(ALL, 'acme', 'active', to, 5);
            return target.transitionCompany(...args);
          };
        },
      });
    expect(
      await setCompanyStatus(
        { companies: rival('closed') },
        ALL,
        { companyId: 'acme', status: 'suspended' },
        now,
      ),
    ).toEqual({ ok: false, error: 'Name acme changed meanwhile (now closed): look again.' });
    // Someone else made the same move: that is what was asked for.
    const q = setup();
    expect(
      await setCompanyStatus(
        {
          companies: new Proxy(q.companies, {
            get(target, prop, receiver) {
              if (prop !== 'transitionCompany') return Reflect.get(target, prop, receiver);
              return async (...args: Parameters<CompanyDirectory['transitionCompany']>) => {
                await target.transitionCompany(ALL, 'acme', 'active', 'suspended', 5);
                return target.transitionCompany(...args);
              };
            },
          }),
        },
        ALL,
        { companyId: 'acme', status: 'suspended' },
        now,
      ),
    ).toMatchObject({ ok: true, changed: false, audit: null });
  });

  it('is bound by a company scope', async () => {
    const p = setup();
    expect(
      await setCompanyStatus(
        p,
        { companyId: 'globex' },
        { companyId: 'acme', status: 'suspended' },
        now,
      ),
    ).toEqual({ ok: false, error: 'No such company.' });
    expect((await p.companies.company(ALL, 'acme'))?.status).toBe('active');
  });
});

describe('a company’s members', () => {
  const m = (email: string, over: object = {}) => ({ email, name: email.split('@')[0]!, ...over });

  it('adds members invited by default, by lower-cased email, and a repeat changes nothing', async () => {
    const p = setup();
    const r = await addMembers(
      p,
      ALL,
      {
        companyId: 'acme',
        members: [
          m('Ann@Acme.test'),
          m('bo@acme.test', { role: 'approver', orderLimit: 500, status: 'active' }),
        ],
      },
      now,
      nextId,
    );
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      added: 2,
      edited: 0,
      audit: { action: 'company.members_saved', detail: { added: 2, edited: 0 } },
    });
    // The audit says how many, never who.
    expect(JSON.stringify(r)).not.toContain('ann@');
    const { rows } = await p.companies.members(ALL, { companyId: 'acme', limit: 10 });
    expect(rows.map((x) => [x.email, x.role, x.status, x.orderLimit])).toEqual([
      ['ann@acme.test', 'buyer', 'invited', null],
      ['bo@acme.test', 'approver', 'active', 500],
    ]);
    const again = await addMembers(
      p,
      ALL,
      { companyId: 'acme', members: [m('ann@acme.test', { name: 'Ann' })] },
      now,
      nextId,
    );
    expect(again).toMatchObject({ ok: true, changed: false, added: 0, edited: 0, audit: null });
  });

  it('changes those already there: what is left out stays, and null clears', async () => {
    const p = setup();
    await addMembers(
      p,
      ALL,
      {
        companyId: 'acme',
        members: [m('ann@acme.test', { role: 'approver', orderLimit: 900, status: 'active' })],
      },
      now,
      nextId,
    );
    const r = await addMembers(
      p,
      ALL,
      { companyId: 'acme', members: [m('ANN@acme.test', { name: 'Ann B' })] },
      now,
      nextId,
    );
    expect(r).toMatchObject({ ok: true, changed: true, added: 0, edited: 1 });
    expect(
      (await p.companies.members(ALL, { limit: 10, companyId: 'acme' })).rows[0],
    ).toMatchObject({
      name: 'Ann B',
      role: 'approver',
      orderLimit: 900,
      status: 'active',
    });
    await addMembers(
      p,
      ALL,
      {
        companyId: 'acme',
        members: [m('ann@acme.test', { orderLimit: null, status: 'inactive' })],
      },
      now,
      nextId,
    );
    expect(
      (await p.companies.members(ALL, { limit: 10, companyId: 'acme' })).rows[0],
    ).toMatchObject({
      orderLimit: null,
      status: 'inactive',
    });
  });

  it('refuses what the lifecycle, the company or the call don’t allow', async () => {
    const p = setup();
    const put = (members: object[], companyId = 'acme') =>
      addMembers(p, ALL, { companyId, members }, now, nextId);
    expect(await put([m('a@acme.test'), m('A@acme.test')])).toEqual({
      ok: false,
      error: 'a@acme.test is listed twice.',
    });
    expect(await put([m('a@acme.test', { status: 'inactive' })])).toMatchObject({
      ok: false,
      error: expect.stringContaining('then pause them'),
    });
    expect(await put([m('a@acme.test', { teamId: 'nope' })])).toMatchObject({
      ok: false,
      error: expect.stringContaining('no team'),
    });
    expect(await put([m('a@acme.test', { status: 'active' })])).toMatchObject({ ok: true });
    expect(await put([m('a@acme.test', { status: 'invited' })])).toEqual({
      ok: false,
      error: 'a@acme.test is active: they can’t become invited.',
    });
    expect(await put([])).toMatchObject({ ok: false });
    expect(await put([m('x@x.test')], 'ghost')).toEqual({ ok: false, error: 'No such company.' });
    await setCompanyStatus(p, ALL, { companyId: 'globex', status: 'closed' }, now);
    expect(await put([m('x@x.test')], 'globex')).toMatchObject({
      ok: false,
      error: expect.stringContaining('takes no members'),
    });
    // A company-scoped caller can't put members into another company.
    expect(
      await addMembers(
        p,
        { companyId: 'globex' },
        { companyId: 'acme', members: [m('z@z.test')] },
        now,
        nextId,
      ),
    ).toEqual({ ok: false, error: 'No such company.' });
  });

  it('removes a member for good, keeping the row, and adds the same email again as a new member', async () => {
    const p = setup();
    await addMembers(
      p,
      ALL,
      { companyId: 'acme', members: [m('ann@acme.test', { status: 'active' })] },
      now,
      nextId,
    );
    const id = (await p.companies.membersByEmail(ALL, 'acme', ['ann@acme.test']))[0]!.id;
    expect(await removeMember(p, ALL, { companyId: 'acme', memberId: id }, now)).toMatchObject({
      ok: true,
      changed: true,
      audit: { action: 'company.member_removed', detail: { member: id } },
    });
    expect(await removeMember(p, ALL, { companyId: 'acme', memberId: id }, now)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    expect(await removeMember(p, ALL, { companyId: 'acme', memberId: 'ghost' }, now)).toEqual({
      ok: false,
      error: 'No such member.',
    });
    expect(
      await removeMember(p, { companyId: 'globex' }, { companyId: 'acme', memberId: id }, now),
    ).toEqual({ ok: false, error: 'No such company.' });
    await addMembers(p, ALL, { companyId: 'acme', members: [m('ann@acme.test')] }, now, nextId);
    expect((await p.companies.members(ALL, { companyId: 'acme', limit: 10 })).total).toBe(2);
  });
});

describe('a company’s teams', () => {
  it('adds a tree, renames and moves a team with what is under it, and refuses loops and depth', async () => {
    const p = setup();
    const put = (body: object) => putTeam(p, ALL, { companyId: 'acme', ...body }, nextId);
    const top = await put({ name: 'Sales' });
    expect(top).toMatchObject({
      ok: true,
      changed: true,
      audit: { action: 'company.team_saved', detail: { added: true } },
    });
    const sales = (top as { team: { id: string } }).team.id;
    const east = (await put({ name: 'East', parentTeamId: sales })) as {
      team: { id: string; path: string };
    };
    expect(east.team.path).toBe(`/${sales}/${east.team.id}/`);
    const ops = (await put({ name: 'Ops' })) as { team: { id: string } };
    expect(await put({ teamId: sales, name: 'Sales', parentTeamId: east.team.id })).toEqual({
      ok: false,
      error: 'A team can’t sit under itself or one of its own teams.',
    });
    expect(await put({ name: 'sales' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already a team called Sales'),
    });
    expect(await put({ teamId: sales, name: 'Sales', parentTeamId: null })).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    expect(
      await put({ teamId: sales, name: 'Sales EMEA', parentTeamId: ops.team.id }),
    ).toMatchObject({ ok: true, changed: true });
    const teams = (await getCompany(p, ALL, 'acme'))!.teams;
    expect(teams.find((t) => t.id === east.team.id)?.path).toBe(
      `/${ops.team.id}/${sales}/${east.team.id}/`,
    );
    expect(await put({ teamId: 'ghost', name: 'x' })).toEqual({
      ok: false,
      error: 'No such team.',
    });
    expect(await put({ name: 'x', parentTeamId: 'ghost' })).toEqual({
      ok: false,
      error: 'No such parent team.',
    });
    // Depth: a chain to the limit, then one more.
    let parent: string | null = ops.team.id;
    let depth = 1;
    while (depth < MAX_TEAM_DEPTH) {
      const t = (await put({ name: `L${depth}`, parentTeamId: parent })) as {
        team: { id: string };
      };
      parent = t.team.id;
      depth++;
    }
    expect(await put({ name: 'too deep', parentTeamId: parent })).toEqual({
      ok: false,
      error: `Teams nest at most ${MAX_TEAM_DEPTH} deep.`,
    });
  });

  it('caps a company’s teams and leaves a closed company’s alone', async () => {
    const companies = new InMemoryCompanyDirectory({
      customers: [customer('acme')],
      companies: [company('acme')],
      teams: Array.from({ length: MAX_COMPANY_TEAMS }, (_, i) => ({
        id: `t${i}`,
        companyId: 'acme',
        parentId: null,
        name: `T${i}`,
        path: `/t${i}/`,
      })),
    });
    expect(
      await putTeam({ companies }, ALL, { companyId: 'acme', name: 'One more' }, nextId),
    ).toEqual({ ok: false, error: `A company holds at most ${MAX_COMPANY_TEAMS} teams.` });
    await setCompanyStatus({ companies }, ALL, { companyId: 'acme', status: 'closed' }, now);
    expect(
      await putTeam(
        { companies },
        ALL,
        { companyId: 'acme', teamId: 't1', name: 'Renamed' },
        nextId,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('closed') });
  });
});

describe('reading companies', () => {
  it('pages with a cursor and a total, and refuses a cursor that isn’t one', async () => {
    const companies = new InMemoryCompanyDirectory({
      customers: ['a', 'b', 'c'].map((id) => customer(id)),
      companies: ['a', 'b', 'c'].map((id) =>
        company(id, id === 'b' ? { status: 'suspended' } : {}),
      ),
    });
    const p = { companies };
    const first = await listCompanies(p, ALL, { limit: 2 });
    expect(first).toMatchObject({ ok: true, total: 3 });
    if (!first.ok) throw new Error('unreachable');
    expect(first.companies.map((c) => c.id)).toEqual(['a', 'b']);
    const second = await listCompanies(p, ALL, { limit: 2, cursor: first.cursor! });
    expect(second).toMatchObject({ ok: true, total: 3, cursor: null });
    expect(second.ok && second.companies.map((c) => c.id)).toEqual(['c']);
    expect(await listCompanies(p, ALL, { cursor: 'junk' })).toEqual({
      ok: false,
      error: 'That cursor isn’t one a page returned.',
    });
    expect(await listCompanies(p, ALL, { status: 'suspended' })).toMatchObject({ total: 1 });
  });

  it('shows a company-scoped caller only its own company and members', async () => {
    const p = setup();
    await addMembers(
      p,
      ALL,
      { companyId: 'globex', members: [{ email: 'g@globex.test', name: 'G' }] },
      now,
      nextId,
    );
    const mine = { companyId: 'acme' };
    const list = await listCompanies(p, mine, {});
    expect(list.ok && list.companies.map((c) => c.id)).toEqual(['acme']);
    expect(await getCompany(p, mine, 'globex')).toBeNull();
    expect(await listCompanyMembers(p, mine, { companyId: 'globex' })).toEqual({
      ok: false,
      error: 'No such company.',
    });
    expect(await listCompanyMembers(p, ALL, { companyId: 'globex' })).toMatchObject({
      ok: true,
      total: 1,
    });
  });
});

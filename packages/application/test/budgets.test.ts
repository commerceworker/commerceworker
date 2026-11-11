import { type Budget, type Company, MAX_COMPANY_BUDGETS } from '@commerceworker/core';
import { InMemoryBudgetStore, InMemoryCompanyDirectory } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  checkBudgets,
  commitBudgetSpend,
  listBudgetSpend,
  listBudgets,
  planBudget,
  putBudget,
  reverseBudgetSpend,
  setBudgetStatus,
} from '../src/commerce';

const ALL = { all: true } as const;
const MARCH = Date.UTC(2026, 2, 15, 12);
const APRIL = Date.UTC(2026, 3, 2, 12);
let n = 0;
const nextId = () => `bud_${++n}`;

const customer = (id: string) => ({
  id,
  name: `Name ${id}`,
  email: `${id}@example.test`,
  kind: 'business',
  tier: 'standard',
  creditLimit: 0,
  balance: 0,
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
const budget = (id: string, over: Partial<Budget> = {}): Budget => ({
  id,
  companyId: 'acme',
  teamId: null,
  name: id,
  amount: 1_000,
  period: 'monthly',
  anchor: 0,
  enforcement: 'advisory',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function setup(budgets: Budget[] = []) {
  return {
    budgets: new InMemoryBudgetStore({ budgets }),
    companies: new InMemoryCompanyDirectory({
      customers: [customer('acme'), customer('globex')],
      companies: [company('acme'), company('globex')],
      teams: [
        { id: 'ops', companyId: 'acme', parentId: null, name: 'Ops', path: '/ops/' },
        { id: 'ops_eu', companyId: 'acme', parentId: 'ops', name: 'EU', path: '/ops/ops_eu/' },
        { id: 'sales', companyId: 'acme', parentId: null, name: 'Sales', path: '/sales/' },
      ],
    }),
  };
}

const order = (id: string, total = 600, over: object = {}) => ({
  id,
  customerId: 'acme',
  total,
  ...over,
});

describe('checking an order against budgets', () => {
  it('holds an order to the company’s budgets and its team’s and those above it', async () => {
    const p = setup([
      budget('whole'),
      budget('ops', { teamId: 'ops' }),
      budget('eu', { teamId: 'ops_eu' }),
      budget('sales', { teamId: 'sales' }),
      budget('paused', { status: 'paused' }),
      budget('other', { companyId: 'globex' }),
    ]);
    const r = await checkBudgets(p, order('o1'), 'budget#1', 'ops_eu', MARCH);
    expect(r.checks.map((c) => c.budgetId)).toEqual(['eu', 'ops', 'whole']);
    expect(r.within).toBe(true);
    expect((await checkBudgets(p, order('o1'), 'budget#1', null, MARCH)).checks).toHaveLength(1);
    // A team the company doesn't have contributes no team budgets rather than throwing.
    expect(
      (await checkBudgets(p, order('o1'), 'budget#1', 'ghost', MARCH)).checks.map(
        (c) => c.budgetId,
      ),
    ).toEqual(['whole']);
  });

  it('passes with no company, no budgets, or only budgets not yet started', async () => {
    const p = setup([budget('later', { anchor: MARCH + 1 })]);
    expect(await checkBudgets(p, { id: 'o', total: 5 }, 's', null, MARCH)).toMatchObject({
      within: true,
      checks: [],
    });
    expect(await checkBudgets(p, order('o'), 's', null, MARCH)).toMatchObject({
      within: true,
      checks: [],
      total: 600,
    });
    expect(
      await checkBudgets(setup(), { ...order('o'), customerId: 'globex' }, 's', null, MARCH),
    ).toMatchObject({ within: true, checks: [] });
  });

  it('prices the order in the base currency', async () => {
    const p = setup([budget('b', { enforcement: 'strict', amount: 500 })]);
    // 600 in euros at 0.9 is 666.67; a base total, when the order has one, is used as it is.
    expect((await checkBudgets(p, order('o', 600, { fxRate: 0.9 }), 's', null, MARCH)).total).toBe(
      666.67,
    );
    expect(
      (await checkBudgets(p, order('o', 600, { baseTotal: 450 }), 's', null, MARCH)).within,
    ).toBe(true);
  });

  it('counts only the window it is in, so spend from last month is not this month’s', async () => {
    const p = setup([budget('b', { enforcement: 'strict', amount: 700 })]);
    const march = await checkBudgets(p, order('o1'), 's', null, MARCH);
    await commitBudgetSpend(p, order('o1'), 's', march.uses, MARCH);
    expect((await checkBudgets(p, order('o2'), 's', null, MARCH)).within).toBe(false);
    const april = await checkBudgets(p, order('o2'), 's', null, APRIL);
    expect(april).toMatchObject({ within: true, checks: [{ spent: 0, remaining: 100 }] });
  });

  it('judges a retried step without the rows it wrote itself', async () => {
    const p = setup([budget('b', { enforcement: 'strict', amount: 600 })]);
    const first = await checkBudgets(p, order('o1'), 'budget#1', null, MARCH);
    expect(await commitBudgetSpend(p, order('o1'), 'budget#1', first.uses, MARCH)).toBe(true);
    // The budget is now full of this step's own spend: asked again, it still says within.
    const retry = await checkBudgets(p, order('o1'), 'budget#1', null, MARCH);
    expect(retry).toMatchObject({ within: true, checks: [{ spent: 0, remaining: 0 }] });
    expect(await commitBudgetSpend(p, order('o1'), 'budget#1', retry.uses, MARCH)).toBe(true);
    // A different step of the same order is counted.
    expect((await checkBudgets(p, order('o1'), 'budget#2', null, MARCH)).within).toBe(false);
  });
});

describe('recording and giving back spend', () => {
  it('records all or none, and gives back what an order recorded once', async () => {
    const p = setup([budget('adv'), budget('strict', { enforcement: 'strict', amount: 500 })]);
    const checked = await checkBudgets(p, order('o1', 450), 's', null, MARCH);
    expect(await commitBudgetSpend(p, order('o1', 450), 's', checked.uses, MARCH)).toBe(true);
    // Read while the strict budget had room, then another order took it: nothing is recorded,
    // the advisory budget included.
    const stale = await checkBudgets(p, order('o2', 50), 's', null, MARCH);
    expect(stale.within).toBe(true);
    expect(await commitBudgetSpend(p, order('o3', 50), 's', stale.uses, MARCH)).toBe(true);
    expect(await commitBudgetSpend(p, order('o2', 50), 's', stale.uses, MARCH)).toBe(false);
    const window = Date.UTC(2026, 2, 1);
    const spent = async () => [
      ...(
        await p.budgets.spentIn([
          { budgetId: 'adv', windowStart: window },
          { budgetId: 'strict', windowStart: window },
        ])
      ).values(),
    ];
    expect(await spent()).toEqual([500, 500]);

    expect(await reverseBudgetSpend(p, 'o1', MARCH)).toBe(2);
    expect(await reverseBudgetSpend(p, 'o1', MARCH)).toBe(0);
    expect(await spent()).toEqual([50, 50]);
  });
});

describe('reading budgets', () => {
  it('lists a company’s budgets by name with the spend in their current window, and pages them', async () => {
    const p = setup([
      budget('b1', { name: 'Alpha', amount: 500 }),
      budget('b2', { name: 'Beta', period: 'one_time', anchor: Date.UTC(2026, 0, 1) }),
      budget('b3', { name: 'Gamma', anchor: APRIL + 1 }),
      budget('b4', { name: 'Delta', companyId: 'globex' }),
    ]);
    const o = order('o1', 120);
    const alpha = await checkBudgets(p, o, 's', null, MARCH);
    await commitBudgetSpend(p, o, 's', alpha.uses, MARCH);
    const first = await listBudgets(p, ALL, { companyId: 'acme', limit: 2 }, MARCH);
    expect(first).toMatchObject({
      ok: true,
      total: 3,
      budgets: [
        { id: 'b1', spent: 120, remaining: 380, window: { start: Date.UTC(2026, 2, 1) } },
        {
          id: 'b2',
          spent: 120,
          remaining: 880,
          window: { start: Date.UTC(2026, 0, 1), end: null },
        },
      ],
    });
    if (!first.ok) throw new Error('unreachable');
    const rest = await listBudgets(
      p,
      ALL,
      { companyId: 'acme', limit: 2, cursor: first.cursor! },
      MARCH,
    );
    // Not yet started: no window and nothing spent.
    expect(rest).toMatchObject({
      ok: true,
      cursor: null,
      budgets: [{ id: 'b3', window: null, spent: 0 }],
    });
    expect(await listBudgets(p, ALL, { companyId: 'acme', cursor: 'junk' }, MARCH)).toEqual({
      ok: false,
      error: 'That cursor isn’t one a page returned.',
    });
    // A scope bound to another company reads none of it.
    expect(
      await listBudgets(p, { companyId: 'globex' }, { companyId: 'acme' }, MARCH),
    ).toMatchObject({ ok: true, total: 0, budgets: [] });
  });

  it('lists a budget’s ledger with whether each commit was reversed', async () => {
    const p = setup([budget('b1')]);
    for (const [i, id] of ['o1', 'o2'].entries()) {
      const r = await checkBudgets(p, order(id), 's', null, MARCH + i);
      await commitBudgetSpend(p, order(id), 's', r.uses, MARCH + i);
    }
    await reverseBudgetSpend(p, 'o1', MARCH + 5);
    const r = await listBudgetSpend(p, ALL, { budgetId: 'b1' });
    expect(r).toMatchObject({
      ok: true,
      total: 2,
      cursor: null,
      entries: [
        { orderId: 'o2', status: 'committed' },
        { orderId: 'o1', status: 'reversed' },
      ],
    });
    expect(await listBudgetSpend(p, { companyId: 'globex' }, { budgetId: 'b1' })).toMatchObject({
      total: 0,
      entries: [],
    });
  });
});

describe('adding and changing a budget', () => {
  const input = { companyId: 'acme', name: 'Office', amount: 500, period: 'monthly' as const };

  it('adds an advisory budget starting today, and a strict one on a team from a day', async () => {
    const p = setup();
    const r = await putBudget(p, ALL, input, nextId, MARCH);
    if (!r.ok) throw new Error(r.error);
    expect(r.budget).toMatchObject({
      companyId: 'acme',
      teamId: null,
      amount: 500,
      period: 'monthly',
      enforcement: 'advisory',
      status: 'active',
      anchor: Date.UTC(2026, 2, 15),
    });
    expect(r.audit).toMatchObject({
      action: 'budget.saved',
      target: r.budget.id,
      detail: { company: 'acme', added: true },
    });
    const strict = await putBudget(
      p,
      ALL,
      { ...input, name: 'Ops', teamId: 'ops', enforcement: 'strict', startsOn: '2026-06-01' },
      nextId,
      MARCH,
    );
    if (!strict.ok) throw new Error(strict.error);
    expect(strict.budget).toMatchObject({
      teamId: 'ops',
      enforcement: 'strict',
      anchor: Date.UTC(2026, 5, 1),
    });
  });

  it('changes the name, amount and enforcement, and nothing the ledger counts in', async () => {
    const p = setup([budget('b1', { teamId: 'ops', anchor: Date.UTC(2026, 0, 1) })]);
    const edit = { companyId: 'acme', budgetId: 'b1', name: 'Renamed', amount: 900 };
    const r = await putBudget(p, ALL, { ...edit, enforcement: 'strict' }, nextId, MARCH);
    if (!r.ok) throw new Error(r.error);
    expect(r.audit?.detail).toMatchObject({ changed: ['name', 'amount', 'enforcement'] });
    expect(await p.budgets.budget(ALL, 'b1')).toMatchObject({
      name: 'Renamed',
      amount: 900,
      enforcement: 'strict',
      teamId: 'ops',
      period: 'monthly',
    });
    // A repeat is no change and no audit.
    expect(
      await putBudget(p, ALL, { ...edit, enforcement: 'strict' }, nextId, MARCH),
    ).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    for (const [extra, said] of [
      [{ period: 'weekly' }, 'A budget’s period can’t change: add a new budget instead.'],
      [{ teamId: 'sales' }, 'A budget’s team can’t change: add a new budget instead.'],
      [{ teamId: null }, 'A budget’s team can’t change: add a new budget instead.'],
      [{ startsOn: '2026-02-01' }, 'A budget’s start can’t change: add a new budget instead.'],
    ] as const)
      expect(await putBudget(p, ALL, { ...edit, ...extra }, nextId, MARCH)).toEqual({
        ok: false,
        error: said,
      });
    // Saying the same period or team again is fine.
    expect(
      await putBudget(
        p,
        ALL,
        { ...edit, period: 'monthly', teamId: 'ops', amount: 901 },
        nextId,
        MARCH,
      ),
    ).toMatchObject({ ok: true, changed: true });
  });

  it('refuses what the rules don’t allow, and says why', async () => {
    const p = setup([budget('mine'), budget('theirs', { companyId: 'globex' })]);
    const cases: [object, string][] = [
      [{ ...input, period: undefined }, 'period: a new budget needs a period.'],
      [{ ...input, companyId: 'ghost' }, 'No such company.'],
      [{ ...input, teamId: 'ghost' }, 'No such team in this company.'],
      [{ ...input, budgetId: 'ghost' }, 'No such budget.'],
      // Another company's budget isn't this company's to change.
      [{ ...input, budgetId: 'theirs' }, 'No such budget.'],
      [{ ...input, amount: 0 }, 'amount: Too small: expected number to be >0'],
      [{ ...input, startsOn: 'tomorrow' }, expect.stringContaining('startsOn')],
    ];
    for (const [raw, error] of cases)
      expect(await planBudget(p, ALL, raw, nextId, MARCH)).toEqual({ ok: false, error });
    expect(await p.budgets.budget(ALL, 'theirs')).toMatchObject({ name: 'theirs', amount: 1_000 });
    // A scope can't reach past its own company.
    expect(await planBudget(p, { companyId: 'globex' }, input, nextId, MARCH)).toEqual({
      ok: false,
      error: 'No such company.',
    });
  });

  it('adds none for a closed company, and caps a company’s budgets', async () => {
    const closed = setup();
    await closed.companies.transitionCompany(ALL, 'acme', 'active', 'closed', 2);
    expect(await planBudget(closed, ALL, input, nextId, MARCH)).toEqual({
      ok: false,
      error: 'Name acme is closed: its budgets are no longer changed.',
    });
    const full = setup(
      Array.from({ length: MAX_COMPANY_BUDGETS }, (_, i) => budget(`b${i}`, { name: `B${i}` })),
    );
    expect(await planBudget(full, ALL, input, nextId, MARCH)).toEqual({
      ok: false,
      error: `A company holds at most ${MAX_COMPANY_BUDGETS} budgets: archive one first.`,
    });
  });
});

describe('moving a budget along its lifecycle', () => {
  const move = (status: 'active' | 'paused' | 'archived', id = 'b1', companyId = 'acme') => ({
    companyId,
    budgetId: id,
    status,
  });

  it('pauses, resumes and archives, and an archived one stays', async () => {
    const p = setup([budget('b1')]);
    const paused = await setBudgetStatus(p, ALL, move('paused'), MARCH);
    expect(paused).toMatchObject({
      ok: true,
      changed: true,
      audit: { action: 'budget.status_changed', detail: { from: 'active', to: 'paused' } },
    });
    // A paused budget holds nothing: orders aren't held to it.
    expect((await checkBudgets(p, order('o'), 's', null, MARCH)).checks).toEqual([]);
    expect(await setBudgetStatus(p, ALL, move('paused'), MARCH)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    await setBudgetStatus(p, ALL, move('active'), MARCH);
    expect((await checkBudgets(p, order('o'), 's', null, MARCH)).checks).toHaveLength(1);
    await setBudgetStatus(p, ALL, move('archived'), MARCH);
    expect(await setBudgetStatus(p, ALL, move('active'), MARCH)).toEqual({
      ok: false,
      error: 'b1 is archived, which is final.',
    });
  });

  it('refuses another company’s budget, and says when someone moved it first', async () => {
    const p = setup([budget('b1'), budget('b2', { companyId: 'globex' })]);
    expect(await setBudgetStatus(p, ALL, move('paused', 'b2'), MARCH)).toEqual({
      ok: false,
      error: 'No such budget.',
    });
    expect(await setBudgetStatus(p, { companyId: 'globex' }, move('paused'), MARCH)).toEqual({
      ok: false,
      error: 'No such budget.',
    });
    // Another move lands between the read and the write: a store whose transition always loses.
    const racing = {
      ...p,
      budgets: Object.assign(Object.create(p.budgets), {
        transition: async () => false,
      }) as InMemoryBudgetStore,
    };
    expect(await setBudgetStatus(racing, ALL, move('paused'), MARCH)).toEqual({
      ok: false,
      error: 'b1 changed meanwhile (now active): look again.',
    });
  });
});

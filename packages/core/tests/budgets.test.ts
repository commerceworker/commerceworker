import { describe, expect, it } from 'vitest';
import {
  BUDGET_LIFECYCLE,
  type Budget,
  budgetChecks,
  budgetReversalId,
  budgetSpendId,
  budgetsFor,
  budgetTeamIds,
  budgetWindow,
  budgetWindows,
  decodeBudgetCursor,
  encodeBudgetCursor,
  MAX_BUDGETS_PER_ORDER,
  SPEND_LIFECYCLE,
} from '../src';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const window = (period: Parameters<typeof budgetWindow>[0], now: string, anchor = 0) => {
  const w = budgetWindow(period, anchor, at(now));
  return w && [iso(w.start), iso(w.end)];
};

describe('budget windows', () => {
  it('counts a month from its first to the next first, in UTC', () => {
    expect(window('monthly', '2026-03-15T10:00:00Z')).toEqual([
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
    // The last millisecond of a month is in it; the next is in the next one.
    expect(window('monthly', '2026-01-31T23:59:59.999Z')).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
    expect(window('monthly', '2026-02-01T00:00:00.000Z')).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
    // December rolls into the next year.
    expect(window('monthly', '2026-12-31T23:00:00Z')).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
  });

  it('keeps February’s length in a leap year and not in the year after', () => {
    expect(window('monthly', '2028-02-29T12:00:00Z')).toEqual([
      '2028-02-01T00:00:00.000Z',
      '2028-03-01T00:00:00.000Z',
    ]);
    expect(window('monthly', '2027-02-28T12:00:00Z')).toEqual([
      '2027-02-01T00:00:00.000Z',
      '2027-03-01T00:00:00.000Z',
    ]);
    // Leap day belongs to a yearly window of 366 days.
    const w = budgetWindow('yearly', 0, at('2028-02-29T00:00:00Z'))!;
    expect((w.end! - w.start) / 86_400_000).toBe(366);
  });

  it('counts a quarter from January, April, July or October, including at the ends', () => {
    for (const [now, start, end] of [
      ['2026-01-01T00:00:00Z', '2026-01-01', '2026-04-01'],
      ['2026-03-31T23:59:59Z', '2026-01-01', '2026-04-01'],
      ['2026-04-01T00:00:00Z', '2026-04-01', '2026-07-01'],
      ['2026-08-20T00:00:00Z', '2026-07-01', '2026-10-01'],
      ['2026-12-31T23:59:59Z', '2026-10-01', '2027-01-01'],
    ] as const)
      expect(window('quarterly', now)).toEqual([`${start}T00:00:00.000Z`, `${end}T00:00:00.000Z`]);
  });

  it('counts a week from Monday, so Sunday belongs to the week before', () => {
    // 2026-03-15 is a Sunday; 2026-03-16 a Monday.
    expect(window('weekly', '2026-03-15T23:59:59Z')).toEqual([
      '2026-03-09T00:00:00.000Z',
      '2026-03-16T00:00:00.000Z',
    ]);
    expect(window('weekly', '2026-03-16T00:00:00Z')).toEqual([
      '2026-03-16T00:00:00.000Z',
      '2026-03-23T00:00:00.000Z',
    ]);
    // A week crosses a year end.
    expect(window('weekly', '2026-12-31T12:00:00Z')).toEqual([
      '2026-12-28T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ]);
  });

  it('counts a year from January, and a one-time budget from its anchor with no end', () => {
    expect(window('yearly', '2026-07-04T00:00:00Z')).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
    const anchor = at('2026-05-05T00:00:00Z');
    expect(budgetWindow('one_time', anchor, at('2031-01-01T00:00:00Z'))).toEqual({
      start: anchor,
      end: null,
    });
  });

  it('is not in force before its anchor, whatever the period', () => {
    const anchor = at('2026-06-01T00:00:00Z');
    expect(budgetWindow('monthly', anchor, anchor - 1)).toBeNull();
    expect(budgetWindow('one_time', anchor, anchor - 1)).toBeNull();
    expect(budgetWindow('monthly', anchor, anchor)).not.toBeNull();
  });

  it('reads the clock in UTC, not the machine’s zone', () => {
    // 23:30 on the 31st in UTC-8 is already the 1st in UTC.
    expect(window('monthly', '2026-03-31T23:30:00-08:00')).toEqual([
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
  });
});

const budget = (id: string, over: Partial<Budget> = {}): Budget => ({
  id,
  companyId: 'co',
  teamId: null,
  name: id,
  amount: 100,
  period: 'monthly',
  anchor: 0,
  enforcement: 'advisory',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('which budgets an order is held to', () => {
  it('takes the company’s, the buyer’s team’s and those of the teams above, only while active', () => {
    const all = [
      budget('b', { teamId: 't2' }),
      budget('a'),
      budget('c', { teamId: 't1' }),
      budget('other-team', { teamId: 't9' }),
      budget('paused', { status: 'paused' }),
      budget('archived', { status: 'archived' }),
      budget('elsewhere', { companyId: 'other' }),
    ];
    expect(budgetsFor(all, 'co', budgetTeamIds('/t1/t2/')).map((b) => b.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(budgetsFor(all, 'co', []).map((b) => b.id)).toEqual(['a']);
  });

  it('is capped, and the team ids read off a path root first', () => {
    const many = Array.from({ length: MAX_BUDGETS_PER_ORDER + 5 }, (_, i) =>
      budget(`b${String(i).padStart(3, '0')}`),
    );
    expect(budgetsFor(many, 'co', [])).toHaveLength(MAX_BUDGETS_PER_ORDER);
    expect(budgetTeamIds('/t1/t2/')).toEqual(['t1', 't2']);
    expect(budgetTeamIds(null)).toEqual([]);
  });

  it('puts a budget in force only while active and started', () => {
    const now = at('2026-03-15T00:00:00Z');
    const rows = budgetWindows(
      [budget('on'), budget('later', { anchor: now + 1 }), budget('paused', { status: 'paused' })],
      now,
    );
    expect(rows.map((r) => r.budget.id)).toEqual(['on']);
    expect(iso(rows[0]!.window.start)).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('checking an order against budgets', () => {
  const use = (b: Budget, spent: number) => ({
    budget: b,
    window: { start: 1, end: 2 },
    spent,
  });

  it('reports each budget’s remaining after the order, exceeded and a warning for an advisory one', () => {
    const r = budgetChecks(60, [
      use(budget('roomy', { amount: 500 }), 100),
      use(budget('advisory', { amount: 100 }), 70),
      use(budget('strict', { amount: 100, enforcement: 'strict' }), 30),
    ]);
    expect(r.within).toBe(true);
    expect(r.checks.map((c) => [c.budgetId, c.remaining, c.exceeded])).toEqual([
      ['roomy', 340, false],
      ['advisory', -30, true],
      ['strict', 10, false],
    ]);
    expect(r.checks[1]?.warning).toBe(
      'Over the advisory budget by 30 (advisory, so the order passes)',
    );
    expect(r.checks[0]?.warning).toBeNull();
    expect(r.checks[2]?.warning).toBeNull();
  });

  it('refuses when any strict budget would go below zero, and allows exactly what is left', () => {
    const strict = budget('strict', { amount: 100, enforcement: 'strict' });
    expect(budgetChecks(70, [use(strict, 30)]).within).toBe(true);
    const over = budgetChecks(70.01, [use(strict, 30), use(budget('adv'), 0)]);
    expect(over.within).toBe(false);
    expect(over.checks[0]).toMatchObject({ exceeded: true, remaining: -0.01, warning: null });
  });

  it('with no budgets passes, and rounds money so cents never trip it', () => {
    expect(budgetChecks(10, [])).toEqual({ within: true, checks: [] });
    const strict = budget('s', { amount: 0.3, enforcement: 'strict' });
    expect(budgetChecks(0.2, [use(strict, 0.1)]).within).toBe(true);
  });
});

describe('budget lifecycles and ids', () => {
  it('pauses and resumes a budget freely, and archiving is final', () => {
    expect(BUDGET_LIFECYCLE.can('active', 'paused')).toBe(true);
    expect(BUDGET_LIFECYCLE.can('paused', 'active')).toBe(true);
    expect(BUDGET_LIFECYCLE.can('paused', 'archived')).toBe(true);
    expect(BUDGET_LIFECYCLE.terminal('archived')).toBe(true);
    expect(BUDGET_LIFECYCLE.can('archived', 'active')).toBe(false);
  });

  it('commits once and reverses once, and never goes back', () => {
    expect(SPEND_LIFECYCLE.can('committed', 'reversed')).toBe(true);
    expect(SPEND_LIFECYCLE.terminal('reversed')).toBe(true);
  });

  it('keys a spend by order, step and budget, and its reversal by that', () => {
    expect(budgetSpendId('ord_1', 'chk#1', 'bud_2')).toBe('bsp_ord_1_chk_1_bud_2');
    expect(budgetReversalId('bsp_x')).toBe('rev_bsp_x');
  });

  it('round-trips a cursor of a name or a time, and refuses anything else', () => {
    for (const c of [
      { key: 'Travel é', id: 'bud_1' },
      { key: 1_700_000_000_000, id: 'bsp_1' },
    ])
      expect(decodeBudgetCursor(encodeBudgetCursor(c))).toEqual(c);
    expect(decodeBudgetCursor('junk')).toBeUndefined();
    expect(decodeBudgetCursor(btoa(JSON.stringify([{}, 'x'])))).toBeUndefined();
  });
});

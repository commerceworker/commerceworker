import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryBalanceStore,
  InMemoryCompanyDirectory,
  InMemoryPricingStore,
  PRICING_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  adjustCredit,
  getCreditAccount,
  holdCredit,
  planCreditLimit,
  releaseCredit,
  setCreditLimit,
} from '../src/commerce';

const clock = new FixedClock(new Date('2026-11-01T00:00:00Z'));
const business = PRICING_FIXTURE.customers!.find((c) => c.kind === 'business')!;
const consumer = PRICING_FIXTURE.customers!.find((c) => c.kind !== 'business');
const EXPIRES = Date.parse('2026-12-01T00:00:00Z');

function ports(limit = 1_000, balance = 100, status: 'active' | 'suspended' = 'active') {
  const pricing = new InMemoryPricingStore(
    {
      ...PRICING_FIXTURE,
      customers: PRICING_FIXTURE.customers!.map((c) =>
        c.id === business.id ? { ...c, creditLimit: limit, balance } : c,
      ),
    },
    clock,
  );
  return {
    pricing,
    companies: new InMemoryCompanyDirectory({
      customers: [{ ...business, creditLimit: limit, balance }],
      companies: [
        {
          customerId: business.id,
          status,
          legalName: business.name,
          taxId: null,
          parentCompanyId: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
    balances: new InMemoryBalanceStore(
      { customers: [{ id: business.id, creditLimit: limit, balance }] },
      clock,
    ),
  };
}

const order = (id: string, total: number, extra: object = {}) => ({
  id,
  customerId: business.id,
  total,
  ...extra,
});
const opts = (over: Partial<Parameters<typeof holdCredit>[3]> = {}) => ({
  noAccount: 'over_limit' as const,
  hold: true,
  expiresAt: EXPIRES,
  ...over,
});

describe('the credit check', () => {
  it('holds an order’s total against what is left, and reports what it saw', async () => {
    const p = ports();
    expect(await holdCredit(p, order('o1', 600), 'credit#1', opts())).toMatchObject({
      ok: true,
      account: true,
      held: true,
      limit: 1_000,
      balance: 100,
      available: 900,
      total: 600,
    });
    // The first order's hold is what the second is checked against: 300 left, so 400 is over by 100.
    expect(await holdCredit(p, order('o2', 400), 'credit#1', opts())).toMatchObject({
      ok: false,
      held: false,
      available: 300,
      over: 100,
    });
    expect(await p.balances.account(business.id)).toMatchObject({ held: 600, available: 300 });
  });

  it('answers a retried step the same, holding once', async () => {
    const p = ports();
    const first = await holdCredit(p, order('o1', 600), 'credit#1', opts());
    expect(await holdCredit(p, order('o1', 600), 'credit#1', opts())).toEqual(first);
    expect((await p.balances.account(business.id))?.held).toBe(600);
  });

  it('prices the hold in the base currency', async () => {
    const p = ports();
    // 460 EUR at 0.92 per USD is 500 USD.
    expect(
      await holdCredit(p, order('o1', 460, { fxRate: 0.92 }), 'credit#1', opts()),
    ).toMatchObject({ ok: true, total: 500 });
    expect((await p.balances.account(business.id))?.held).toBe(500);
  });

  it('only compares, counting what is held, when the node takes no hold', async () => {
    const p = ports();
    await holdCredit(p, order('o1', 600), 'credit#1', opts());
    const r = await holdCredit(p, order('o2', 400), 'credit#1', opts({ hold: false }));
    expect(r).toMatchObject({ ok: false, held: false, available: 300 });
    expect((await holdCredit(p, order('o3', 300), 'credit#1', opts({ hold: false }))).ok).toBe(
      true,
    );
    expect((await p.balances.account(business.id))?.held).toBe(600);
  });

  it('passes a consumer or a guest only when the node says so, with no hold', async () => {
    const p = ports();
    expect(
      await holdCredit(p, { id: 'g', total: 5 }, 'credit#1', opts({ noAccount: 'ok' })),
    ).toEqual({
      ok: true,
      account: false,
      kind: null,
    });
    if (consumer)
      expect(
        await holdCredit(p, { id: 'c', customerId: consumer.id, total: 5 }, 'credit#1', opts()),
      ).toMatchObject({ ok: false, account: false });
  });

  it('gives the credit back when the order’s steps are undone', async () => {
    const p = ports();
    await holdCredit(p, order('o1', 600), 'credit#1', opts());
    expect(await releaseCredit(p, 'o1')).toBe(1);
    expect(await releaseCredit(p, 'o1')).toBe(0);
    expect((await holdCredit(p, order('o2', 900), 'credit#1', opts())).ok).toBe(true);
  });
});

describe('a company that is not active', () => {
  it('takes no credit, and has its limit left alone', async () => {
    const p = ports(1_000, 100, 'suspended');
    expect(await holdCredit(p, order('o1', 10), 'credit#1', opts())).toMatchObject({
      ok: false,
      held: false,
      refused: `Company ${business.id} isn't active (suspended)`,
    });
    expect((await p.balances.account(business.id))?.held).toBe(0);
    expect(await setCreditLimit(p, { customerId: business.id, limit: 5 }, 'a')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is suspended: reinstate it/),
    });
    // Reading it, and recording a payment received, still work.
    expect((await getCreditAccount(p, business.id)).ok).toBe(true);
    expect(
      await adjustCredit(p, { customerId: business.id, amount: -10, reason: 'Wire' }, 'k', 'a'),
    ).toMatchObject({ ok: true });
  });
});

describe('credit limits and adjustments', () => {
  it('sets a limit, auditing the change', async () => {
    const p = ports();
    expect(
      await setCreditLimit(p, { customerId: business.id, limit: 2_000 }, 'ann@example.com'),
    ).toMatchObject({
      ok: true,
      previous: 1_000,
      audit: {
        action: 'credit.limit_set',
        target: business.id,
        detail: { from: 1_000, to: 2_000 },
      },
    });
    expect((await p.balances.account(business.id))?.available).toBe(1_900);
    expect(await planCreditLimit(p, business.id, -1)).toMatchObject({
      problem: expect.stringMatching(/zero or more/),
    });
    expect(await setCreditLimit(p, { customerId: business.id, limit: -5 }, 'a')).toMatchObject({
      ok: false,
    });
    expect(await setCreditLimit(p, { customerId: 'cus_nobody', limit: 5 }, 'a')).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    if (consumer)
      expect(await setCreditLimit(p, { customerId: consumer.id, limit: 5 }, 'a')).toEqual({
        ok: false,
        error: 'Only a business customer has a credit account.',
      });
  });

  it('adjusts the balance once per key, and needs a reason', async () => {
    const p = ports();
    const input = { customerId: business.id, amount: -40, reason: ' Credit memo 7 ' };
    const first = await adjustCredit(p, input, 'k1', 'ann@example.com');
    expect(first).toMatchObject({
      ok: true,
      balance: 60,
      audit: {
        action: 'credit.adjusted',
        detail: { amount: -40, reason: 'Credit memo 7', balance: 60 },
      },
    });
    // A retry with the same key moves the balance once.
    await adjustCredit(p, input, 'k1', 'ann@example.com');
    expect((await p.balances.account(business.id))?.balance).toBe(60);
    expect(await adjustCredit(p, { ...input, reason: '  ' }, 'k2', 'a')).toMatchObject({
      ok: false,
    });
    expect(await adjustCredit(p, { ...input, amount: 0 }, 'k3', 'a')).toMatchObject({ ok: false });
    expect(await adjustCredit(p, { ...input, customerId: 'cus_nobody' }, 'k4', 'a')).toEqual({
      ok: false,
      error: 'No such customer.',
    });
  });
});

describe('reading a credit account', () => {
  it('shows the figures and pages the ledger with a cursor', async () => {
    const p = ports();
    for (const [i, amount] of [-10, -20, 30].entries()) {
      clock.advance(1_000);
      await adjustCredit(p, { customerId: business.id, amount, reason: `n${i}` }, `k${i}`, 'ann');
    }
    await holdCredit(p, order('o1', 200), 'credit#1', opts());
    const first = await getCreditAccount(p, business.id, { limit: 2 });
    expect(first).toMatchObject({
      ok: true,
      value: { limit: 1_000, balance: 100, held: 200, available: 700, currency: 'USD' },
    });
    if (!first.ok) throw new Error('unreachable');
    expect(first.value.entries.map((e) => [e.note, e.balanceAfter])).toEqual([
      ['n2', 100],
      ['n1', 70],
    ]);
    const next = await getCreditAccount(p, business.id, { after: first.value.next! });
    if (!next.ok) throw new Error('unreachable');
    expect(next.value.entries.map((e) => e.note)).toEqual(['n0']);
    expect(next.value.next).toBeNull();
    expect(await getCreditAccount(p, business.id, { after: 'garbage' })).toMatchObject({
      ok: false,
    });
    expect(await getCreditAccount(p, 'cus_nobody')).toEqual({
      ok: false,
      error: 'No such customer.',
    });
  });
});

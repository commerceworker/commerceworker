import { describe, expect, it } from 'vitest';
import { budgetCheck, creditCheck, owedOnAccount, providerTaxProblem } from '../src';

const business = { kind: 'business', creditLimit: 1000, balance: 400 };

describe('credit check', () => {
  it("compares the order's base total with the credit available", () => {
    expect(creditCheck(business, { total: 600 }, { noAccount: 'over_limit' })).toEqual({
      ok: true,
      account: true,
      available: 600,
      total: 600,
      over: 0,
    });
    // 920 EUR at 0.92 per USD is 1000 USD, over the 600 available.
    expect(creditCheck(business, { total: 920, fxRate: 0.92 }, { noAccount: 'ok' })).toMatchObject({
      ok: false,
      over: 400,
    });
    expect(creditCheck(business, { total: 9, baseTotal: 601 }, { noAccount: 'ok' }).ok).toBe(false);
  });

  it('passes a consumer or a guest only when the node says so', () => {
    const consumer = { kind: 'consumer', creditLimit: 0, balance: 0 };
    expect(creditCheck(consumer, { total: 1 }, { noAccount: 'ok' })).toEqual({
      ok: true,
      account: false,
    });
    expect(creditCheck(undefined, { total: 1 }, { noAccount: 'over_limit' })).toEqual({
      ok: false,
      account: false,
    });
  });
});

describe('owed on account', () => {
  const o = { onAccount: true, customerKind: 'business', paid: 0, total: 100 };
  it('owes only an unpaid invoice to a business customer that keeps an account', () => {
    expect(owedOnAccount(o)).toBe(true);
    expect(owedOnAccount({ ...o, paid: 100 })).toBe(false);
    expect(owedOnAccount({ ...o, customerKind: 'consumer' })).toBe(false);
    expect(owedOnAccount({ ...o, customerKind: undefined })).toBe(false);
    expect(owedOnAccount({ ...o, onAccount: false })).toBe(false);
  });
});

describe("a tax provider's amount", () => {
  it('refuses tax on nothing taxable and more than half of what is', () => {
    expect(providerTaxProblem(0, 0)).toBeNull();
    expect(providerTaxProblem(1, 0)).toBe('untaxable');
    expect(providerTaxProblem(50, 100)).toBeNull();
    expect(providerTaxProblem(50.01, 100)).toBe('over_cap');
  });
});

describe('budget check', () => {
  it("holds the order's base total to the budget, at the edge included", () => {
    expect(budgetCheck({ total: 25_000 }, 25_000)).toEqual({ within: true, total: 25_000 });
    expect(budgetCheck({ total: 9, baseTotal: 25_001 }, 25_000).within).toBe(false);
    // 23,000 EUR at 0.92 per USD is 25,000 USD.
    expect(budgetCheck({ total: 23_000, fxRate: 0.92 }, 25_000).within).toBe(true);
  });
});

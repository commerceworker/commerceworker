import { describe, expect, it } from 'vitest';
import {
  CREDIT_HOLD,
  creditAdjustmentProblem,
  creditAvailable,
  creditCheck,
  creditHoldAmount,
  creditLimitProblem,
} from '../src';

describe('credit available', () => {
  it('is the limit less the balance and what open orders hold', () => {
    expect(creditAvailable({ creditLimit: 1_000, balance: 400 })).toBe(600);
    expect(creditAvailable({ creditLimit: 1_000, balance: 400, held: 250.5 })).toBe(349.5);
    // Past the limit is negative, never clamped: it says by how much.
    expect(creditAvailable({ creditLimit: 100, balance: 80, held: 50 })).toBe(-30);
  });

  it('claims an order’s base total', () => {
    expect(creditHoldAmount({ total: 600 })).toBe(600);
    expect(creditHoldAmount({ total: 920, fxRate: 0.92 })).toBe(1_000);
    expect(creditHoldAmount({ total: 9, baseTotal: 601.239 })).toBe(601.24);
  });

  it('is what a check compares an order against, held included', () => {
    const business = { kind: 'business', creditLimit: 1_000, balance: 400 };
    expect(creditCheck({ ...business, held: 500 }, { total: 100 }, { noAccount: 'ok' })).toEqual({
      ok: true,
      account: true,
      available: 100,
      total: 100,
      over: 0,
    });
    expect(
      creditCheck({ ...business, held: 500 }, { total: 101 }, { noAccount: 'ok' }),
    ).toMatchObject({
      ok: false,
      over: 1,
    });
  });
});

describe('credit hold lifecycle', () => {
  it('leaves a hold only to be charged, released or expired, each final', () => {
    expect(CREDIT_HOLD.can('held', 'charged')).toBe(true);
    expect(CREDIT_HOLD.can('held', 'released')).toBe(true);
    expect(CREDIT_HOLD.can('held', 'expired')).toBe(true);
    for (const done of ['charged', 'released', 'expired'] as const) {
      expect(CREDIT_HOLD.terminal(done)).toBe(true);
      expect(CREDIT_HOLD.can(done, 'held')).toBe(false);
    }
    expect(CREDIT_HOLD.terminal('held')).toBe(false);
    expect([...CREDIT_HOLD.reachable('held')].sort()).toEqual([
      'charged',
      'expired',
      'held',
      'released',
    ]);
    expect(() => CREDIT_HOLD.assert('released', 'charged')).toThrow(
      "Can't go from released to charged",
    );
  });
});

describe('credit input problems', () => {
  it('needs a nonzero amount in range and a reason', () => {
    expect(creditAdjustmentProblem({ amount: -5, reason: 'Credit memo' })).toBeNull();
    expect(creditAdjustmentProblem({ amount: 0, reason: 'x' })).toMatch(/zero/);
    expect(creditAdjustmentProblem({ amount: Number.NaN, reason: 'x' })).toMatch(/zero/);
    expect(creditAdjustmentProblem({ amount: 5e9, reason: 'x' })).toMatch(/range/);
    expect(creditAdjustmentProblem({ amount: 5, reason: '  ' })).toMatch(/reason/);
  });
  it('takes a limit of zero or more', () => {
    expect(creditLimitProblem(0)).toBeNull();
    expect(creditLimitProblem(25_000)).toBeNull();
    expect(creditLimitProblem(-1)).not.toBeNull();
    expect(creditLimitProblem(Number.POSITIVE_INFINITY)).not.toBeNull();
  });
});

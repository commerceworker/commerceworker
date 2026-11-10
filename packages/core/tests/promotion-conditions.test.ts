import { describe, expect, it } from 'vitest';
import {
  type ConditionInput,
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_MESSAGE,
  PROMOTION_CONDITION_OPERATORS,
  PROMOTION_CONDITION_VARIABLES,
  parsePromotionCondition,
  promotionConditionContext,
  promotionConditionHolds,
  promotionConditionProblem,
  TOOL_INPUTS,
} from '../src';

const input = (over: Partial<ConditionInput> = {}): ConditionInput => ({
  now: Date.parse('2026-11-10T12:00:00Z'),
  currency: 'EUR',
  fxRate: 0.5,
  channel: 'web',
  customerId: 'cus_1',
  customer: { kind: 'business', tier: 'gold' },
  lines: [
    { sku: 'A', name: 'Anvil', qty: 3, unitPrice: 20 },
    { sku: 'B', qty: 1, unitPrice: 40 },
  ],
  meta: {
    shipTo: {
      line1: '1 Main St',
      city: 'Austin',
      postalCode: '78701',
      country: 'usa',
      region: 'Texas',
    },
  },
  ...over,
});

describe('the promotion condition context', () => {
  it('holds the documented variables, in the flows’ names', () => {
    const c = promotionConditionContext(input());
    expect(c).toEqual({
      now: Date.parse('2026-11-10T12:00:00Z'),
      order: {
        channel: 'web',
        currency: 'EUR',
        subtotal: 100,
        // 100 EUR at 0.5 EUR per USD.
        baseSubtotal: 200,
        customerId: 'cus_1',
        lines: [
          { sku: 'A', name: 'Anvil', qty: 3, unitPrice: 20 },
          { sku: 'B', name: null, qty: 1, unitPrice: 40 },
        ],
        // As the address check writes it, however the buyer typed it.
        meta: { shipTo: { country: 'US', region: 'TX' } },
      },
      customer: { id: 'cus_1', kind: 'business', tier: 'gold' },
      // No company or buyer loaded: null, as for a guest.
      company: { status: null, tier: null },
      buyer: { role: null, team: null, orderLimit: null },
    });
  });

  it('reads null for what a guest or a pickup order lacks', () => {
    const c = promotionConditionContext(
      input({ customerId: undefined, customer: undefined, meta: undefined }),
    );
    expect(c.customer).toEqual({ id: null, kind: null, tier: null });
    expect(c.order.customerId).toBeNull();
    expect(c.order.meta.shipTo).toEqual({ country: null, region: null });
  });

  it('is a copy: a condition can’t change the order’s lines', () => {
    const i = input();
    const c = promotionConditionContext(i);
    c.order.lines[0]!.qty = 99;
    expect(i.lines[0]?.qty).toBe(3);
  });

  it('documents every variable the validator accepts, and no other', () => {
    for (const path of Object.keys(PROMOTION_CONDITION_VARIABLES))
      expect(promotionConditionProblem({ '==': [{ var: path }, 1] })).toBeNull();
    expect(promotionConditionProblem({ '==': [{ var: 'order.total' }, 1] })).toMatch(
      /“order.total”, which isn’t a promotion variable/,
    );
  });
});

describe('validating a condition', () => {
  const ok = [
    { '==': [{ var: 'order.channel' }, 'pos'] },
    { in: [{ var: 'customer.tier' }, ['gold', 'silver']] },
    { '>=': [{ var: 'order.baseSubtotal' }, 100] },
    { '<': [{ var: 'now' }, { '+': [1_700_000_000_000, { days: [14] }] }] },
    { '>': [{ len: [{ var: 'order.lines' }] }, 2] },
    { '==': [{ var: ['order.meta.shipTo.region', 'none'] }, 'TX'] },
    { '==': [{ var: 'order.lines.0.sku' }, 'A'] },
    {
      some: [
        { var: 'order.lines' },
        { and: [{ '==': [{ var: 'sku' }, 'A'] }, { '>=': [{ var: 'qty' }, 3] }] },
      ],
    },
    {
      '>': [
        {
          reduce: [
            { var: 'order.lines' },
            { '+': [{ var: 'accumulator' }, { var: 'current.qty' }] },
            0,
          ],
        },
        4,
      ],
    },
  ];
  it.each(ok.map((c) => [JSON.stringify(c), c] as const))('accepts %s', (_n, c) => {
    expect(promotionConditionProblem(c)).toBeNull();
  });

  const bad: [string, unknown, RegExp][] = [
    ['not an object', 'true', /JSON Logic expression/],
    ['a bare array', [1, 2], /JSON Logic expression/],
    [
      'an unknown variable',
      { '==': [{ var: 'vars.risk' }, 1] },
      /“vars.risk”, which isn’t a promotion variable/,
    ],
    ['a node’s output', { '==': [{ var: 'nodes.risk.score' }, 1] }, /isn’t a promotion variable/],
    [
      'an unknown line field',
      { '==': [{ var: 'order.lines.0.sellerId' }, 1] },
      /isn’t a promotion variable/,
    ],
    [
      'a computed variable name',
      { var: { cat: ['order.', 'channel'] } },
      /name each variable outright/,
    ],
    [
      'the method operator',
      { method: [{ var: 'order.channel' }, 'toUpperCase', []] },
      /can’t use “method”/,
    ],
    ['the clock', { '>': [{ now: [] }, 1] }, /read the variable now/],
    ['an unknown operator', { exec: ['x'] }, /can’t use “exec”/],
    ['a missing check', { missing: ['order.channel'] }, /can’t use “missing”/],
    ['a two-key object', { '==': [1, 1], and: [] }, /exactly one operator/],
    ['an empty object', {}, /exactly one operator/],
    [
      'top-level data inside a list operation',
      { some: [{ var: 'order.lines' }, { '==': [{ var: 'order.currency' }, 'USD'] }] },
      /only the item itself is available/,
    ],
    [
      'a line field outside a list operation',
      { '==': [{ var: 'sku' }, 'A'] },
      /isn’t a promotion variable/,
    ],
    ['a bad reduce', { reduce: [{ var: 'order.lines' }, 1] }, /wrong number of parts/],
    [
      'list operations nested three deep',
      {
        some: [
          { var: 'order.lines' },
          { some: [[1, 2], { some: [[1], { '==': [{ var: '' }, 1] }] }] },
        ],
      },
      /nests list operations too deeply/,
    ],
  ];
  it.each(bad)('refuses %s', (_n, c, why) => {
    expect(promotionConditionProblem(c)).toMatch(why);
  });

  it('refuses one that is too long, too large or too deep', () => {
    expect(
      promotionConditionProblem({
        in: [{ var: 'order.channel' }, ['x'.repeat(MAX_CONDITION_LENGTH)]],
      }),
    ).toMatch(/at most 4000 characters/);
    expect(
      promotionConditionProblem({ or: Array.from({ length: 250 }, () => ({ '==': [1, 1] })) }),
    ).toMatch(/is too large/);
    let deep: unknown = { '==': [1, 1] };
    for (let i = 0; i < 14; i++) deep = { '!': [deep] };
    expect(promotionConditionProblem(deep)).toMatch(/nested too deeply/);
  });

  it('allows only operators that are registered with JSON Logic', () => {
    // The allowed list never names an operator the engine would reject as unrecognised.
    for (const op of PROMOTION_CONDITION_OPERATORS)
      expect(() => promotionConditionHolds({ [op]: [] }, input()), op).not.toThrow();
  });

  it('parses pasted text, and says why it isn’t one', () => {
    expect(parsePromotionCondition('{"==": [{"var": "order.channel"}, "web"]}')).toEqual({
      condition: { '==': [{ var: 'order.channel' }, 'web'] },
    });
    expect(parsePromotionCondition('{"==": [')).toEqual({
      error: 'The condition isn’t valid JSON.',
    });
    expect(parsePromotionCondition('{"exec": []}')).toEqual({
      error: expect.stringMatching(/can’t use “exec”/),
    });
  });
});

describe('evaluating a condition', () => {
  const holds = (c: unknown, over: Partial<ConditionInput> = {}) =>
    promotionConditionHolds(c, input(over));

  it('holds when the order meets it', () => {
    expect(holds({ '==': [{ var: 'order.meta.shipTo.country' }, 'US'] })).toBe(true);
    expect(holds({ '==': [{ var: 'order.meta.shipTo.region' }, 'TX'] })).toBe(true);
    expect(holds({ '==': [{ var: 'customer.kind' }, 'business'] })).toBe(true);
    expect(holds({ '>=': [{ var: 'order.baseSubtotal' }, 200] })).toBe(true);
    expect(holds({ '>': [{ var: 'order.subtotal' }, 100] })).toBe(false);
    expect(holds({ some: [{ var: 'order.lines' }, { '>=': [{ var: 'qty' }, 3] }] })).toBe(true);
    expect(holds({ all: [{ var: 'order.lines' }, { '>=': [{ var: 'qty' }, 3] }] })).toBe(false);
  });

  it('reads the time it is given, not the clock', () => {
    const c = { '<': [{ var: 'now' }, Date.parse('2026-12-01T00:00:00Z')] };
    expect(holds(c)).toBe(true);
    expect(holds(c, { now: Date.parse('2027-01-01T00:00:00Z') })).toBe(false);
  });

  it('is false for a guest on a customer condition, and for a missing ship-to', () => {
    expect(holds({ '==': [{ var: 'customer.tier' }, 'gold'] }, { customer: undefined })).toBe(
      false,
    );
    expect(holds({ '==': [{ var: 'order.meta.shipTo.country' }, 'US'] }, { meta: {} })).toBe(false);
  });

  it('uses JSON Logic’s truthiness, as a flow’s condition does', () => {
    expect(holds({ filter: [{ var: 'order.lines' }, { '>': [{ var: 'qty' }, 5] }] })).toBe(false);
    expect(holds({ filter: [{ var: 'order.lines' }, { '>': [{ var: 'qty' }, 2] }] })).toBe(true);
  });

  it('fails closed on a stored condition that is not allowed', () => {
    // Written past the check (a hand-edited row): `method` would reach into the data.
    expect(holds({ method: [{ var: 'order.channel' }, 'toString', []] })).toBe(false);
    expect(holds({ '==': [{ var: 'vars.x' }, null] })).toBe(false);
  });
});

describe('create_promotion’s condition', () => {
  const base = { name: 'US only', kind: 'pct' as const, value: 5 };
  const us = { '==': [{ var: 'order.meta.shipTo.country' }, 'US'] };

  it('takes a condition and its message', () => {
    expect(
      TOOL_INPUTS.create_promotion.parse({ ...base, condition: us, conditionMessage: 'US only.' }),
    ).toMatchObject({ condition: us, conditionMessage: 'US only.' });
  });

  it('refuses a condition that isn’t allowed, with the reason', () => {
    const r = TOOL_INPUTS.create_promotion.safeParse({
      ...base,
      condition: { '==': [{ var: 'vars.risk' }, 1] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/isn’t a promotion variable/);
  });

  it('refuses a message with no condition, and one that is too long', () => {
    expect(TOOL_INPUTS.create_promotion.safeParse({ ...base, conditionMessage: 'x' }).success).toBe(
      false,
    );
    expect(
      TOOL_INPUTS.create_promotion.safeParse({
        ...base,
        condition: us,
        conditionMessage: 'x'.repeat(MAX_CONDITION_MESSAGE + 1),
      }).success,
    ).toBe(false);
  });
});

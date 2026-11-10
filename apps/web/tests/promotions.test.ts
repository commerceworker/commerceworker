import { describe, expect, it } from 'vitest';
import { promotionFrom, promotionState } from '../app/lib/promotions';

const DAY = 86_400_000;
const now = Date.parse('2026-10-27T12:00:00Z');

describe('promotionState', () => {
  it('is active or paused as set while the code is in date', () => {
    expect(promotionState({ status: 'active', validTo: null }, now)).toBe('active');
    expect(promotionState({ status: 'paused', validTo: now + DAY }, now)).toBe('paused');
  });

  it('is ended once the end date has passed, whether paused or not', () => {
    // SPRING15: paused, and its last day was weeks ago. "Paused" would suggest Resume brings it back.
    const ended = Date.parse('2026-10-15T23:59:59Z');
    expect(promotionState({ status: 'paused', validTo: ended }, now)).toBe('ended');
    expect(promotionState({ status: 'active', validTo: ended }, now)).toBe('ended');
  });

  it('ends at the instant the discount step stops applying it', () => {
    expect(promotionState({ status: 'active', validTo: now }, now)).toBe('ended');
    expect(promotionState({ status: 'active', validTo: now + 1 }, now)).toBe('active');
  });
});

describe('promotionFrom', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ kind: 'pct', value: '10', name: 'Sale', ...fields }))
      f.set(k, v);
    return f;
  };
  const us = '{"==": [{"var": "order.meta.shipTo.country"}, "US"]}';

  it('reads a condition and its message', () => {
    expect(promotionFrom(form({ condition: us, conditionMessage: ' US only. ' }))).toMatchObject({
      condition: { '==': [{ var: 'order.meta.shipTo.country' }, 'US'] },
      conditionMessage: 'US only.',
    });
    expect(promotionFrom(form({}))).toMatchObject({ condition: null, conditionMessage: null });
  });

  it('refuses a condition that is not JSON, not allowed, or has a message with no condition', () => {
    expect(promotionFrom(form({ condition: '{"==": [' }))).toBe('The condition isn’t valid JSON.');
    expect(promotionFrom(form({ condition: '{"==": [{"var": "vars.risk"}, 1]}' }))).toMatch(
      /isn’t a promotion variable/,
    );
    expect(promotionFrom(form({ condition: '{"method": []}' }))).toMatch(/can’t use “method”/);
    expect(promotionFrom(form({ conditionMessage: 'x' }))).toBe(
      'A message for a failed condition needs a condition.',
    );
  });

  it('reads a buy X, get Y rule, with blanks taking the rule’s defaults', () => {
    expect(
      promotionFrom(form({ kind: 'bxgy', value: '', buyQty: '2', getQty: '1', buySkus: 'TEE' })),
    ).toMatchObject({
      kind: 'bxgy',
      value: 0,
      skus: null,
      bxgy: {
        buy: { skus: ['TEE'], qty: 2 },
        get: { skus: null, qty: 1, percent: 100 },
        repeat: null,
      },
    });
    expect(
      promotionFrom(
        form({
          kind: 'bxgy',
          buyQty: '3',
          getQty: '2',
          getSkus: 'HAT, CAP',
          getPercent: '50',
          repeat: '2',
        }),
      ),
    ).toMatchObject({
      bxgy: {
        buy: { skus: null, qty: 3 },
        get: { skus: ['HAT', 'CAP'], qty: 2, percent: 50 },
        repeat: 2,
      },
    });
    // Other kinds carry no rule, even if its fields were left filled in.
    expect(promotionFrom(form({ buyQty: '2', getQty: '1' }))).toMatchObject({ bxgy: null });
  });

  it('refuses a rule that can never apply', () => {
    const bxgy = (f: Record<string, string>) =>
      promotionFrom(form({ kind: 'bxgy', buyQty: '2', getQty: '1', ...f }));
    expect(bxgy({ getQty: '0' })).toBe('Buy and get each need a quantity of at least 1.');
    expect(bxgy({ buyQty: '' })).toBe('Buy and get each need a quantity of at least 1.');
    expect(bxgy({ buyQty: '1.5' })).toBe('Quantities and repeats are whole numbers.');
    expect(bxgy({ repeat: '0' })).toBe('Repeat is at least 1');
    expect(bxgy({ getPercent: '0' })).toBe('A percentage is above 0');
    expect(bxgy({ getPercent: '101' })).toMatch(/100/);
    expect(bxgy({ buySkus: 'TEE, TEE' })).toBe('A SKU is listed once');
    // The ordinary SKU limit belongs to the other kinds.
    expect(bxgy({ skus: 'TEE' })).toMatchObject({ skus: null });
  });
});

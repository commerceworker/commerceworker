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
});

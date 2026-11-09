import { describe, expect, it } from 'vitest';
import {
  FIRST_PARTY,
  groupBySeller,
  linesSubtotal,
  payoutAmounts,
  sellerOfLine,
  sellerOutcome,
  sellerResponseOf,
} from '../src';

describe('marketplace rules', () => {
  it("takes a line's own seller, then its product's, then first party", () => {
    expect(sellerOfLine({ sku: 'A', qty: 1, sellerId: 'x' }, 'y')).toBe('x');
    expect(sellerOfLine({ sku: 'A', qty: 1 }, 'y')).toBe('y');
    expect(sellerOfLine({ sku: 'A', qty: 1 }, null)).toBe(FIRST_PARTY);
  });

  it('groups lines by seller in first-seen order and totals them', () => {
    const lines = [
      { sku: 'A', qty: 2, unitPrice: 1.5 },
      { sku: 'B', qty: 1, unitPrice: 4 },
      { sku: 'A', qty: 1, unitPrice: 1.5 },
    ];
    const groups = groupBySeller(lines, (sku) => (sku === 'A' ? 'acme' : undefined));
    expect([...groups.keys()]).toEqual(['acme', FIRST_PARTY]);
    expect(linesSubtotal(groups.get('acme')!)).toBe(4.5);
  });

  it('shares refunds pro rata, never more than the seller sold, then takes commission', () => {
    expect(payoutAmounts(40, 0.1, 100, 20)).toEqual({
      gross: 40,
      refunded: 8,
      commission: 3.2,
      net: 28.8,
    });
    expect(payoutAmounts(40, 0.1, 100, 500)).toMatchObject({ refunded: 40, net: 0 });
    expect(payoutAmounts(40, 0.1, 0, 20)).toMatchObject({ refunded: 0, net: 36 });
  });

  it("reads a seller's answer, and refuses anything else", () => {
    expect(
      sellerResponseOf({ sellerId: 'acme', decision: 'rejected', reason: 'Out of stock' }),
    ).toEqual({ sellerId: 'acme', decision: 'rejected', reason: 'Out of stock' });
    expect(sellerResponseOf({ sellerId: 'acme', decision: 'accepted', reason: 3 })).toEqual({
      sellerId: 'acme',
      decision: 'accepted',
    });
    expect(sellerResponseOf({ sellerId: 'acme', decision: 'maybe' })).toBeNull();
    expect(sellerResponseOf({ decision: 'accepted' })).toBeNull();
    expect(sellerResponseOf(undefined)).toBeNull();
  });

  it('says where an order stands once its sellers answer', () => {
    const parts = (...s: string[]) => s.map((status) => ({ status }));
    expect(sellerOutcome(parts('accepted', 'pending'))).toBe('pending');
    expect(sellerOutcome(parts('rejected', 'rejected'))).toBe('rejected');
    expect(sellerOutcome(parts())).toBe('rejected');
    expect(sellerOutcome(parts('accepted', 'accepted'))).toBe('accepted');
    expect(sellerOutcome(parts('accepted', 'rejected'))).toBe('partial');
  });
});

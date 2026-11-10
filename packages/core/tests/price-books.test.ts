import { describe, expect, it } from 'vitest';
import {
  bookEntryId,
  bookInForce,
  normalizeBookCode,
  PRICE_BOOK_LIFECYCLE,
  PRICE_BOOK_STATUSES,
  priceBookDatesProblem,
  priceBookEntryProblem,
  priceBookState,
} from '../src/price-books';

const book = (over: Partial<Parameters<typeof priceBookState>[0]> = {}) => ({
  status: 'active' as const,
  startsAt: null,
  endsAt: null,
  ...over,
});

describe('the price book lifecycle', () => {
  it('allows draft to active or archived, active and inactive both ways, inactive to archived', () => {
    const L = PRICE_BOOK_LIFECYCLE;
    expect(L.can('draft', 'active')).toBe(true);
    expect(L.can('draft', 'archived')).toBe(true);
    expect(L.can('active', 'inactive')).toBe(true);
    expect(L.can('inactive', 'active')).toBe(true);
    expect(L.can('inactive', 'archived')).toBe(true);
    expect(L.can('draft', 'inactive')).toBe(false);
    expect(L.can('active', 'archived')).toBe(false);
    expect(L.can('active', 'draft')).toBe(false);
    expect(L.can('active', 'active')).toBe(false);
  });

  it('ends at archived, which nothing leaves', () => {
    expect(PRICE_BOOK_LIFECYCLE.terminal('archived')).toBe(true);
    expect(PRICE_BOOK_LIFECYCLE.states).toEqual(PRICE_BOOK_STATUSES);
    for (const s of PRICE_BOOK_STATUSES)
      expect(PRICE_BOOK_LIFECYCLE.terminal(s)).toBe(s === 'archived');
    expect(() => PRICE_BOOK_LIFECYCLE.assert('archived', 'active')).toThrow();
  });
});

describe('when a book is in force', () => {
  it('is active and inside its dates: from its start, until (not at) its end', () => {
    const b = book({ startsAt: 1_000, endsAt: 2_000 });
    expect(priceBookState(b, 999)).toBe('scheduled');
    expect(bookInForce(b, 999)).toBe(false);
    expect(bookInForce(b, 1_000)).toBe(true);
    expect(bookInForce(b, 1_999)).toBe(true);
    expect(priceBookState(b, 2_000)).toBe('ended');
    expect(bookInForce(b, 2_000)).toBe(false);
  });

  it('is never in force while draft, inactive or archived, whatever the dates', () => {
    for (const status of ['draft', 'inactive', 'archived'] as const) {
      expect(bookInForce(book({ status }), 500)).toBe(false);
      expect(priceBookState(book({ status }), 500)).toBe(status);
    }
  });

  it('has no bound without a date', () => {
    expect(bookInForce(book(), 0)).toBe(true);
    expect(bookInForce(book({ startsAt: 5 }), Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('what a book is made of', () => {
  it('normalizes a code', () => {
    expect(normalizeBookCode('  Spring-26_B ')).toBe('spring-26_b');
    expect(normalizeBookCode('')).toBeNull();
    expect(normalizeBookCode('has space')).toBeNull();
    expect(normalizeBookCode('-leading')).toBeNull();
    expect(normalizeBookCode('a'.repeat(33))).toBeNull();
    expect(normalizeBookCode('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('needs an end after the start', () => {
    expect(priceBookDatesProblem(null, 5)).toBeNull();
    expect(priceBookDatesProblem(5, null)).toBeNull();
    expect(priceBookDatesProblem(5, 5)).not.toBeNull();
    expect(priceBookDatesProblem(5, 4)).not.toBeNull();
  });

  it('wants one of a price or a percentage, within bounds', () => {
    expect(priceBookEntryProblem({ sku: 'A', price: 0 })).toBeNull();
    expect(priceBookEntryProblem({ sku: 'A', discountPct: 100 })).toBeNull();
    expect(priceBookEntryProblem({ sku: 'A' })).toMatch(/price or a percentage/);
    expect(priceBookEntryProblem({ sku: 'A', price: 1, discountPct: 5 })).toMatch(/not both/);
    expect(priceBookEntryProblem({ sku: 'A', price: -1 })).toMatch(/0 or more/);
    expect(priceBookEntryProblem({ sku: 'A', discountPct: 0 })).toMatch(/above 0/);
    expect(priceBookEntryProblem({ sku: 'A', discountPct: 101 })).toMatch(/at most 100/);
    expect(priceBookEntryProblem({ sku: 'A', price: 1, minQty: 0 })).toMatch(/quantity/);
    expect(priceBookEntryProblem({ sku: ' ', price: 1 })).toMatch(/SKU/);
    // A removal needs only its key.
    expect(priceBookEntryProblem({ sku: 'A' }, true)).toBeNull();
  });

  it('gives an entry one id per book, SKU and quantity', () => {
    expect(bookEntryId('pb_1', 'A', 1)).toBe(bookEntryId('pb_1', 'A', 1));
    expect(bookEntryId('pb_1', 'A', 1)).not.toBe(bookEntryId('pb_1', 'A', 10));
    expect(bookEntryId('pb_1', 'A', 1)).not.toBe(bookEntryId('pb_2', 'A', 1));
  });
});

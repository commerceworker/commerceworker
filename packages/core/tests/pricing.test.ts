import { describe, expect, it } from 'vitest';
import { type PriceRule, type PriceSource, resolvePrice } from '../src/pricing';

const sources: PriceSource[] = [
  { id: 'price_book', label: 'Price books', priority: 10, stopProcessing: true },
  { id: 'contract', label: 'Contract prices', priority: 20, stopProcessing: true },
  { id: 'volume', label: 'Volume tiers', priority: 30, stopProcessing: false },
];
const now = Date.UTC(2026, 9, 13);
const ctx = { customerId: 'cus_a', customerTier: 'gold', now };
const line = (sku: string, qty: number) => ({ sku, qty });

describe('resolvePrice', () => {
  it('falls back to the list price', () => {
    expect(resolvePrice(line('W', 1), 10, sources, [], ctx)).toEqual({
      unitPrice: 10,
      by: { source: 'list', ruleId: null, name: 'List price' },
    });
  });

  it('stops at the first matching source that stops processing', () => {
    const rules: PriceRule[] = [
      { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 9 },
      { id: 'v', source: 'volume', name: '100+', sku: 'W', minQty: 100, price: 7 },
    ];
    // The contract stops the chain, so the cheaper volume tier is never reached...
    expect(resolvePrice(line('W', 200), 10, sources, rules, ctx).by.ruleId).toBe('c');
    // ...unless the contract doesn't stop, and then the lowest candidate wins.
    const open = sources.map((s) => ({ ...s, stopProcessing: false }));
    expect(resolvePrice(line('W', 200), 10, open, rules, ctx)).toMatchObject({
      unitPrice: 7,
      by: { source: 'volume', ruleId: 'v' },
    });
    // A contract above list price still wins: it is what was agreed.
    const high: PriceRule[] = [{ ...rules[0]!, price: 11 }];
    expect(resolvePrice(line('W', 1), 10, sources, high, ctx).unitPrice).toBe(11);
  });

  it('runs sources by priority, so a price book outranks a contract', () => {
    const rules: PriceRule[] = [
      { id: 'b', source: 'price_book', name: 'Gold book', customerTier: 'gold', discountPct: 5 },
      { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 8 },
    ];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx)).toMatchObject({
      unitPrice: 9.5,
      by: { source: 'price_book', ruleId: 'b' },
    });
    const contractFirst = sources.map((s) => (s.id === 'contract' ? { ...s, priority: 1 } : s));
    expect(resolvePrice(line('W', 1), 10, contractFirst, rules, ctx).unitPrice).toBe(8);
  });

  it('takes the deepest matching volume tier and respects every scope', () => {
    const rules: PriceRule[] = [
      { id: 'v100', source: 'volume', name: '100+', sku: 'W', minQty: 100, discountPct: 5 },
      { id: 'v500', source: 'volume', name: '500+', sku: 'W', minQty: 500, discountPct: 12 },
      { id: 'other', source: 'volume', name: 'Other SKU', sku: 'X', price: 1 },
      { id: 'silver', source: 'volume', name: 'Silver', customerTier: 'silver', price: 1 },
      { id: 'later', source: 'volume', name: 'Next year', startsAt: now + 1, price: 1 },
      { id: 'ended', source: 'volume', name: 'Last year', endsAt: now, price: 1 },
      { id: 'empty', source: 'volume', name: 'No action' },
    ];
    expect(resolvePrice(line('W', 99), 10, sources, rules, ctx).by.source).toBe('list');
    expect(resolvePrice(line('W', 100), 10, sources, rules, ctx).unitPrice).toBe(9.5);
    expect(resolvePrice(line('W', 750), 10, sources, rules, ctx)).toMatchObject({
      unitPrice: 8.8,
      by: { ruleId: 'v500' },
    });
  });

  it('skips sources that are not in the chain', () => {
    const rules: PriceRule[] = [{ id: 'c', source: 'contract', name: 'Contract', price: 1 }];
    const noContract = sources.filter((s) => s.id !== 'contract');
    expect(resolvePrice(line('W', 1), 10, noContract, rules, ctx).by.source).toBe('list');
  });
});

describe('resolvePrice across price books', () => {
  const book = (
    id: string,
    bookPriority: number,
    price: number,
    over: Partial<PriceRule> = {},
  ): PriceRule => ({
    id: `e_${id}_${price}`,
    source: 'price_book',
    name: `Book ${id}`,
    sku: 'W',
    price,
    bookId: id,
    bookPriority,
    ...over,
  });

  it('prefers the highest-priority book over a lower price in another', () => {
    const rules = [book('low', 1, 4), book('high', 5, 9)];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx)).toEqual({
      unitPrice: 9,
      by: { source: 'price_book', ruleId: 'e_high_9', name: 'Book high', bookId: 'high' },
    });
    // The order the rules arrive in changes nothing.
    expect(resolvePrice(line('W', 1), 10, sources, [...rules].reverse(), ctx).by).toMatchObject({
      bookId: 'high',
    });
  });

  it('takes the lowest price within the winning book, so the deepest tier wins', () => {
    const rules = [
      book('high', 5, 9),
      book('high', 5, 8, { id: 'tier10', minQty: 10 }),
      book('high', 5, 6, { id: 'tier100', minQty: 100 }),
      book('low', 1, 1),
    ];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx).unitPrice).toBe(9);
    expect(resolvePrice(line('W', 10), 10, sources, rules, ctx).by.ruleId).toBe('tier10');
    expect(resolvePrice(line('W', 500), 10, sources, rules, ctx).by.ruleId).toBe('tier100');
  });

  it('falls to a lower-priority book for a SKU the higher one does not price', () => {
    const rules = [book('high', 5, 9, { sku: 'X' }), book('low', 1, 4)];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx).by).toMatchObject({ bookId: 'low' });
  });

  it('falls to a lower-priority book when the higher one is not yet at its quantity', () => {
    const rules = [book('high', 5, 6, { minQty: 100 }), book('low', 1, 9)];
    expect(resolvePrice(line('W', 99), 10, sources, rules, ctx).by).toMatchObject({
      bookId: 'low',
    });
    expect(resolvePrice(line('W', 100), 10, sources, rules, ctx).by).toMatchObject({
      bookId: 'high',
    });
  });

  it('ranks an entry in no book below every book', () => {
    const rules: PriceRule[] = [
      { id: 'tier', source: 'price_book', name: 'Gold', customerTier: 'gold', price: 3 },
      book('b', -5, 9),
    ];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx).by).toMatchObject({ bookId: 'b' });
    // With no book pricing the line, the book-less rule stands as before.
    expect(resolvePrice(line('W', 1), 10, sources, rules.slice(0, 1), ctx)).toMatchObject({
      unitPrice: 3,
      by: { ruleId: 'tier' },
    });
  });

  it('prices a percentage book entry off the list price', () => {
    const rules = [book('pct', 2, 0, { price: null, discountPct: 20 })];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx).unitPrice).toBe(8);
  });

  it('breaks ties between equal priority and price by book id, then entry id, whatever the order', () => {
    const rules = [book('b', 3, 7), book('a', 3, 7), book('a', 3, 7, { id: 'a_second' })];
    for (const order of [rules, [...rules].reverse(), [rules[1]!, rules[2]!, rules[0]!]])
      expect(resolvePrice(line('W', 1), 10, sources, order, ctx).by).toMatchObject({
        bookId: 'a',
        ruleId: 'a_second',
      });
  });

  it('still takes the lowest price among the other sources, ties by entry id', () => {
    const rules: PriceRule[] = [
      { id: 'z', source: 'volume', name: 'Z', sku: 'W', price: 5 },
      { id: 'a', source: 'volume', name: 'A', sku: 'W', price: 5 },
      { id: 'm', source: 'volume', name: 'M', sku: 'W', price: 6 },
    ];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx).by.ruleId).toBe('a');
    expect(resolvePrice(line('W', 1), 10, sources, [...rules].reverse(), ctx).by.ruleId).toBe('a');
  });

  it('keeps the chain: a contract can still beat a book that does not stop processing', () => {
    const open = sources.map((s) => (s.id === 'price_book' ? { ...s, stopProcessing: false } : s));
    const rules: PriceRule[] = [
      book('high', 5, 9),
      { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 7 },
    ];
    expect(resolvePrice(line('W', 1), 10, open, rules, ctx).by.source).toBe('contract');
  });
});

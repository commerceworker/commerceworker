import { describe, expect, it } from 'vitest';
import { BOOK_STATES, entriesFrom, entryLabel, priceBookFrom } from '../app/lib/price-books';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ code: 'Spring-27', name: 'Spring', ...fields }))
    f.set(k, v);
  return f;
};

describe('priceBookFrom', () => {
  it('reads a book: a normalized code, a priority, and dates as the first day and the day after the last', () => {
    expect(priceBookFrom(form({}))).toEqual({ code: 'spring-27', name: 'Spring', priority: 0 });
    expect(
      priceBookFrom(form({ priority: '7', startsAt: '2027-03-01', endsAt: '2027-03-31' })),
    ).toEqual({
      code: 'spring-27',
      name: 'Spring',
      priority: 7,
      startsAt: Date.UTC(2027, 2, 1),
      // The last day counts: the book ends as April starts.
      endsAt: Date.UTC(2027, 3, 1),
    });
  });

  it('refuses a missing name or code, a priority out of range and dates in the wrong order', () => {
    expect(priceBookFrom(form({ name: ' ' }))).toBe('Give the book a name.');
    expect(priceBookFrom(form({ code: 'no spaces' }))).toMatch(/A code is/);
    expect(priceBookFrom(form({ priority: '1.5' }))).toMatch(/whole number/);
    expect(priceBookFrom(form({ priority: '5000' }))).toMatch(/whole number/);
    expect(priceBookFrom(form({ startsAt: '2027-03-31', endsAt: '2027-03-01' }))).toBe(
      'A book ends after it starts.',
    );
  });
});

describe('entriesFrom', () => {
  it('reads a SKU and a price, an optional quantity, and a percentage off list', () => {
    expect(entriesFrom('WID-100 12.50\nWID-100, 500, 11.25\nGSK-010 10%\n\n WID-9 100 5%')).toEqual(
      [
        { sku: 'WID-100', price: 12.5 },
        { sku: 'WID-100', minQty: 500, price: 11.25 },
        { sku: 'GSK-010', discountPct: 10 },
        { sku: 'WID-9', minQty: 100, discountPct: 5 },
      ],
    );
  });

  it('names the line it cannot read, and refuses nothing and too many', () => {
    expect(entriesFrom('A 1\nB')).toMatch(/^Line 2:/);
    expect(entriesFrom('A one')).toMatch(/^Line 1:/);
    expect(entriesFrom('A 0 5')).toMatch(/^Line 1:/);
    expect(entriesFrom('A 1 2 3')).toMatch(/^Line 1:/);
    expect(entriesFrom('  \n')).toMatch(/at least one/);
    expect(entriesFrom(Array.from({ length: 201 }, (_, i) => `S${i} 1`).join('\n'))).toMatch(
      /At most 200/,
    );
  });
});

describe('how a book is shown', () => {
  it('has a label and tone for every state', () => {
    for (const s of ['draft', 'active', 'scheduled', 'ended', 'inactive', 'archived'] as const)
      expect(BOOK_STATES[s].label).toBeTruthy();
    expect(BOOK_STATES.active.tone).toBe('ok');
  });

  it('says a price or a percentage off list', () => {
    const m = (n: number) => `$${n}`;
    expect(entryLabel({ price: 4, discountPct: null }, m)).toBe('$4');
    expect(entryLabel({ price: null, discountPct: 12 }, m)).toBe('12% off list');
  });
});

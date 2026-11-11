import { describe, expect, it } from 'vitest';
import {
  createQuoteInput,
  dayOfExpiry,
  decodeQuoteCursor,
  encodeQuoteCursor,
  expiryOfDay,
  QUOTE_LIFECYCLE,
  QUOTE_STATUSES,
  type QuoteStatus,
  quoteConversion,
  quoteConvertProblem,
  quoteDraftProblem,
  quoteEditable,
  quoteLineRule,
  quoteLive,
  quoteOrderUnstarted,
  quotePoId,
  quotePoNumber,
  quoteRevisable,
  quoteSendProblem,
  quoteState,
  quoteTotal,
  updateQuoteInput,
} from '../src';
import { type PriceRule, type PriceSource, resolvePrice } from '../src/pricing';

describe('the quote lifecycle', () => {
  it('moves along the lifecycle the plan names, and no other way', () => {
    expect(QUOTE_LIFECYCLE.states).toEqual(QUOTE_STATUSES);
    expect(QUOTE_LIFECYCLE.next('draft')).toEqual(['sent', 'declined']);
    expect(QUOTE_LIFECYCLE.next('sent')).toEqual(['accepted', 'declined', 'expired', 'superseded']);
    // An accepted quote is a deal: it can only end early, never be edited or revised.
    expect(QUOTE_LIFECYCLE.next('accepted')).toEqual(['expired']);
    expect(QUOTE_LIFECYCLE.next('declined')).toEqual(['superseded']);
    expect(QUOTE_LIFECYCLE.next('expired')).toEqual(['superseded']);
    expect(QUOTE_LIFECYCLE.terminal('superseded')).toBe(true);
    for (const s of QUOTE_STATUSES) expect(QUOTE_LIFECYCLE.can(s, 'draft')).toBe(false);
    // Every state but a draft can be reached, and a superseded one only by revising.
    expect(QUOTE_LIFECYCLE.reachable('draft').size).toBe(QUOTE_STATUSES.length);
  });

  it('edits only a draft and revises only a sent, declined or expired quote', () => {
    for (const s of QUOTE_STATUSES) expect(quoteEditable(s)).toBe(s === 'draft');
    const revisable = QUOTE_STATUSES.filter(quoteRevisable);
    expect(revisable).toEqual<QuoteStatus[]>(['sent', 'declined', 'expired']);
  });
});

describe('when a quote is in force', () => {
  const accepted = { status: 'accepted', expiresAt: 1_000 } as const;

  it('counts only while accepted and before its expiry', () => {
    expect(quoteLive(accepted, 999)).toBe(true);
    expect(quoteLive(accepted, 1_000)).toBe(false);
    for (const s of QUOTE_STATUSES.filter((x) => x !== 'accepted'))
      expect(quoteLive({ status: s, expiresAt: 1_000 }, 0)).toBe(false);
    expect(quoteLive({ status: 'accepted', expiresAt: null }, 0)).toBe(false);
  });

  it('reads a sent or accepted quote past its expiry as expired, and nothing else', () => {
    expect(quoteState({ status: 'sent', expiresAt: 1_000 }, 999)).toBe('sent');
    expect(quoteState({ status: 'sent', expiresAt: 1_000 }, 1_000)).toBe('expired');
    expect(quoteState(accepted, 1_000)).toBe('expired');
    expect(quoteState({ status: 'draft', expiresAt: 1_000 }, 5_000)).toBe('draft');
    expect(quoteState({ status: 'declined', expiresAt: 1_000 }, 5_000)).toBe('declined');
  });

  it('turns a line into the quote source’s entry for the company, up to its quantity, until it expires', () => {
    expect(
      quoteLineRule({ id: 'qt_1', name: 'Spring', companyId: 'cus_a', expiresAt: 5_000 }, 2, {
        sku: 'W',
        qty: 40,
        unitPrice: 6.5,
      }),
    ).toEqual({
      id: 'quote_qt_1_2',
      source: 'quote',
      name: 'Quote Spring',
      sku: 'W',
      customerId: 'cus_a',
      maxQty: 40,
      price: 6.5,
      endsAt: 5_000,
    });
  });
});

describe('the quote source in the pricing chain', () => {
  const sources: PriceSource[] = [
    { id: 'quote', label: 'Quotes', priority: 5, stopProcessing: true },
    { id: 'price_book', label: 'Price books', priority: 10, stopProcessing: true },
    { id: 'contract', label: 'Contract prices', priority: 20, stopProcessing: true },
    { id: 'volume', label: 'Volume tiers', priority: 30, stopProcessing: false },
  ];
  const now = 2_000;
  const ctx: { customerId: string | null; customerTier: string; now: number } = {
    customerId: 'cus_a',
    customerTier: 'gold',
    now,
  };
  const quote: PriceRule = quoteLineRule(
    { id: 'qt_1', name: 'Spring', companyId: 'cus_a', expiresAt: 5_000 },
    0,
    { sku: 'W', qty: 50, unitPrice: 12 },
  );
  const rules: PriceRule[] = [
    { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 9 },
    { id: 'b', source: 'price_book', name: 'Book', sku: 'W', price: 8 },
    { id: 'v', source: 'volume', name: '10+', sku: 'W', minQty: 10, price: 7 },
  ];
  const price = (qty: number, over: Partial<typeof ctx> = {}, rs = [quote, ...rules]) =>
    resolvePrice({ sku: 'W', qty }, 15, sources, rs, { ...ctx, ...over });

  it('wins over every other source, even a cheaper one, and stops the chain', () => {
    expect(price(20)).toMatchObject({
      unitPrice: 12,
      by: { source: 'quote', ruleId: 'quote_qt_1_0' },
    });
  });

  it('covers a quantity up to the line’s and not a unit past it', () => {
    expect(price(50).by.source).toBe('quote');
    // Past it the chain is what it was: the book, which stops it.
    expect(price(51)).toMatchObject({ unitPrice: 8, by: { source: 'price_book' } });
    expect(price(1).by.source).toBe('quote');
  });

  it('is for its company only, and only until it expires', () => {
    expect(price(20, { customerId: 'cus_b' }).by.source).not.toBe('quote');
    expect(price(20, { customerId: null }).by.source).not.toBe('quote');
    expect(price(20, { now: 4_999 }).by.source).toBe('quote');
    expect(price(20, { now: 5_000 }).by.source).not.toBe('quote');
  });

  it('takes the lowest of several quotes for the line', () => {
    const other = quoteLineRule(
      { id: 'qt_2', name: 'Summer', companyId: 'cus_a', expiresAt: 5_000 },
      0,
      { sku: 'W', qty: 50, unitPrice: 11 },
    );
    expect(price(20, {}, [quote, other, ...rules])).toMatchObject({
      unitPrice: 11,
      by: { ruleId: 'quote_qt_2_0' },
    });
  });
});

describe('what a draft needs', () => {
  const ok = {
    company: { status: 'active' as const },
    buyer: { companyId: 'cus_a', status: 'active' as const },
    unknownSkus: [] as string[],
  };
  const draft = { companyId: 'cus_a', buyerId: 'm_1', lines: [{ sku: 'A' }, { sku: 'B' }] };

  it('is a company’s lines of known products, once each, for an active company and buyer', () => {
    expect(quoteDraftProblem(draft, ok)).toBeNull();
    expect(quoteDraftProblem({ ...draft, buyerId: null }, { ...ok, buyer: undefined })).toBeNull();
    expect(quoteDraftProblem({ ...draft, lines: [] }, ok)).toBe('A quote needs at least one line.');
    expect(quoteDraftProblem({ ...draft, lines: [{ sku: 'A' }, { sku: 'A' }] }, ok)).toBe(
      'A is on the quote twice: a quote prices a SKU once.',
    );
    expect(quoteDraftProblem(draft, { ...ok, unknownSkus: ['X', 'Y'] })).toBe(
      'No product has the SKU X, Y.',
    );
    expect(quoteDraftProblem(draft, { ...ok, company: undefined })).toMatch(/isn't a company/);
    expect(quoteDraftProblem(draft, { ...ok, company: { status: 'suspended' } })).toMatch(
      /isn't active \(suspended\)/,
    );
    expect(quoteDraftProblem(draft, { ...ok, buyer: undefined })).toMatch(/isn't an active member/);
    expect(
      quoteDraftProblem(draft, { ...ok, buyer: { companyId: 'cus_b', status: 'active' } }),
    ).toMatch(/isn't an active member/);
    expect(
      quoteDraftProblem(draft, { ...ok, buyer: { companyId: 'cus_a', status: 'inactive' } }),
    ).toMatch(/isn't an active member/);
  });

  it('is sent with an expiry ahead of now', () => {
    expect(quoteSendProblem({ expiresAt: null }, 0)).toBe(
      'A quote needs an expiry before it is sent.',
    );
    expect(quoteSendProblem({ expiresAt: 100 }, 100)).toBe('The quote’s expiry has passed.');
    expect(quoteSendProblem({ expiresAt: 101 }, 100)).toBeNull();
  });
});

describe('converting', () => {
  it('goes to a PO draft for a company that uses POs, and to an order for any other', () => {
    expect(quoteConversion(true)).toBe('po');
    expect(quoteConversion(false)).toBe('order');
  });

  it('needs an accepted quote with time left, and a repeat is always fine', () => {
    const base = { status: 'accepted', expiresAt: 100, convertedId: null } as const;
    expect(quoteConvertProblem(base, 99)).toBeNull();
    expect(quoteConvertProblem(base, 100)).toBe('The quote has expired.');
    expect(quoteConvertProblem({ ...base, status: 'sent' }, 0)).toMatch(/Only an accepted quote/);
    expect(quoteConvertProblem({ ...base, convertedId: 'po_1' }, 500)).toBeNull();
    // An order claimed but not started would not be priced at a quote that has expired.
    expect(quoteConvertProblem({ ...base, convertedId: 'quote:qt_1' }, 99)).toBeNull();
    expect(quoteConvertProblem({ ...base, convertedId: 'quote:qt_1' }, 100)).toMatch(
      /would not be priced at it/,
    );
    expect(quoteOrderUnstarted({ convertedId: 'quote:qt_1' })).toBe(true);
    expect(quoteOrderUnstarted({ convertedId: 'ord_1' })).toBe(false);
    expect(quoteOrderUnstarted({ convertedId: null })).toBe(false);
  });

  it('names its PO draft and number from the quote, so converting twice makes one', () => {
    expect(quotePoId('qt_abc')).toBe('po_qt_abc');
    expect(quotePoNumber({ id: 'qt_abc12', version: 3 })).toBe('Q-ABC12-V3');
    expect(quotePoNumber({ id: `qt_${'x'.repeat(100)}`, version: 1 })).toHaveLength(64);
  });
});

describe('totals, days and cursors', () => {
  it('totals a quote’s lines to the cent', () => {
    expect(quoteTotal([])).toBe(0);
    expect(
      quoteTotal([
        { qty: 3, unitPrice: 0.1 },
        { qty: 7, unitPrice: 19.99 },
      ]),
    ).toBe(140.23);
  });

  it('takes an expiry day as the end of that day (UTC), and reads it back', () => {
    expect(expiryOfDay('2026-12-01')).toBe(Date.UTC(2026, 11, 2));
    expect(dayOfExpiry(expiryOfDay('2026-12-01'))).toBe('2026-12-01');
  });

  it('round-trips a cursor and drops anything else', () => {
    const c = { at: 1_700_000_000_000, id: 'qt_1' };
    expect(decodeQuoteCursor(encodeQuoteCursor(c))).toEqual(c);
    expect(decodeQuoteCursor('not a cursor')).toBeUndefined();
  });
});

describe('the quote inputs', () => {
  const line = { sku: ' W ', qty: 5, unitPrice: 2 };

  it('trims, bounds and names what a caller may write', () => {
    const made = createQuoteInput.parse({
      companyId: 'cus_a',
      name: ' Spring ',
      expiresOn: '2026-12-01',
      lines: [line],
    });
    expect(made).toMatchObject({ name: 'Spring', lines: [{ sku: 'W' }] });
    for (const bad of [
      { lines: [] },
      { name: '' },
      { expiresOn: '1 Dec' },
      { lines: [{ ...line, qty: 0 }] },
      { lines: [{ ...line, unitPrice: -1 }] },
      { lines: Array.from({ length: 201 }, () => line) },
    ])
      expect(
        createQuoteInput.safeParse({ companyId: 'c', name: 'n', lines: [line], ...bad }).success,
      ).toBe(false);
  });

  it('lets an update leave a field out, or clear the optional ones with null', () => {
    expect(updateQuoteInput.parse({ quoteId: 'qt_1' })).toEqual({ quoteId: 'qt_1' });
    expect(
      updateQuoteInput.parse({ quoteId: 'qt_1', expiresOn: null, notes: null, buyerId: null }),
    ).toEqual({
      quoteId: 'qt_1',
      expiresOn: null,
      notes: null,
      buyerId: null,
    });
    expect(updateQuoteInput.safeParse({ name: 'x' }).success).toBe(false);
  });
});

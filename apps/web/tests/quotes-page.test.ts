import { QUOTE_STATUSES, type Quote, type QuoteLine } from '@commerceworker/core';
import {
  InMemoryCompanyDirectory,
  InMemoryPricingStore,
  InMemoryPurchaseOrderStore,
  InMemoryQuoteStore,
  PRICING_FIXTURE,
  PriceBookData,
  QuoteData,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it, vi } from 'vitest';
import {
  filterQuery,
  filtersFrom,
  lineDiscount,
  linesFrom,
  QUOTE_TONE,
  quoteMoves,
} from '../app/lib/quotes';

const data = new QuoteData();
const store = new InMemoryQuoteStore(data);
const pos = new InMemoryPurchaseOrderStore();
const directory = new InMemoryCompanyDirectory({
  customers: ['acme', 'globex'].map((id) => ({
    id,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    kind: 'business',
    tier: 'standard',
    creditLimit: 0,
    balance: 0,
    terms: 'net_30',
    stripeCustomerId: null,
    stripePaymentMethodId: null,
  })),
  companies: ['acme', 'globex'].map((id) => ({
    customerId: id,
    status: 'active' as const,
    legalName: id,
    taxId: null,
    parentCompanyId: null,
    createdAt: 1,
    updatedAt: 1,
  })),
  members: [
    {
      id: 'm1',
      companyId: 'acme',
      name: 'Ann',
      email: 'ann@example.test',
      role: 'buyer',
      teamId: null,
      status: 'active',
      orderLimit: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});
vi.mock('../app/lib/wire.server', () => ({
  quoteStore: () => store,
  purchaseOrderStore: () => pos,
  companyDirectory: () => directory,
  pricingStore: () =>
    new InMemoryPricingStore(PRICING_FIXTURE, { now: () => new Date() }, new PriceBookData(), data),
}));
const server = await import('../app/lib/quotes.server');

const quote = (id: string, companyId: string, over: Partial<Quote> = {}): Quote => ({
  id,
  rootId: id,
  version: 1,
  companyId,
  buyerId: null,
  name: `Quote ${id}`,
  status: 'draft',
  expiresAt: null,
  notes: null,
  convertedTo: null,
  convertedId: null,
  convertedAt: null,
  sentAt: null,
  decidedAt: null,
  createdBy: null,
  createdAt: Date.parse('2026-11-02T10:00:00Z'),
  updatedAt: 1,
  ...over,
});
const lines: QuoteLine[] = [{ sku: 'W-1', name: null, qty: 10, listPrice: 5, unitPrice: 4 }];

describe('the list’s filters', () => {
  it('reads known values and drops the rest', () => {
    expect(filtersFrom(new URLSearchParams('status=sent&company= acme &q= Spring '))).toEqual({
      status: 'sent',
      company: 'acme',
      q: 'Spring',
    });
    expect(filtersFrom(new URLSearchParams('status=bogus&company='))).toEqual({});
  });

  it('keeps the filters in a page link, with the cursor on top, and is empty with none', () => {
    expect(filterQuery({})).toBe('');
    expect(filterQuery({ status: 'draft', q: 'A B' }, { after: 'c1' })).toBe(
      '?status=draft&q=A+B&after=c1',
    );
  });

  it('gives every status a tone', () => {
    for (const s of QUOTE_STATUSES) expect(QUOTE_TONE[s]).toBeTruthy();
  });
});

describe('the draft form’s fields', () => {
  const form = (rows: [string, string, string, string][]) => {
    const f = new FormData();
    for (const [sku, name, qty, price] of rows) {
      f.append('sku', sku);
      f.append('name', name);
      f.append('qty', qty);
      f.append('unitPrice', price);
    }
    return f;
  };

  it('reads lines a row at a time, skipping blank rows', () => {
    expect(
      linesFrom(
        form([
          [' W-1 ', 'Widget', '2', '1.5'],
          ['', '', '', ''],
          ['W-2', '', '4', '0'],
        ]),
      ),
    ).toEqual([
      { sku: 'W-1', name: 'Widget', qty: 2, unitPrice: 1.5 },
      { sku: 'W-2', qty: 4, unitPrice: 0 },
    ]);
  });

  it('refuses a SKU with no usable quantity or price, naming the line', () => {
    expect(linesFrom(form([['W-1', '', '0', '1']]))).toMatch(/Line 1 \(W-1\) needs a quantity/);
    expect(linesFrom(form([['W-1', '', '', '1']]))).toMatch(/needs a quantity/);
    expect(
      linesFrom(
        form([
          ['W-1', '', '1', '1'],
          ['W-2', '', 'x', '1'],
        ]),
      ),
    ).toMatch(/Line 2/);
    // A quote's price is what it is: a line with none is refused, unlike a PO's expected price.
    expect(linesFrom(form([['W-1', '', '1', '']]))).toMatch(/needs a price/);
    expect(linesFrom(form([['W-1', '', '1', '-3']]))).toMatch(/needs a price/);
  });

  it('shows what a line takes off its list price', () => {
    expect(lineDiscount({ listPrice: 10, unitPrice: 7.5 })).toBe(25);
    expect(lineDiscount({ listPrice: null, unitPrice: 7.5 })).toBeNull();
    expect(lineDiscount({ listPrice: 10, unitPrice: 12 })).toBe(-20);
  });
});

describe('the moves a page offers', () => {
  it('follows the lifecycle: edit and send a draft, answer a sent quote, revise what ended, convert once', () => {
    expect(quoteMoves('draft', false)).toMatchObject({
      edit: true,
      send: true,
      decline: true,
      revise: false,
    });
    expect(quoteMoves('sent', false)).toMatchObject({
      edit: false,
      accept: true,
      decline: true,
      end: true,
      revise: true,
    });
    expect(quoteMoves('accepted', false)).toMatchObject({
      convert: true,
      end: true,
      revise: false,
    });
    expect(quoteMoves('accepted', true).convert).toBe(false);
    for (const s of ['declined', 'expired'] as const)
      expect(quoteMoves(s, false)).toMatchObject({ revise: true, accept: false, end: false });
    expect(quoteMoves('superseded', false)).toEqual({
      edit: false,
      send: false,
      accept: false,
      decline: false,
      end: false,
      revise: false,
      convert: false,
    });
  });
});

describe('what the loaders hand the pages', () => {
  it('pages the list with company names, what each is now, and a cursor', async () => {
    await store.create(quote('qt_1', 'acme', { expiresAt: 5_000, status: 'sent' }), lines);
    await store.create(
      quote('qt_2', 'globex', { createdAt: Date.parse('2026-11-03T10:00:00Z') }),
      lines,
    );
    const first = await server.quotePage({}, undefined);
    expect(first.quotes.map((q) => q.id)).toEqual(['qt_2', 'qt_1']);
    expect(first.total).toBe(2);
    expect(first.companies).toEqual({ globex: 'Name globex', acme: 'Name acme' });
    // A sent quote past its expiry reads as expired.
    expect(first.quotes.find((q) => q.id === 'qt_1')?.state).toBe('expired');
    expect(first.quotes.find((q) => q.id === 'qt_2')?.state).toBe('draft');
    expect(
      (await server.quotePage({ company: 'acme' }, undefined)).quotes.map((q) => q.id),
    ).toEqual(['qt_1']);
    expect((await server.quotePage({ q: 'qt_2' }, undefined)).total).toBe(1);
    expect(await server.quotePage({}, 'junk')).toMatchObject({
      quotes: [],
      error: expect.stringMatching(/cursor/),
    });
  });

  it('gives a quote its lines, versions and the active members to pick from, and null for a stranger', async () => {
    const d = await server.quoteDetail('qt_1');
    expect(d?.quote.lines).toEqual(lines);
    expect(d?.quote.versions).toEqual([{ id: 'qt_1', version: 1, status: 'sent' }]);
    expect(d?.state).toBe('expired');
    expect(d?.members).toEqual([{ id: 'm1', name: 'Ann', email: 'ann@example.test' }]);
    expect(d?.company).toMatchObject({ id: 'acme', name: 'Name acme' });
    expect(await server.quoteDetail('qt_nope')).toBeNull();
  });

  it('says a conversion is settled only when its order is recorded or its PO draft exists, so Convert stays to finish one', async () => {
    const claimed = (id: string, convertedTo: 'po' | 'order', convertedId: string) =>
      store.create(
        quote(id, 'acme', { status: 'accepted', expiresAt: 5_000, convertedTo, convertedId }),
        lines,
      );
    await claimed('qt_c1', 'order', 'quote:qt_c1');
    await claimed('qt_c2', 'order', 'ord_9');
    await claimed('qt_c3', 'po', 'po_qt_c3');
    await claimed('qt_c4', 'po', 'po_qt_c4');
    await pos.create(
      {
        id: 'po_qt_c4',
        companyId: 'acme',
        buyerId: null,
        poNumber: 'Q-C4',
        status: 'draft',
        currency: 'USD',
        shipTo: null,
        notes: null,
        quoteId: 'qt_c4',
        orderId: null,
        source: 'api',
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    const settled = async (id: string) => (await server.quoteDetail(id))?.settled;
    // An order's start key, and a PO draft that was never made, are claims; the others are done.
    expect([
      await settled('qt_c1'),
      await settled('qt_c2'),
      await settled('qt_c3'),
      await settled('qt_c4'),
    ]).toEqual([false, true, false, true]);
    expect(quoteMoves('accepted', false).convert).toBe(true);
    expect(quoteMoves('accepted', true).convert).toBe(false);
  });
});

import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryCompanyDirectory,
  InMemoryPriceBookStore,
  InMemoryPricingStore,
  PRICING_FIXTURE,
  PriceBookData,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  assignPriceBook,
  createPriceBook,
  getPriceBook,
  listPriceBooks,
  previewPrice,
  priceOrder,
  putContractPrices,
  putPriceBookEntries,
  setPriceBookStatus,
} from '../src/commerce';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const DAY = 86_400_000;

function ports() {
  const data = new PriceBookData();
  return {
    books: new InMemoryPriceBookStore(data),
    pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock(new Date(NOW)), data),
    // pc_twin_a's company is suspended; the other customers have none.
    companies: new InMemoryCompanyDirectory({
      customers: PRICING_FIXTURE.customers,
      companies: [
        {
          customerId: 'pc_twin_a',
          status: 'suspended',
          legalName: 'Twin A',
          taxId: null,
          parentCompanyId: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  };
}

/** A book made, filled, assigned to the gold customer and activated, the way staff would. */
async function liveBook(
  p: ReturnType<typeof ports>,
  over: { code: string; priority?: number; price?: number; startsAt?: number; endsAt?: number },
) {
  const made = await createPriceBook(
    p,
    {
      code: over.code,
      name: `Book ${over.code}`,
      priority: over.priority,
      startsAt: over.startsAt,
      endsAt: over.endsAt,
    },
    'ann@example.com',
    NOW,
    `pb_${over.code}`,
  );
  if (!made.ok) throw new Error(made.error);
  const id = made.book.id;
  await putPriceBookEntries(
    p,
    { bookId: id, entries: [{ sku: 'PC-SKU-1', price: over.price ?? 7 }] },
    NOW,
  );
  await assignPriceBook(p, { bookId: id, customerId: 'pc_northwind' }, NOW);
  const on = await setPriceBookStatus(p, { bookId: id, status: 'active' }, NOW);
  if (!on.ok) throw new Error(on.error);
  return id;
}

describe('creating and listing price books', () => {
  it('adds a draft with a normalized code, once per code', async () => {
    const p = ports();
    const r = await createPriceBook(
      p,
      { code: ' Spring-26 ', name: ' Spring ' },
      'ann',
      NOW,
      'pb_1',
    );
    expect(r).toMatchObject({
      ok: true,
      book: { code: 'spring-26', name: 'Spring', status: 'draft', priority: 0, createdBy: 'ann' },
      audit: { action: 'price_book.created', target: 'pb_1' },
    });
    expect(
      await createPriceBook(p, { code: 'SPRING-26', name: 'Again' }, 'ann', NOW, 'pb_2'),
    ).toEqual({
      ok: false,
      error: 'The code spring-26 is taken by another price book.',
    });
  });

  it('refuses a code that is not one and dates that end before they start', async () => {
    const p = ports();
    expect(
      await createPriceBook(p, { code: 'no spaces', name: 'x' }, 'a', NOW, 'pb_1'),
    ).toMatchObject({ ok: false });
    expect(
      await createPriceBook(
        p,
        { code: 'ok', name: 'x', startsAt: NOW, endsAt: NOW },
        'a',
        NOW,
        'pb_1',
      ),
    ).toEqual({ ok: false, error: 'A book ends after it starts.' });
    expect((await listPriceBooks(p)).total).toBe(0);
  });

  it('lists a page at a time, with the cursor to continue', async () => {
    const p = ports();
    for (const c of ['a', 'b', 'c'])
      await createPriceBook(p, { code: c, name: c }, 'ann', NOW, `pb_${c}`);
    const first = await listPriceBooks(p, { limit: 2 });
    expect(first.books.map((b) => b.code)).toEqual(['a', 'b']);
    const second = await listPriceBooks(p, { limit: 2, after: first.next ?? undefined });
    expect(second.books.map((b) => b.code)).toEqual(['c']);
    expect(second.next).toBeNull();
  });
});

describe('the lifecycle', () => {
  it('moves along draft, active, inactive, archived, and says why it cannot', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    const to = (status: 'active' | 'inactive' | 'archived') =>
      setPriceBookStatus(p, { bookId: 'x', status }, NOW);
    expect(await to('inactive')).toEqual({
      ok: false,
      error: "A draft book can't become inactive.",
    });
    expect(await to('active')).toMatchObject({
      ok: true,
      from: 'draft',
      audit: { action: 'price_book.status' },
    });
    expect(await to('active')).toEqual({ ok: false, error: 'X is already active.' });
    expect(await to('archived')).toMatchObject({ ok: false });
    expect(await to('inactive')).toMatchObject({ ok: true });
    expect(await to('active')).toMatchObject({ ok: true });
    expect(await to('inactive')).toMatchObject({ ok: true });
    expect(await to('archived')).toMatchObject({ ok: true });
    expect(await to('active')).toEqual({
      ok: false,
      error: "A archived book can't become active.",
    });
    expect(await setPriceBookStatus(p, { bookId: 'nope', status: 'active' }, NOW)).toEqual({
      ok: false,
      error: 'No such price book.',
    });
  });

  it('lets a draft be archived without ever being active', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    expect(await setPriceBookStatus(p, { bookId: 'pb_x', status: 'archived' }, NOW)).toMatchObject({
      ok: true,
    });
  });

  it('refuses a move another change got in ahead of', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    // The status moves between this caller's read and its write.
    const stale = p.books.find.bind(p.books);
    p.books.find = async (id: string) => {
      const b = await stale(id);
      await p.books.transition('pb_x', 'draft', 'archived', NOW);
      return b;
    };
    expect(await setPriceBookStatus(p, { bookId: 'pb_x', status: 'active' }, NOW)).toEqual({
      ok: false,
      error: 'X was changed by someone else just now: read it again.',
    });
  });
});

describe('entries', () => {
  it('puts, replaces, removes, and pages them', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    const put = (entries: Parameters<typeof putPriceBookEntries>[1]['entries']) =>
      putPriceBookEntries(p, { bookId: 'x', entries }, NOW);
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 9 },
        { sku: 'PC-SKU-1', minQty: 10, price: 8 },
        { sku: 'PC-SKU-2', discountPct: 10 },
      ]),
    ).toMatchObject({ ok: true, put: 3, removed: 0, audit: { action: 'price_book.entries' } });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 9.5 },
        { sku: 'PC-SKU-2', minQty: 1, remove: true },
      ]),
    ).toMatchObject({
      ok: true,
      put: 1,
      removed: 1,
    });
    const first = await getPriceBook(p, { bookId: 'x', limit: 1 });
    if (!first.ok) throw new Error(first.error);
    expect(first.entries).toEqual([{ sku: 'PC-SKU-1', minQty: 1, price: 9.5, discountPct: null }]);
    expect(first.entryTotal).toBe(2);
    const second = await getPriceBook(p, { bookId: 'x', limit: 1, after: first.next ?? undefined });
    if (!second.ok) throw new Error(second.error);
    expect(second.entries.map((e) => e.minQty)).toEqual([10]);
    expect(second.next).toBeNull();
    expect(await getPriceBook(p, { bookId: 'x', after: 'garbage' })).toMatchObject({ ok: false });
  });

  it('refuses a bad entry, a repeat, an unknown SKU and an archived book, writing nothing', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    const put = (entries: Parameters<typeof putPriceBookEntries>[1]['entries']) =>
      putPriceBookEntries(p, { bookId: 'x', entries }, NOW);
    expect(await put([{ sku: 'PC-SKU-1', price: 1, discountPct: 5 }])).toMatchObject({ ok: false });
    expect(await put([{ sku: 'PC-SKU-1' }])).toMatchObject({ ok: false });
    expect(await put([{ sku: 'PC-SKU-1', discountPct: 120 }])).toMatchObject({ ok: false });
    expect(await put([{ sku: 'PC-SKU-1', price: -1 }])).toMatchObject({ ok: false });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 1 },
        { sku: 'PC-SKU-1', price: 2 },
      ]),
    ).toEqual({
      ok: false,
      error: 'PC-SKU-1 appears twice at the same quantity.',
    });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 1 },
        { sku: 'NOPE', price: 2 },
      ]),
    ).toEqual({
      ok: false,
      error: 'No such product: NOPE.',
    });
    expect(await getPriceBook(p, { bookId: 'x' })).toMatchObject({ entryTotal: 0 });
    await setPriceBookStatus(p, { bookId: 'x', status: 'archived' }, NOW);
    expect(await put([{ sku: 'PC-SKU-1', price: 1 }])).toEqual({
      ok: false,
      error: "X is archived and can't change.",
    });
  });
});

describe('assignments', () => {
  it('assigns to a customer or a tier once and takes it away', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    const assign = (over: { customerId?: string; tier?: string; remove?: boolean }) =>
      assignPriceBook(p, { bookId: 'x', ...over }, NOW);
    expect(await assign({ customerId: 'pc_northwind' })).toMatchObject({
      ok: true,
      audit: { action: 'price_book.assigned', detail: { customerId: 'pc_northwind' } },
    });
    expect(await assign({ customerId: 'pc_northwind' })).toEqual({
      ok: false,
      error: 'X is already assigned to customer pc_northwind.',
    });
    expect(await assign({ tier: ' gold ' })).toMatchObject({
      ok: true,
      audit: { detail: { tier: 'gold' } },
    });
    expect(await assign({ tier: 'gold', remove: true })).toMatchObject({
      ok: true,
      audit: { action: 'price_book.unassigned' },
    });
    expect(await assign({ tier: 'gold', remove: true })).toEqual({
      ok: false,
      error: "X isn't assigned to the gold tier.",
    });
  });

  it('refuses a company that is not active, but lets its assignment be taken away and its books still price', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    await putPriceBookEntries(p, { bookId: 'x', entries: [{ sku: 'PC-SKU-1', price: 6 }] }, NOW);
    await setPriceBookStatus(p, { bookId: 'x', status: 'active' }, NOW);
    expect(await assignPriceBook(p, { bookId: 'x', customerId: 'pc_twin_a' }, NOW)).toEqual({
      ok: false,
      error: 'Twin A is suspended: a book is assigned only to an active company.',
    });
    // Assigned while it was active (written straight to the store), the books still price after it
    // is suspended: pricing is not access control, `validateOrder` declines the order.
    await p.books.assign('pb_x', { customerId: 'pc_twin_a' }, NOW);
    const order = {
      lines: [{ sku: 'PC-SKU-1', qty: 1 }],
      currency: 'USD',
      customerId: 'pc_twin_a',
      model: 'b2b' as const,
    };
    expect(
      (
        await priceOrder(p, order, {
          basis: 'auto',
          useContracts: true,
          usePriceRules: true,
          now: NOW,
        })
      ).priced[0],
    ).toMatchObject({ unitPrice: 6, bookId: 'pb_x' });
    expect(
      await assignPriceBook(p, { bookId: 'x', customerId: 'pc_twin_a', remove: true }, NOW),
    ).toMatchObject({ ok: true });
  });

  it('refuses both a customer and a tier, neither, an unknown customer and an archived book', async () => {
    const p = ports();
    await createPriceBook(p, { code: 'x', name: 'X' }, 'ann', NOW, 'pb_x');
    const assign = (over: { customerId?: string; tier?: string }) =>
      assignPriceBook(p, { bookId: 'x', ...over }, NOW);
    expect(await assign({ customerId: 'pc_northwind', tier: 'gold' })).toEqual({
      ok: false,
      error: 'Name a customer or a tier, not both.',
    });
    expect(await assign({})).toEqual({ ok: false, error: 'Name a customer or a tier.' });
    expect(await assign({ customerId: 'pc_nobody' })).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    await setPriceBookStatus(p, { bookId: 'x', status: 'archived' }, NOW);
    expect(await assign({ tier: 'gold' })).toEqual({
      ok: false,
      error: "X is archived and can't be assigned.",
    });
  });
});

describe('contract prices', () => {
  it('sets, replaces and removes them, and refuses an unknown customer or SKU', async () => {
    const p = ports();
    const put = (prices: { sku: string; price: number | null }[], customerId = 'pc_twin_b') =>
      putContractPrices(p, { customerId, prices });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 6 },
        { sku: 'PC-SKU-2', price: 20 },
      ]),
    ).toMatchObject({
      ok: true,
      set: 2,
      audit: { action: 'contract_price.saved', target: 'pc_twin_b' },
    });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 5 },
        { sku: 'PC-SKU-2', price: null },
      ]),
    ).toMatchObject({
      ok: true,
      set: 1,
      removed: 1,
    });
    expect(await p.books.contractPrices('pc_twin_b')).toEqual([{ sku: 'PC-SKU-1', price: 5 }]);
    expect(await put([{ sku: 'PC-SKU-1', price: 5 }], 'pc_nobody')).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    expect(await put([{ sku: 'NOPE', price: 5 }])).toEqual({
      ok: false,
      error: 'No such product: NOPE.',
    });
    expect(await put([{ sku: 'PC-SKU-1', price: -1 }])).toMatchObject({ ok: false });
    expect(
      await put([
        { sku: 'PC-SKU-1', price: 1 },
        { sku: 'PC-SKU-1', price: 2 },
      ]),
    ).toEqual({
      ok: false,
      error: 'PC-SKU-1 appears twice.',
    });
  });
});

describe('pricing from books', () => {
  const order = {
    lines: [{ sku: 'PC-SKU-1', qty: 2 }],
    currency: 'USD',
    customerId: 'pc_northwind',
    model: 'b2b' as const,
  };
  const options = { basis: 'auto', useContracts: true, usePriceRules: true, now: NOW } as const;

  it('prices an order from the highest-priority assigned book and names it', async () => {
    const p = ports();
    await liveBook(p, { code: 'low', priority: 1, price: 4 });
    await liveBook(p, { code: 'high', priority: 5, price: 7 });
    const priced = await priceOrder(p, order, options);
    // The gold tier's book-less rule says 8; the high book (7) outranks the cheaper low book (4).
    expect(priced.lines[0]?.unitPrice).toBe(7);
    expect(priced.priced[0]).toEqual({
      sku: 'PC-SKU-1',
      unitPrice: 7,
      by: 'price_book',
      rule: 'Book high',
      bookId: 'pb_high',
    });
  });

  it('leaves a draft, inactive, out-of-date or other customer’s book out', async () => {
    const p = ports();
    const drafted = await createPriceBook(
      p,
      { code: 'draft', name: 'Draft', priority: 9 },
      'a',
      NOW,
      'pb_draft',
    );
    if (!drafted.ok) throw new Error(drafted.error);
    await putPriceBookEntries(
      p,
      { bookId: 'draft', entries: [{ sku: 'PC-SKU-1', price: 1 }] },
      NOW,
    );
    await assignPriceBook(p, { bookId: 'draft', customerId: 'pc_northwind' }, NOW);
    await liveBook(p, { code: 'future', priority: 9, price: 1, startsAt: NOW + DAY });
    await liveBook(p, { code: 'ended', priority: 9, price: 1, endsAt: NOW });
    const off = await liveBook(p, { code: 'off', priority: 9, price: 1 });
    await setPriceBookStatus(p, { bookId: off, status: 'inactive' }, NOW);
    expect((await priceOrder(p, order, options)).priced[0]).toMatchObject({
      unitPrice: 8,
      rule: 'Gold tier',
      bookId: null,
    });
    // Once the future book starts, it prices.
    const later = await priceOrder(p, order, { ...options, now: NOW + DAY });
    expect(later.priced[0]).toMatchObject({ unitPrice: 1, bookId: 'pb_future' });
  });

  it('prices a volume tier in a book from its quantity', async () => {
    const p = ports();
    const id = await liveBook(p, { code: 'tiers', price: 9 });
    await putPriceBookEntries(
      p,
      { bookId: id, entries: [{ sku: 'PC-SKU-1', minQty: 10, price: 6 }] },
      NOW,
    );
    const at = (qty: number) =>
      priceOrder(p, { ...order, lines: [{ sku: 'PC-SKU-1', qty }] }, options).then(
        (r) => r.priced[0]?.unitPrice,
      );
    // A book outranks the book-less gold rule (8) even where that is cheaper.
    expect(await at(2)).toBe(9);
    expect(await at(10)).toBe(6);
  });
});

describe('previewing a price', () => {
  it('says what a customer would pay and from which book', async () => {
    const p = ports();
    await liveBook(p, { code: 'spring', price: 7 });
    const r = await previewPrice(
      p,
      { customerId: 'pc_northwind', lines: [{ sku: 'PC-SKU-1', qty: 3 }, { sku: 'PC-SKU-2' }] },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      customerId: 'pc_northwind',
      tier: 'gold',
      currency: 'USD',
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.lines).toEqual([
      {
        sku: 'PC-SKU-1',
        qty: 3,
        listPrice: 10,
        unitPrice: 7,
        source: 'price_book',
        name: 'Book spring',
        bookId: 'pb_spring',
      },
      {
        sku: 'PC-SKU-2',
        qty: 1,
        listPrice: 25,
        unitPrice: 20,
        source: 'contract',
        name: 'Contract price',
        bookId: null,
      },
    ]);
  });

  it('prices an anonymous buyer at list, and refuses an unknown customer or SKU', async () => {
    const p = ports();
    await liveBook(p, { code: 'spring', price: 7 });
    const anon = await previewPrice(p, { lines: [{ sku: 'PC-SKU-1' }] }, NOW);
    expect(anon).toMatchObject({
      ok: true,
      customerId: null,
      lines: [{ unitPrice: 10, source: 'list', bookId: null }],
    });
    expect(
      await previewPrice(p, { customerId: 'pc_nobody', lines: [{ sku: 'PC-SKU-1' }] }, NOW),
    ).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    expect(await previewPrice(p, { lines: [{ sku: 'NOPE' }] }, NOW)).toEqual({
      ok: false,
      error: 'No such product: NOPE.',
    });
  });
});

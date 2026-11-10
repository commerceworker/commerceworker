/**
 * The behaviour every `PriceBookStore` keeps, as one suite, with the pricing port reading what it
 * writes: the in-memory store runs it in node (test-kit's own tests) and the D1 store in workerd
 * (packages/db). `make` returns a fresh pair over the same data, seeded with `PRICING_FIXTURE`'s
 * customers (`pc_northwind` is gold, `pc_twin_a` standard) and products. Ids and codes are
 * distinctive so a backend holding other rows can't satisfy an assertion by accident.
 */
import {
  bookEntryId,
  type PriceBook,
  type PriceBookEntry,
  type PriceBookStatus,
} from '@commerceworker/core';
import type { PriceBookStore, PricingStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const AT = 2_000_000;
const ALL = { all: true } as const;

let n = 0;
const book = (over: Partial<PriceBook> = {}): PriceBook => {
  n += 1;
  return {
    id: `pcb_book_${n}`,
    code: `pcb-code-${String(n).padStart(3, '0')}`,
    name: `Contract book ${n}`,
    priority: 0,
    status: 'draft',
    startsAt: null,
    endsAt: null,
    createdBy: 'usr_ada',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
};

const entry = (sku: string, minQty: number, price: number): PriceBookEntry => ({
  sku,
  minQty,
  price,
  discountPct: null,
});

export function describePriceBookStoreContract(
  name: string,
  make: () => Promise<{ books: PriceBookStore; pricing: PricingStore }>,
) {
  describe(`${name}: the price book store contract`, () => {
    /** A book made, and moved to `status` the way a person would. */
    const made = async (s: PriceBookStore, over: Partial<PriceBook> = {}) => {
      const b = book({ ...over, status: 'draft' });
      expect(await s.create(b)).toBe(true);
      if (over.status && over.status !== 'draft') {
        const path: Record<string, PriceBookStatus[]> = {
          active: ['active'],
          inactive: ['active', 'inactive'],
          archived: ['archived'],
        };
        let from: PriceBookStatus = 'draft';
        for (const to of path[over.status] ?? []) {
          expect(await s.transition(b.id, from, to, 1_500)).toBe(true);
          from = to;
        }
      }
      return { ...b, status: over.status ?? 'draft' } as PriceBook;
    };
    const rulesOf = async (pricing: PricingStore, customerId: string, skus?: string[]) =>
      (await pricing.pricingFor(customerId, AT, skus)).rules.filter((r) => r.bookId);

    it('adds a book once per id and per code, and finds it by either', async () => {
      const { books } = await make();
      const b = book();
      expect(await books.create(b)).toBe(true);
      expect(await books.create({ ...b, code: 'pcb-other' })).toBe(false);
      expect(await books.create({ ...b, id: 'pcb_other' })).toBe(false);
      expect(await books.find(b.id)).toEqual(b);
      expect(await books.find(b.code)).toEqual(b);
      expect(await books.find('pcb-nothing')).toBeUndefined();
    });

    it('lists books by code in keyset pages, with a total and a status filter', async () => {
      const { books } = await make();
      const mine = [] as PriceBook[];
      for (let i = 0; i < 5; i++)
        mine.push(await made(books, { code: `pcl-${i}`, status: i < 2 ? 'active' : 'draft' }));
      const page = await books.list({ after: 'pcl-', limit: 2 });
      expect(page.rows.map((b) => b.code)).toEqual(['pcl-0', 'pcl-1']);
      expect(page.next).toBe('pcl-1');
      const second = await books.list({ after: page.next, limit: 2 });
      expect(second.rows.map((b) => b.code)).toEqual(['pcl-2', 'pcl-3']);
      const last = await books.list({ after: second.next, limit: 2 });
      expect(last.rows.map((b) => b.code)).toEqual(['pcl-4']);
      expect(last.next).toBeNull();
      expect(page.total).toBeGreaterThanOrEqual(5);
      const active = await books.list({ status: 'active', after: 'pcl-', limit: 10 });
      expect(active.rows.map((b) => b.code).filter((c) => c.startsWith('pcl-'))).toEqual([
        'pcl-0',
        'pcl-1',
      ]);
    });

    it('moves a book by compare-and-set: only from the status it was read in', async () => {
      const { books } = await make();
      const b = await made(books);
      expect(await books.transition(b.id, 'active', 'inactive', 2_000)).toBe(false);
      expect(await books.transition(b.id, 'draft', 'active', 2_000)).toBe(true);
      expect(await books.find(b.id)).toMatchObject({ status: 'active', updatedAt: 2_000 });
      // Again from the old status: it has moved, so this one loses.
      expect(await books.transition(b.id, 'draft', 'active', 3_000)).toBe(false);
      expect(await books.find(b.id)).toMatchObject({ updatedAt: 2_000 });
      expect(await books.transition('pcb_missing', 'draft', 'active', 3_000)).toBe(false);
    });

    it('lets exactly one of two racing moves win', async () => {
      const { books } = await make();
      const b = await made(books, { status: 'inactive' });
      const results = await Promise.all([
        books.transition(b.id, 'inactive', 'active', 3_000),
        books.transition(b.id, 'inactive', 'archived', 3_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const now = await books.find(b.id);
      expect(now?.status).toBe(results[0] ? 'active' : 'archived');
    });

    it('writes, replaces, pages and removes entries, more than one statement can bind', async () => {
      const { books } = await make();
      const b = await made(books);
      // 35 SKUs at two quantities: 70 rows, past D1's 100 bound parameters at nine to a row.
      const all: PriceBookEntry[] = [];
      for (let i = 0; i < 35; i++) {
        const sku = `PCB-SKU-${String(i).padStart(2, '0')}`;
        all.push(entry(sku, 1, 10 + i), entry(sku, 10, 8 + i));
      }
      await books.putEntries(b.id, all, 2_000);
      expect((await books.entries(b.id, { after: null, limit: 1 })).total).toBe(70);
      // Writing one again replaces its price and adds no row.
      await books.putEntries(b.id, [entry('PCB-SKU-00', 10, 1.5)], 2_500);
      expect((await books.entries(b.id, { after: null, limit: 1 })).total).toBe(70);

      const seen: PriceBookEntry[] = [];
      let after = null as { sku: string; minQty: number } | null;
      for (let pages = 0; pages < 10; pages++) {
        const page = await books.entries(b.id, { after, limit: 30 });
        seen.push(...page.rows);
        if (!page.next) break;
        after = page.next;
      }
      expect(seen).toHaveLength(70);
      expect(seen.slice(0, 3)).toEqual([
        entry('PCB-SKU-00', 1, 10),
        entry('PCB-SKU-00', 10, 1.5),
        entry('PCB-SKU-01', 1, 11),
      ]);

      await books.putEntries(
        b.id,
        [{ sku: 'PCB-SKU-02', minQty: 1, price: null, discountPct: 15 }],
        3_000,
      );
      expect((await books.entries(b.id, { after: null, limit: 100 })).rows).toContainEqual({
        sku: 'PCB-SKU-02',
        minQty: 1,
        price: null,
        discountPct: 15,
      });
      await books.removeEntries(b.id, [
        { sku: 'PCB-SKU-00', minQty: 1 },
        { sku: 'PCB-SKU-00', minQty: 10 },
        { sku: 'PCB-NONE', minQty: 1 },
      ]);
      expect((await books.entries(b.id, { after: null, limit: 1 })).total).toBe(68);
      // Entries are the book's own.
      const other = await made(books);
      expect((await books.entries(other.id, { after: null, limit: 10 })).rows).toEqual([]);
    });

    it('assigns a book to a customer or a tier once, and takes it away', async () => {
      const { books } = await make();
      const b = await made(books);
      expect(await books.assign(b.id, { customerId: 'pc_northwind' }, 2_000)).toBe(true);
      expect(await books.assign(b.id, { customerId: 'pc_northwind' }, 2_100)).toBe(false);
      expect(await books.assign(b.id, { tier: 'gold' }, 2_000)).toBe(true);
      expect(await books.assign(b.id, { tier: 'gold' }, 2_100)).toBe(false);
      expect(await books.assignments(b.id)).toEqual([
        { bookId: b.id, customerId: 'pc_northwind', tier: null, createdAt: 2_000 },
        { bookId: b.id, customerId: null, tier: 'gold', createdAt: 2_000 },
      ]);
      expect(await books.unassign(b.id, { tier: 'gold' })).toBe(true);
      expect(await books.unassign(b.id, { tier: 'gold' })).toBe(false);
      expect((await books.assignments(b.id)).map((a) => a.customerId)).toEqual(['pc_northwind']);
    });

    it("finds the books assigned to a customer: by id or by their tier, by priority, not others'", async () => {
      const { books } = await make();
      const low = await made(books, { priority: 1 });
      const high = await made(books, { priority: 9 });
      const tiered = await made(books, { priority: 5 });
      const other = await made(books, { priority: 7 });
      await books.assign(low.id, { customerId: 'pc_northwind' }, 2_000);
      await books.assign(high.id, { customerId: 'pc_northwind' }, 2_000);
      await books.assign(high.id, { tier: 'gold' }, 2_000);
      await books.assign(tiered.id, { tier: 'gold' }, 2_000);
      await books.assign(other.id, { customerId: 'pc_twin_a' }, 2_000);
      await books.assign(other.id, { tier: 'silver' }, 2_000);
      const mine = await books.forCustomer(ALL, 'pc_northwind', 'gold');
      // High is assigned twice and listed once.
      expect(mine.map((b) => b.id)).toEqual([high.id, tiered.id, low.id]);
      expect((await books.forCustomer(ALL, 'pc_northwind', null)).map((b) => b.id)).toEqual([
        high.id,
        low.id,
      ]);
      expect(await books.forCustomer(ALL, 'pc_nobody', null)).toEqual([]);
      // A company sees its own assignments, and none for another company.
      expect(
        (await books.forCustomer({ companyId: 'pc_northwind' }, 'pc_northwind', 'gold')).map(
          (b) => b.id,
        ),
      ).toEqual([high.id, tiered.id, low.id]);
      expect(await books.forCustomer({ companyId: 'pc_twin_a' }, 'pc_northwind', 'gold')).toEqual(
        [],
      );
    });

    it('prices from the assigned books that are active and in their dates, and no others', async () => {
      const { books, pricing } = await make();
      const live = await made(books, { status: 'active', priority: 3, name: 'Live book' });
      const draft = await made(books);
      const inactive = await made(books, { status: 'inactive' });
      const archived = await made(books, { status: 'archived' });
      const future = await made(books, { status: 'active', startsAt: AT + 1 });
      const ended = await made(books, { status: 'active', endsAt: AT });
      const started = await made(books, { status: 'active', startsAt: AT, endsAt: AT + 1_000 });
      const unassigned = await made(books, { status: 'active' });
      const others = await made(books, { status: 'active' });
      for (const b of [live, draft, inactive, archived, future, ended, started, unassigned, others])
        await books.putEntries(b.id, [entry('PC-SKU-1', 1, 7)], 2_000);
      for (const b of [live, draft, inactive, archived, future, ended, started])
        await books.assign(b.id, { customerId: 'pc_northwind' }, 2_000);
      await books.assign(others.id, { customerId: 'pc_twin_a' }, 2_000);

      const rules = await rulesOf(pricing, 'pc_northwind');
      // Starts exactly now: in force. Ends exactly now: out. Draft, inactive, archived: out.
      expect(rules.map((r) => r.bookId).sort()).toEqual([live.id, started.id].sort());
      expect(rules.find((r) => r.bookId === live.id)).toMatchObject({
        id: bookEntryId(live.id, 'PC-SKU-1', 1),
        source: 'price_book',
        name: 'Live book',
        bookPriority: 3,
        sku: 'PC-SKU-1',
        minQty: 1,
        price: 7,
      });
      expect((await rulesOf(pricing, 'pc_twin_a')).map((r) => r.bookId)).toEqual([others.id]);
      expect(await rulesOf(pricing, 'pc_nobody')).toEqual([]);
      expect((await pricing.pricingFor(undefined, AT)).rules.some((r) => r.bookId)).toBe(false);
      // A book the clock hasn't reached prices nothing yet, and once it ends, nothing again.
      expect((await rulesOf(pricing, 'pc_northwind')).map((r) => r.bookId)).not.toContain(
        future.id,
      );
      const later = await pricing.pricingFor('pc_northwind', AT + 1);
      expect(later.rules.filter((r) => r.bookId).map((r) => r.bookId)).toContain(future.id);
      const afterEnd = await pricing.pricingFor('pc_northwind', AT + 1_000);
      expect(afterEnd.rules.filter((r) => r.bookId).map((r) => r.bookId)).not.toContain(started.id);
    });

    it("prices a customer from their tier's book, and keeps the rules in no book", async () => {
      const { books, pricing } = await make();
      const b = await made(books, { status: 'active' });
      await books.putEntries(b.id, [entry('PC-SKU-2', 1, 19)], 2_000);
      await books.assign(b.id, { tier: 'gold' }, 2_000);
      expect((await rulesOf(pricing, 'pc_northwind')).map((r) => r.bookId)).toEqual([b.id]);
      // pc_twin_a is standard tier.
      expect(await rulesOf(pricing, 'pc_twin_a')).toEqual([]);
      const chain = await pricing.pricingFor('pc_northwind', AT);
      expect(chain.rules.some((r) => r.id === 'pc_rule_gold' && !r.bookId)).toBe(true);
    });

    it('reads only the SKUs asked for, with the same answer from priceInputs, in runs over D1 limits', async () => {
      const { books, pricing } = await make();
      const b = await made(books, { status: 'active' });
      const skus = Array.from({ length: 130 }, (_, i) => `PCB-RUN-${String(i).padStart(3, '0')}`);
      await books.putEntries(
        b.id,
        skus.map((sku) => entry(sku, 1, 5)),
        2_000,
      );
      await books.assign(b.id, { customerId: 'pc_northwind' }, 2_000);
      const some = await rulesOf(pricing, 'pc_northwind', ['PCB-RUN-003', 'PCB-RUN-120']);
      expect(some.map((r) => r.sku).sort()).toEqual(['PCB-RUN-003', 'PCB-RUN-120']);
      const all = await rulesOf(pricing, 'pc_northwind', skus);
      expect(all).toHaveLength(130);
      const together = await pricing.priceInputs(skus, 'USD', 'pc_northwind', true, AT);
      expect(together.chain?.rules.filter((r) => r.bookId)).toHaveLength(130);
      expect(together.chain?.rules.filter((r) => !r.bookId && r.source === 'price_book')).toEqual(
        (await pricing.pricingFor('pc_northwind', AT, skus)).rules.filter(
          (r) => !r.bookId && r.source === 'price_book',
        ),
      );
    });

    it('sets, replaces and removes contract prices, more than one statement can bind', async () => {
      const { books, pricing } = await make();
      // pc_twin_b has none to begin with.
      expect(await books.contractPrices('pc_twin_b')).toEqual([]);
      const many = Array.from({ length: 75 }, (_, i) => ({
        sku: `PCB-CON-${String(i).padStart(2, '0')}`,
        price: i + 1,
      }));
      await books.putContractPrices('pc_twin_b', many);
      expect(await books.contractPrices('pc_twin_b')).toEqual(many);
      await books.putContractPrices('pc_twin_b', [{ sku: 'PCB-CON-00', price: 0.5 }]);
      expect((await books.contractPrices('pc_twin_b'))[0]).toEqual({
        sku: 'PCB-CON-00',
        price: 0.5,
      });
      // Pricing reads them as the contract source's entries.
      const rules = (await pricing.pricingFor('pc_twin_b', AT)).rules.filter(
        (r) => r.source === 'contract',
      );
      expect(rules).toHaveLength(75);
      expect(rules.find((r) => r.sku === 'PCB-CON-00')).toMatchObject({
        customerId: 'pc_twin_b',
        price: 0.5,
      });
      await books.removeContractPrices(
        'pc_twin_b',
        many.map((m) => m.sku),
      );
      expect(await books.contractPrices('pc_twin_b')).toEqual([]);
      // Another customer's contract prices are untouched.
      expect((await books.contractPrices('pc_northwind')).map((c) => c.sku)).toContain('PC-SKU-2');
    });
  });
}

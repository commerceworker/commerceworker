/**
 * The behaviour every `QuoteStore` keeps, as one suite, with the pricing port reading what it
 * writes: the in-memory store runs it in node and the D1 store in workerd (packages/db). `make`
 * returns a fresh pair over the same data, seeded with `PRICING_FIXTURE` (`pc_northwind` has a
 * contract price of 20 for `PC-SKU-2`). Ids start `qtct_`; the D1 run deletes those rows before
 * each case.
 */
import { type Quote, type QuoteLine, resolvePrice } from '@commerceworker/core';
import type { PricingStore, QuoteStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const ALL = { all: true } as const;
const A = 'qtct_co_a';
const B = 'qtct_co_b';
/** A company the pricing fixture knows, so the chain has its contract price to rank against. */
const PRICED = 'pc_northwind';

const quote = (id: string, over: Partial<Quote> = {}): Quote => ({
  id,
  rootId: id,
  version: 1,
  companyId: A,
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
  createdBy: 'usr_ada',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

const line = (sku: string, over: Partial<QuoteLine> = {}): QuoteLine => ({
  sku,
  name: null,
  qty: 10,
  listPrice: null,
  unitPrice: 9,
  ...over,
});

const LINES = [
  line('qtct-w1'),
  line('qtct-w2', { name: 'Widget', qty: 40, listPrice: 12, unitPrice: 8.5 }),
];

export function describeQuoteStoreContract(
  name: string,
  make: () => Promise<{ quotes: QuoteStore; pricing: PricingStore }>,
) {
  describe(`${name}: the quote store contract`, () => {
    const seed = async (s: QuoteStore, q: Quote, lines: QuoteLine[] = LINES) =>
      expect(await s.create(q, lines)).toEqual({ ok: true });

    /** A quote made and moved along the lifecycle the way staff would. */
    const accepted = async (s: QuoteStore, id: string, over: Partial<Quote> = {}) => {
      await seed(s, quote(id, over), over.companyId === PRICED ? PRICE_LINES : LINES);
      expect(await s.transition(ALL, id, 'draft', 'sent', 1_100)).toBe(true);
      expect(await s.transition(ALL, id, 'sent', 'accepted', 1_200)).toBe(true);
    };
    const PRICE_LINES = [
      line('PC-SKU-2', { qty: 50, unitPrice: 30 }),
      line('PC-SKU-1', { qty: 5, unitPrice: 4 }),
    ];

    it('keeps a quote with its lines in the order written', async () => {
      const { quotes: s } = await make();
      const q = quote('qtct_1', { buyerId: 'qtct_m1', notes: 'Net 30', expiresAt: 9_000 });
      await seed(s, q);
      expect(await s.get(ALL, 'qtct_1')).toEqual({ ...q, lines: LINES });
      expect(await s.get(ALL, 'qtct_none')).toBeUndefined();
    });

    it('keeps an id once and a version once per negotiation', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_1'));
      expect(await s.create(quote('qtct_1', { rootId: 'qtct_x' }), LINES)).toEqual({
        ok: false,
        conflict: 'id',
      });
      expect(await s.create(quote('qtct_2', { rootId: 'qtct_1' }), LINES)).toEqual({
        ok: false,
        conflict: 'version',
      });
      // Nothing of the refused quote was kept.
      expect(await s.get(ALL, 'qtct_2')).toBeUndefined();
      await seed(s, quote('qtct_2', { rootId: 'qtct_1', version: 2 }));
    });

    it('pages newest first with a total, and leaves superseded versions out unless asked', async () => {
      const { quotes: s } = await make();
      for (const [i, id] of ['qtct_p1', 'qtct_p2', 'qtct_p3', 'qtct_p4'].entries())
        await seed(s, quote(id, { createdAt: 2_000 + (i < 2 ? 0 : i), name: `Spring ${id}` }));
      await seed(s, quote('qtct_p5', { companyId: B, createdAt: 2_500, name: 'Other' }));
      await seed(s, quote('qtct_p6', { status: 'superseded', createdAt: 2_600 }));
      const first = await s.list(ALL, { companyId: A }, { limit: 2 });
      expect(first.rows.map((r) => r.id)).toEqual(['qtct_p4', 'qtct_p3']);
      expect(first.total).toBe(4);
      expect(first.rows[0]).toMatchObject({ lineCount: 2, total: 8.5 * 40 + 9 * 10 });
      const second = await s.list(ALL, { companyId: A }, { limit: 2, after: first.next! });
      expect(second.rows.map((r) => r.id)).toEqual(['qtct_p2', 'qtct_p1']);
      expect(second.next).toBeNull();
      // A tie on the creation time breaks by id, and the cursor carries both.
      expect((await s.list(ALL, { search: 'SPRING QTCT_P' }, { limit: 1 })).next).not.toBeNull();
      expect(
        (await s.list(ALL, { status: 'superseded', companyId: A }, { limit: 5 })).rows,
      ).toHaveLength(1);
      expect((await s.list(ALL, { companyId: A, search: 'spring' }, { limit: 9 })).total).toBe(4);
    });

    it('lists one negotiation’s versions, superseded ones included', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_v1', { status: 'sent', expiresAt: 9_000 }));
      expect(
        await s.revise(
          ALL,
          'qtct_v1',
          'sent',
          quote('qtct_v2', { rootId: 'qtct_v1', version: 2 }),
          LINES,
          1_500,
        ),
      ).toEqual({ ok: true });
      expect(
        (await s.list(ALL, { rootId: 'qtct_v1' }, { limit: 9 })).rows.map((r) => r.status).sort(),
      ).toEqual(['draft', 'superseded']);
      expect(await s.versions(ALL, 'qtct_v1')).toEqual([
        { id: 'qtct_v1', version: 1, status: 'superseded' },
        { id: 'qtct_v2', version: 2, status: 'draft' },
      ]);
      // Without naming the negotiation, the list shows where it stands.
      expect((await s.list(ALL, { companyId: A }, { limit: 9 })).rows.map((r) => r.id)).toEqual([
        'qtct_v2',
      ]);
    });

    it('holds every read to its scope', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_a1'));
      await seed(s, quote('qtct_b1', { companyId: B }));
      const mine = { companyId: A } as const;
      expect(await s.get(mine, 'qtct_a1')).toBeDefined();
      expect(await s.get(mine, 'qtct_b1')).toBeUndefined();
      expect((await s.list(mine, {}, { limit: 9 })).rows.map((r) => r.id)).toEqual(['qtct_a1']);
      // Naming another company doesn't widen the scope.
      expect(await s.list(mine, { companyId: B }, { limit: 9 })).toEqual({
        rows: [],
        total: 0,
        next: null,
      });
      expect(await s.versions(mine, 'qtct_b1')).toEqual([]);
      // Nor can a company's scope write to another's.
      expect(await s.transition(mine, 'qtct_b1', 'draft', 'sent', 2_000)).toBe(false);
      expect(await s.updateDraft(mine, 'qtct_b1', { name: 'x' }, 2_000)).toEqual({
        ok: false,
        conflict: 'missing',
      });
      expect((await s.get(ALL, 'qtct_b1'))?.status).toBe('draft');
    });

    it('edits a draft’s header and lines together, and nothing once it is sent', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_e1'));
      const lines = [line('qtct-w9', { qty: 3, unitPrice: 1 })];
      expect(
        await s.updateDraft(
          ALL,
          'qtct_e1',
          { name: 'Renamed', expiresAt: 7_000, notes: null, lines },
          1_500,
        ),
      ).toEqual({ ok: true });
      expect(await s.get(ALL, 'qtct_e1')).toEqual({
        ...quote('qtct_e1', { name: 'Renamed', expiresAt: 7_000, updatedAt: 1_500 }),
        lines,
      });
      // Leaving a field out leaves it; null clears it.
      expect(await s.updateDraft(ALL, 'qtct_e1', { buyerId: 'qtct_m1' }, 1_600)).toEqual({
        ok: true,
      });
      expect(await s.get(ALL, 'qtct_e1')).toMatchObject({
        name: 'Renamed',
        expiresAt: 7_000,
        buyerId: 'qtct_m1',
        lines,
      });
      expect(await s.transition(ALL, 'qtct_e1', 'draft', 'sent', 1_700)).toBe(true);
      expect(await s.updateDraft(ALL, 'qtct_e1', { name: 'Late', lines: LINES }, 1_800)).toEqual({
        ok: false,
        conflict: 'missing',
      });
      expect(await s.get(ALL, 'qtct_e1')).toMatchObject({ name: 'Renamed', lines });
      expect(await s.updateDraft(ALL, 'qtct_none', { name: 'x' }, 1_900)).toEqual({
        ok: false,
        conflict: 'missing',
      });
    });

    it('writes more lines than one statement can bind', async () => {
      const { quotes: s } = await make();
      const many = Array.from({ length: 60 }, (_, i) => line(`qtct-m${i}`, { qty: i + 1 }));
      await seed(s, quote('qtct_m1'), many);
      expect((await s.get(ALL, 'qtct_m1'))?.lines).toEqual(many);
      const fewer = many.slice(5, 45);
      expect(await s.updateDraft(ALL, 'qtct_m1', { lines: fewer }, 2_000)).toEqual({ ok: true });
      expect((await s.get(ALL, 'qtct_m1'))?.lines).toEqual(fewer);
    });

    it('moves a status by compare-and-set and stamps when it was sent or decided', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_t1'));
      expect(await s.transition(ALL, 'qtct_t1', 'sent', 'accepted', 2_000)).toBe(false);
      expect(await s.transition(ALL, 'qtct_t1', 'draft', 'sent', 2_100)).toBe(true);
      expect(await s.get(ALL, 'qtct_t1')).toMatchObject({
        status: 'sent',
        sentAt: 2_100,
        decidedAt: null,
        updatedAt: 2_100,
      });
      expect(await s.transition(ALL, 'qtct_t1', 'draft', 'sent', 2_200)).toBe(false);
      expect(await s.transition(ALL, 'qtct_t1', 'sent', 'accepted', 2_300)).toBe(true);
      expect(await s.get(ALL, 'qtct_t1')).toMatchObject({
        status: 'accepted',
        sentAt: 2_100,
        decidedAt: 2_300,
      });
      expect(await s.transition(ALL, 'qtct_none', 'draft', 'sent', 2_400)).toBe(false);
    });

    it('lets one of an accept and a decline racing from sent win', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_r1', { status: 'sent', expiresAt: 9_000 }));
      const results = await Promise.all([
        s.transition(ALL, 'qtct_r1', 'sent', 'accepted', 3_000),
        s.transition(ALL, 'qtct_r1', 'sent', 'declined', 3_000),
        s.transition(ALL, 'qtct_r1', 'sent', 'accepted', 3_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('revises into the next version, superseding the old one, and makes one of two racing revisions', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_s1', { status: 'declined', expiresAt: 9_000 }));
      const next = (id: string) => quote(id, { rootId: 'qtct_s1', version: 2, createdAt: 4_000 });
      // The status it was read in is checked: nothing is written when it moved.
      expect(await s.revise(ALL, 'qtct_s1', 'sent', next('qtct_s2'), LINES, 4_000)).toEqual({
        ok: false,
        conflict: 'status',
      });
      expect(await s.get(ALL, 'qtct_s2')).toBeUndefined();
      const [one, two] = await Promise.all([
        s.revise(ALL, 'qtct_s1', 'declined', next('qtct_s2'), LINES, 4_000),
        s.revise(ALL, 'qtct_s1', 'declined', next('qtct_s3'), LINES, 4_000),
      ]);
      expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
      const winner = one.ok ? 'qtct_s2' : 'qtct_s3';
      const loser = one.ok ? 'qtct_s3' : 'qtct_s2';
      expect(await s.get(ALL, 'qtct_s1')).toMatchObject({ status: 'superseded', updatedAt: 4_000 });
      expect(await s.get(ALL, winner)).toMatchObject({ version: 2, status: 'draft', lines: LINES });
      expect(await s.get(ALL, loser)).toBeUndefined();
      // Superseded is final, so nothing revises it again.
      expect(
        await s.revise(
          ALL,
          'qtct_s1',
          'declined',
          quote('qtct_s4', { rootId: 'qtct_s1', version: 3 }),
          LINES,
          4_100,
        ),
      ).toEqual({ ok: false, conflict: 'status' });
    });

    it('refuses a revision whose id is taken or whose version exists, writing nothing', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_x1', { status: 'sent', expiresAt: 9_000 }));
      await seed(s, quote('qtct_x2', { rootId: 'qtct_x1', version: 2 }));
      await seed(s, quote('qtct_x9'));
      expect(
        await s.revise(
          ALL,
          'qtct_x1',
          'sent',
          quote('qtct_x9', { rootId: 'qtct_x1', version: 3 }),
          LINES,
          4_000,
        ),
      ).toEqual({ ok: false, conflict: 'id' });
      expect(
        await s.revise(
          ALL,
          'qtct_x1',
          'sent',
          quote('qtct_x3', { rootId: 'qtct_x1', version: 2 }),
          LINES,
          4_000,
        ),
      ).toEqual({ ok: false, conflict: 'version' });
      expect((await s.get(ALL, 'qtct_x1'))?.status).toBe('sent');
      expect(await s.get(ALL, 'qtct_x3')).toBeUndefined();
      // Another company's scope can't revise it.
      expect(
        await s.revise(
          { companyId: B },
          'qtct_x1',
          'sent',
          quote('qtct_x4', { rootId: 'qtct_x1', version: 3 }),
          LINES,
          4_000,
        ),
      ).toEqual({ ok: false, conflict: 'status' });
      expect(await s.get(ALL, 'qtct_x4')).toBeUndefined();
    });

    it('records a conversion once, only on an accepted quote', async () => {
      const { quotes: s } = await make();
      await seed(s, quote('qtct_c1', { status: 'sent', expiresAt: 9_000 }));
      expect(await s.markConverted(ALL, 'qtct_c1', 'po', 'po_1', 5_000)).toBe(false);
      await accepted(s, 'qtct_c2', { expiresAt: 9_000 });
      expect(await s.markConverted({ companyId: B }, 'qtct_c2', 'po', 'po_1', 5_000)).toBe(false);
      expect(await s.markConverted(ALL, 'qtct_c2', 'po', 'po_1', 5_000)).toBe('new');
      expect(await s.get(ALL, 'qtct_c2')).toMatchObject({
        status: 'accepted',
        convertedTo: 'po',
        convertedId: 'po_1',
        convertedAt: 5_000,
      });
      // The same conversion again is a repeat; another is refused, and the first stands.
      expect(await s.markConverted(ALL, 'qtct_c2', 'po', 'po_1', 5_100)).toBe('same');
      expect(await s.markConverted(ALL, 'qtct_c2', 'order', 'ord_1', 5_200)).toBe(false);
      expect(await s.get(ALL, 'qtct_c2')).toMatchObject({
        convertedTo: 'po',
        convertedId: 'po_1',
        convertedAt: 5_000,
      });
    });

    it('settles a claim into what it made once, from the claim only', async () => {
      const { quotes: s } = await make();
      await accepted(s, 'qtct_c4', { expiresAt: 9_000 });
      expect(await s.settleConversion(ALL, 'qtct_c4', 'quote:qtct_c4', 'ord_9', 5_000)).toBe(false);
      expect(await s.markConverted(ALL, 'qtct_c4', 'order', 'quote:qtct_c4', 5_000)).toBe('new');
      expect(
        await s.settleConversion({ companyId: B }, 'qtct_c4', 'quote:qtct_c4', 'ord_9', 5_100),
      ).toBe(false);
      expect(await s.settleConversion(ALL, 'qtct_c4', 'quote:qtct_c4', 'ord_9', 5_100)).toBe(true);
      expect(await s.get(ALL, 'qtct_c4')).toMatchObject({
        convertedTo: 'order',
        convertedId: 'ord_9',
        convertedAt: 5_000,
      });
      // The same again is a repeat; another result is refused; ending the quote doesn't undo it.
      expect(await s.settleConversion(ALL, 'qtct_c4', 'quote:qtct_c4', 'ord_9', 5_200)).toBe(true);
      expect(await s.settleConversion(ALL, 'qtct_c4', 'quote:qtct_c4', 'ord_10', 5_200)).toBe(
        false,
      );
      expect(await s.transition(ALL, 'qtct_c4', 'accepted', 'expired', 5_300)).toBe(true);
      expect((await s.get(ALL, 'qtct_c4'))?.convertedId).toBe('ord_9');
    });

    it('lets one of two conversions to different results racing win', async () => {
      const { quotes: s } = await make();
      await accepted(s, 'qtct_c3', { expiresAt: 9_000 });
      const results = await Promise.all([
        s.markConverted(ALL, 'qtct_c3', 'po', 'po_a', 5_000),
        s.markConverted(ALL, 'qtct_c3', 'order', 'ord_b', 5_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    describe('the quote price source', () => {
      const AT = 2_000_000;
      const rulesOf = async (pricing: PricingStore, company = PRICED, at = AT, skus?: string[]) =>
        (await pricing.pricingFor(company, at, skus)).rules.filter((r) => r.source === 'quote');

      it('prices from a company’s accepted, unexpired quote only', async () => {
        const { quotes: s, pricing } = await make();
        const live = { companyId: PRICED, expiresAt: AT + 1_000, name: 'Spring deal' };
        await accepted(s, 'qtct_q1', live);
        const [rule2, rule1] = await rulesOf(pricing);
        expect(rule2).toMatchObject({
          id: 'quote_qtct_q1_0',
          source: 'quote',
          name: 'Quote Spring deal',
          sku: 'PC-SKU-2',
          customerId: PRICED,
          maxQty: 50,
          price: 30,
          endsAt: AT + 1_000,
        });
        expect(rule1).toMatchObject({
          id: 'quote_qtct_q1_1',
          sku: 'PC-SKU-1',
          maxQty: 5,
          price: 4,
        });
        expect((await rulesOf(pricing, PRICED, AT, ['PC-SKU-1'])).map((r) => r.sku)).toEqual([
          'PC-SKU-1',
        ]);
        // At its expiry it no longer counts.
        expect(await rulesOf(pricing, PRICED, AT + 1_000)).toEqual([]);
        // Nor does one that isn't accepted, or another company's.
        await seed(
          s,
          quote('qtct_q2', { companyId: PRICED, status: 'sent', expiresAt: AT + 1_000 }),
          PRICE_LINES,
        );
        await accepted(s, 'qtct_q3', { companyId: A, expiresAt: AT + 1_000 });
        expect((await rulesOf(pricing)).map((r) => r.id)).toEqual([
          'quote_qtct_q1_0',
          'quote_qtct_q1_1',
        ]);
        expect(await rulesOf(pricing, A)).toHaveLength(2);
        // A buyer with no customer has no company, so no quote applies.
        expect(
          (await pricing.pricingFor(undefined, AT)).rules.filter((r) => r.source === 'quote'),
        ).toEqual([]);
      });

      it('stops pricing when the quote is ended, superseded or never accepted', async () => {
        const { quotes: s, pricing } = await make();
        await accepted(s, 'qtct_q4', { companyId: PRICED, expiresAt: AT + 1_000 });
        expect(await rulesOf(pricing)).toHaveLength(2);
        expect(await s.transition(ALL, 'qtct_q4', 'accepted', 'expired', AT)).toBe(true);
        expect(await rulesOf(pricing)).toEqual([]);
      });

      it('ranks first in the chain and caps the quantity it covers', async () => {
        const { quotes: s, pricing } = await make();
        await accepted(s, 'qtct_q5', { companyId: PRICED, expiresAt: AT + 1_000 });
        const { sources, rules, tier } = await pricing.pricingFor(PRICED, AT, ['PC-SKU-2']);
        const chain = [
          { id: 'quote' as const, label: 'Quotes', priority: 0, stopProcessing: true },
          ...sources,
        ];
        const price = (qty: number) =>
          resolvePrice({ sku: 'PC-SKU-2', qty }, 25, chain, rules, {
            customerId: PRICED,
            customerTier: tier,
            now: AT,
          });
        // The negotiated 30 beats the contract's 20, up to the quoted 50; past it the contract is back.
        expect(price(50)).toMatchObject({
          unitPrice: 30,
          by: { source: 'quote', ruleId: 'quote_qtct_q5_0' },
        });
        expect(price(51)).toMatchObject({ unitPrice: 20, by: { source: 'contract' } });
        // The same through the one read pricing an order makes.
        const read = await pricing.priceInputs(['PC-SKU-2'], 'USD', PRICED, true, AT);
        expect(read.chain?.rules.filter((r) => r.source === 'quote')).toHaveLength(1);
      });
    });
  });
}

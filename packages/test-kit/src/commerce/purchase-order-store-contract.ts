/**
 * The behaviour every `PurchaseOrderStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Ids start `poct_`; the D1 run deletes those rows before each
 * case.
 */
import type { PurchaseOrder, PurchaseOrderLine } from '@commerceworker/core';
import type { PurchaseOrderStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const ALL = { all: true } as const;
const A = 'poct_co_a';
const B = 'poct_co_b';

const po = (id: string, over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id,
  companyId: A,
  buyerId: null,
  poNumber: id.toUpperCase(),
  status: 'draft',
  currency: 'USD',
  shipTo: null,
  notes: null,
  quoteId: null,
  orderId: null,
  source: 'app',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

const line = (sku: string, over: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => ({
  sku,
  name: null,
  qty: 1,
  unitPrice: null,
  ...over,
});

const LINES = [line('poct-w1'), line('poct-w2', { name: 'Widget', qty: 4, unitPrice: 2.5 })];

async function seed(s: PurchaseOrderStore, p: PurchaseOrder, lines = LINES) {
  expect(await s.create(p, lines)).toEqual({ ok: true });
}

export function describePurchaseOrderStoreContract(
  name: string,
  make: () => Promise<PurchaseOrderStore>,
) {
  describe(`${name}: the purchase order store contract`, () => {
    it('keeps a PO with its lines in the order written, and its address', async () => {
      const s = await make();
      const shipTo = {
        name: 'Dock 4',
        line1: '1 Main St',
        city: 'Austin',
        postalCode: '78701',
        country: 'US',
      };
      await seed(s, po('poct_1', { shipTo, notes: 'Deliver before noon', buyerId: 'poct_m1' }));
      expect(await s.get(ALL, 'poct_1')).toEqual({
        ...po('poct_1', { shipTo, notes: 'Deliver before noon', buyerId: 'poct_m1' }),
        lines: LINES,
      });
      expect(await s.get(ALL, 'poct_none')).toBeUndefined();
    });

    it('keeps PO numbers unique within a company, whatever the case, and lets a cancelled one go', async () => {
      const s = await make();
      await seed(s, po('poct_1', { poNumber: 'PO-100' }));
      expect(await s.create(po('poct_2', { poNumber: 'po-100' }), LINES)).toEqual({
        ok: false,
        conflict: 'number',
      });
      // Nothing of the refused PO was kept.
      expect(await s.get(ALL, 'poct_2')).toBeUndefined();
      expect(await s.create(po('poct_1', { poNumber: 'PO-101' }), LINES)).toEqual({
        ok: false,
        conflict: 'id',
      });
      // Another company may use the same number.
      await seed(s, po('poct_3', { companyId: B, poNumber: 'PO-100' }));
      expect((await s.byNumber(ALL, A, 'Po-100'))?.id).toBe('poct_1');
      expect((await s.byNumber(ALL, B, 'PO-100'))?.id).toBe('poct_3');
      // A cancelled PO gives its number back.
      expect(await s.transition(ALL, 'poct_1', 'draft', 'cancelled', 2_000)).toBe(true);
      expect(await s.byNumber(ALL, A, 'PO-100')).toBeUndefined();
      await seed(s, po('poct_4', { poNumber: 'PO-100' }));
      expect((await s.byNumber(ALL, A, 'PO-100'))?.id).toBe('poct_4');
    });

    it('edits only a draft, header and lines together', async () => {
      const s = await make();
      await seed(s, po('poct_1', { poNumber: 'PO-1' }));
      expect(
        await s.updateDraft(
          ALL,
          'poct_1',
          {
            poNumber: 'PO-1B',
            notes: 'Rush',
            buyerId: 'poct_m1',
            lines: [line('poct-x', { qty: 9 })],
          },
          2_000,
        ),
      ).toEqual({ ok: true });
      expect(await s.get(ALL, 'poct_1')).toEqual({
        ...po('poct_1', { poNumber: 'PO-1B', notes: 'Rush', buyerId: 'poct_m1', updatedAt: 2_000 }),
        lines: [line('poct-x', { qty: 9 })],
      });
      // A field left out stays; null clears.
      expect(await s.updateDraft(ALL, 'poct_1', { notes: null }, 3_000)).toEqual({ ok: true });
      const kept = await s.get(ALL, 'poct_1');
      expect(kept).toMatchObject({ notes: null, poNumber: 'PO-1B', buyerId: 'poct_m1' });
      expect(kept?.lines).toEqual([line('poct-x', { qty: 9 })]);
      // Once it is anything else, the edit is refused and nothing changes.
      expect(await s.transition(ALL, 'poct_1', 'draft', 'submitted', 4_000)).toBe(true);
      expect(await s.updateDraft(ALL, 'poct_1', { poNumber: 'PO-2', lines: LINES }, 5_000)).toEqual(
        { ok: false, conflict: 'missing' },
      );
      expect(await s.get(ALL, 'poct_1')).toMatchObject({
        poNumber: 'PO-1B',
        status: 'submitted',
        updatedAt: 4_000,
        lines: [line('poct-x', { qty: 9 })],
      });
      expect(await s.updateDraft(ALL, 'poct_none', { notes: 'x' }, 5_000)).toEqual({
        ok: false,
        conflict: 'missing',
      });
    });

    it('refuses an edit to a taken number whole: the lines stay as they were', async () => {
      const s = await make();
      await seed(s, po('poct_1', { poNumber: 'PO-1' }));
      await seed(s, po('poct_2', { poNumber: 'PO-2' }));
      expect(
        await s.updateDraft(ALL, 'poct_2', { poNumber: 'po-1', lines: [line('poct-y')] }, 2_000),
      ).toEqual({ ok: false, conflict: 'number' });
      expect(await s.get(ALL, 'poct_2')).toMatchObject({
        poNumber: 'PO-2',
        updatedAt: 1_000,
        lines: LINES,
      });
      // Keeping its own number is not a conflict.
      expect(
        await s.updateDraft(ALL, 'poct_2', { poNumber: 'PO-2', notes: 'same' }, 3_000),
      ).toEqual({ ok: true });
    });

    it('moves a status only from the one read, and of a submit and a cancel racing one wins', async () => {
      const s = await make();
      await seed(s, po('poct_1'));
      expect(await s.transition(ALL, 'poct_1', 'submitted', 'approved', 2_000)).toBe(false);
      const results = await Promise.all([
        s.transition(ALL, 'poct_1', 'draft', 'submitted', 2_000),
        s.transition(ALL, 'poct_1', 'draft', 'cancelled', 2_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await s.get(ALL, 'poct_1'))?.status).toBe(results[0] ? 'submitted' : 'cancelled');
      expect(await s.transition(ALL, 'poct_none', 'draft', 'submitted', 2_000)).toBe(false);
    });

    it('lets a submit and an edit race without a half-edited submitted PO', async () => {
      const s = await make();
      await seed(s, po('poct_1'));
      const [moved, edited] = await Promise.all([
        s.transition(ALL, 'poct_1', 'draft', 'submitted', 2_000),
        s.updateDraft(ALL, 'poct_1', { notes: 'late', lines: [line('poct-late')] }, 2_000),
      ]);
      expect(moved).toBe(true);
      const now = await s.get(ALL, 'poct_1');
      // The edit landed whole before the submit, or was refused whole after it.
      if (edited.ok) expect(now).toMatchObject({ notes: 'late', lines: [line('poct-late')] });
      else expect(now).toMatchObject({ notes: null, lines: LINES });
    });

    it('bounds every read and write by its scope', async () => {
      const s = await make();
      await seed(s, po('poct_a1'));
      await seed(s, po('poct_b1', { companyId: B }));
      const a = { companyId: A };
      expect(await s.get(a, 'poct_b1')).toBeUndefined();
      expect((await s.get(a, 'poct_a1'))?.id).toBe('poct_a1');
      expect(await s.byNumber(a, B, 'POCT_B1')).toBeUndefined();
      expect((await s.list(a, {}, { limit: 10 })).rows.map((r) => r.id)).toEqual(['poct_a1']);
      // Naming another company doesn't widen a scope.
      expect(await s.list(a, { companyId: B }, { limit: 10 })).toEqual({
        rows: [],
        total: 0,
        next: null,
      });
      expect(await s.transition(a, 'poct_b1', 'draft', 'submitted', 2_000)).toBe(false);
      expect(await s.updateDraft(a, 'poct_b1', { notes: 'mine' }, 2_000)).toEqual({
        ok: false,
        conflict: 'missing',
      });
      expect(await s.linkOrder(a, 'poct_b1', 'poct_ord', 2_000)).toBe(false);
      expect(await s.get(ALL, 'poct_b1')).toMatchObject({
        status: 'draft',
        notes: null,
        orderId: null,
      });
      expect((await s.list(ALL, { companyId: B }, { limit: 10 })).rows.map((r) => r.id)).toEqual([
        'poct_b1',
      ]);
    });

    it('lists newest first with a total, pages by cursor, and filters', async () => {
      const s = await make();
      await seed(s, po('poct_1', { createdAt: 1_000, buyerId: 'poct_m1', poNumber: 'A-1' }));
      await seed(s, po('poct_2', { createdAt: 2_000, status: 'submitted', poNumber: 'B-2' }));
      await seed(s, po('poct_3', { createdAt: 3_000, buyerId: 'poct_m1', poNumber: 'A-3' }), [
        line('poct-q'),
      ]);
      await seed(s, po('poct_4', { createdAt: 3_000, poNumber: 'A-4', source: 'edi' }));
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

      const first = await s.list(ALL, {}, { limit: 2 });
      expect(ids(first.rows)).toEqual(['poct_4', 'poct_3']);
      expect(first.total).toBe(4);
      expect(first.rows[1]?.lineCount).toBe(1);
      expect(first.rows[0]?.lineCount).toBe(2);
      expect(first.next).toEqual({ at: 3_000, id: 'poct_3' });
      const second = await s.list(ALL, {}, { limit: 2, after: first.next! });
      expect(ids(second.rows)).toEqual(['poct_2', 'poct_1']);
      expect(second.next).toBeNull();

      expect(ids((await s.list(ALL, { status: 'submitted' }, { limit: 10 })).rows)).toEqual([
        'poct_2',
      ]);
      const byBuyer = await s.list(ALL, { buyerId: 'poct_m1' }, { limit: 10 });
      expect(ids(byBuyer.rows)).toEqual(['poct_3', 'poct_1']);
      expect(byBuyer.total).toBe(2);
      expect(ids((await s.list(ALL, { from: 2_000, to: 2_500 }, { limit: 10 })).rows)).toEqual([
        'poct_2',
      ]);
      expect(ids((await s.list(ALL, { from: 3_000 }, { limit: 10 })).rows)).toEqual([
        'poct_4',
        'poct_3',
      ]);
      expect(ids((await s.list(ALL, { search: 'a-' }, { limit: 10 })).rows)).toEqual([
        'poct_4',
        'poct_3',
        'poct_1',
      ]);
      // A search is a literal, not a pattern.
      expect((await s.list(ALL, { search: '%' }, { limit: 10 })).total).toBe(0);
    });

    it('links an order once, to one PO, and finds the PO by it', async () => {
      const s = await make();
      await seed(s, po('poct_1'));
      await seed(s, po('poct_2'));
      expect(await s.byOrder('poct_ord1')).toBeUndefined();
      expect(await s.linkOrder(ALL, 'poct_1', 'poct_ord1', 2_000)).toBe(true);
      // The same link again is fine; a different order, or another PO taking it, is not.
      expect(await s.linkOrder(ALL, 'poct_1', 'poct_ord1', 3_000)).toBe(true);
      expect(await s.linkOrder(ALL, 'poct_1', 'poct_ord2', 3_000)).toBe(false);
      expect(await s.linkOrder(ALL, 'poct_2', 'poct_ord1', 3_000)).toBe(false);
      expect((await s.byOrder('poct_ord1'))?.id).toBe('poct_1');
      expect((await s.get(ALL, 'poct_2'))?.orderId).toBeNull();
    });
  });
}

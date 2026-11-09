import type { Order } from '@commerceworker/core';
import { FIRST_PARTY } from '@commerceworker/core';
import type { ProductRecord, SellerRecord } from '@commerceworker/ports/commerce';
import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryMarketplaceStore, InMemoryPricingStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { answerSellerOrders, schedulePayouts, splitBySeller } from '../src/commerce';

const product = (sku: string, sellerId: string | null): ProductRecord => ({
  sku,
  name: sku,
  price: 10,
  cost: 5,
  stock: 0,
  reserved: 0,
  reorderPoint: 0,
  reorderQty: 0,
  supplier: '',
  sellerId,
  kind: 'physical',
  catalogAt: null,
  weightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
});
const seller = (id: string, over: Partial<SellerRecord> = {}): SellerRecord => ({
  id,
  name: id,
  email: `${id}@example.com`,
  commissionPct: 0.1,
  autoAccept: false,
  active: true,
  ...over,
});

function ports(sellers = [seller('acme'), seller('bolt', { autoAccept: true })]) {
  return {
    pricing: new InMemoryPricingStore(
      { products: [product('A', 'acme'), product('B', 'bolt'), product('F', null)] },
      new FixedClock(),
    ),
    marketplace: new InMemoryMarketplaceStore({ sellers }),
  };
}

describe('splitting an order by seller', () => {
  it("opens a part per seller from the line's or the product's seller", async () => {
    const p = ports();
    const res = await splitBySeller(p, {
      id: 'o1',
      lines: [
        { sku: 'A', qty: 2, unitPrice: 10 },
        { sku: 'F', qty: 1, unitPrice: 5 },
        { sku: 'F', qty: 1, unitPrice: 7, sellerId: 'bolt' },
      ],
    });
    expect(res).toEqual({
      ok: true,
      parts: [
        { sellerId: 'acme', name: 'acme', status: 'pending', subtotal: 20, reason: null },
        { sellerId: 'bolt', name: 'bolt', status: 'accepted', subtotal: 7, reason: null },
        {
          sellerId: FIRST_PARTY,
          name: 'Marketplace',
          status: 'accepted',
          subtotal: 5,
          reason: null,
        },
      ],
    });
  });

  it('opens nothing when a seller is unknown or inactive', async () => {
    const p = ports([seller('acme', { active: false })]);
    const res = await splitBySeller(p, {
      id: 'o2',
      lines: [
        { sku: 'A', qty: 1, unitPrice: 10 },
        { sku: 'B', qty: 1, unitPrice: 10 },
      ],
    });
    expect(res).toEqual({ ok: false, error: 'Unknown or inactive seller: acme, bolt' });
    expect(await p.marketplace.parts('o2')).toEqual([]);
  });
});

describe('scheduling payouts', () => {
  it('pays accepted third-party sellers their share less refunds and commission, once', async () => {
    const p = ports();
    await splitBySeller(p, {
      id: 'o3',
      lines: [
        { sku: 'A', qty: 1, unitPrice: 60 },
        { sku: 'B', qty: 1, unitPrice: 40 },
      ],
    });
    // 20 of a 100 order refunded: bolt's 40 carries 8 of it; commission 10% of the remaining 32.
    const rows = await schedulePayouts(p, { id: 'o3', total: 100 }, 'payout#1', 20);
    expect(rows).toEqual([
      {
        id: 'pout_o3_payout_1_bolt',
        orderId: 'o3',
        sellerId: 'bolt',
        gross: 40,
        refunded: 8,
        commission: 3.2,
        net: 28.8,
        status: 'scheduled',
      },
    ]);
    await schedulePayouts(p, { id: 'o3', total: 100 }, 'payout#1', 0);
    expect(await p.marketplace.payouts('o3')).toEqual(rows);
  });
});

describe("recording sellers' answers", () => {
  const order = (id: string) =>
    ({
      id,
      currency: 'USD',
      lines: [
        { sku: 'A', qty: 1, unitPrice: 60 },
        { sku: 'C', qty: 1, unitPrice: 30, sellerId: 'cove' },
        { sku: 'F', qty: 1, unitPrice: 10 },
      ],
      subtotal: 100,
      shipping: 5,
      tax: 0,
      total: 105,
    }) as unknown as Order;
  const opened = async (id: string) => {
    const p = ports([seller('acme'), seller('cove')]);
    await splitBySeller(p, order(id));
    return p;
  };

  it('waits while a seller is still to answer, and refuses an answer it cannot read', async () => {
    const p = await opened('o4');
    const r = await answerSellerOrders(p, order('o4'), {
      response: { sellerId: 'acme', decision: 'accepted' },
    });
    expect(r).toMatchObject({ ok: true, outcome: 'pending' });
    expect(await answerSellerOrders(p, order('o4'), { response: { sellerId: 'cove' } })).toEqual({
      ok: false,
      error: 'seller.responded needs { sellerId, decision: "accepted" | "rejected" }',
    });
  });

  it("keeps only the accepting sellers' lines on a partial accept, and re-totals", async () => {
    const p = await opened('o5');
    await answerSellerOrders(p, order('o5'), {
      response: { sellerId: 'acme', decision: 'accepted' },
    });
    const r = await answerSellerOrders(p, order('o5'), {
      response: { sellerId: 'cove', decision: 'rejected', reason: 'Out of stock' },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome).toBe('partial');
    expect(r.order?.lines.map((l) => l.sku)).toEqual(['A', 'F']);
    expect(r.order).toMatchObject({ subtotal: 70, shipping: 5, total: 75 });
    expect(r.parts.find((x) => x.sellerId === 'cove')).toMatchObject({
      status: 'rejected',
      reason: 'Out of stock',
    });
  });

  it('rejects every part still pending when the wait expires', async () => {
    const p = await opened('o6');
    const r = await answerSellerOrders(p, order('o6'), { expire: 'No response' });
    expect(r).toMatchObject({ ok: true, outcome: 'partial' });
    // A replay changes nothing: the parts are no longer pending.
    const again = await answerSellerOrders(p, order('o6'), {
      response: { sellerId: 'acme', decision: 'accepted' },
    });
    expect(again).toMatchObject({ ok: true, outcome: 'partial' });
  });
});

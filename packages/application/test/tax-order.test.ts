import type { Order, TaxCertificate } from '@commerceworker/core';
import {
  InMemoryPricingStore,
  InMemoryTaxCertificateStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { taxOrder } from '../src/commerce';

const NOW = Date.UTC(2026, 10, 1);
const order = (meta: Record<string, unknown> = {}) =>
  ({
    id: 'o_tax',
    customerId: 'cus_1',
    currency: 'USD',
    lines: [{ sku: 'A', qty: 1, unitPrice: 100 }],
    subtotal: 100,
    shipping: 10,
    tax: 0,
    total: 110,
    meta: {
      shipTo: {
        line1: '1 Main St',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      },
      ...meta,
    },
  }) as unknown as Order;
const cert: TaxCertificate = {
  id: 'txc_1',
  customerId: 'cus_1',
  number: 'TX-123456',
  regions: [{ country: 'US', region: 'TX' }],
  expiresAt: null,
  file: null,
  status: 'active',
  createdBy: 'ann',
  createdById: 'usr_ann',
  createdAt: NOW - 10,
  verifiedBy: 'bo',
  verifiedAt: NOW - 5,
  revokedBy: null,
  revokedAt: null,
} as TaxCertificate;
const opts = { now: NOW, exemptions: true, includeShipping: true, regions: [], fallbackRate: 0.1 };

async function ports(withCert = true) {
  const certificates = new InMemoryTaxCertificateStore();
  if (withCert) await certificates.add(cert);
  return { certificates, pricing: new InMemoryPricingStore({ products: PRODUCTS }) };
}

const product = (sku: string, taxClass: string | null) => ({
  sku,
  name: sku,
  price: 100,
  cost: 0,
  stock: 0,
  reserved: 0,
  reorderPoint: 0,
  reorderQty: 0,
  supplier: '',
  sellerId: null,
  kind: 'physical',
  catalogAt: null,
  weightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  taxClass,
});
const PRODUCTS = [product('A', null), product('BOOK', 'reduced'), product('GIFT', 'gift-card')];
/** A standard line, a reduced-rate line and a gift card, $100 each, with $10 shipping. */
const mixed = () =>
  ({
    ...order(),
    lines: [
      { sku: 'A', qty: 1, unitPrice: 100 },
      { sku: 'BOOK', qty: 2, unitPrice: 50 },
      { sku: 'GIFT', qty: 1, unitPrice: 100 },
    ],
  }) as unknown as Order;

describe('taxing an order', () => {
  it('taxes at the fallback rate with no certificate, shipping included', async () => {
    const r = await taxOrder(await ports(false), order(), opts);
    expect(r).toMatchObject({ ok: true, rate: 0.1, exempted: false, certificate: null });
    if (r.ok) expect(r.totals.tax).toBe(11);
  });

  it('exempts with a verified certificate for the ship-to, unless exemptions are off', async () => {
    const r = await taxOrder(await ports(), order(), opts);
    expect(r).toMatchObject({ ok: true, rate: 0, exempted: true });
    if (r.ok) expect(r.certificate?.id).toBe('txc_1');
    const off = await taxOrder(await ports(), order(), { ...opts, exemptions: false });
    expect(off).toMatchObject({ ok: true, rate: 0.1, exempted: false, certificate: null });
  });

  it('lets a provider decide what the certificate exempts, and keeps its amount as a rate', async () => {
    const seen: unknown[] = [];
    const r = await taxOrder(await ports(), order(), {
      ...opts,
      provider: async (input) => {
        seen.push(input);
        return { amount: 5.5, exempted: false };
      },
    });
    expect(seen[0]).toMatchObject({
      subtotal: 100,
      shipping: 10,
      exemption: { certificate: 'TX-123456' },
    });
    expect(r).toMatchObject({ ok: true, rate: 0.05, exempted: false });
  });

  it("refuses a provider's amount over the cap", async () => {
    const r = await taxOrder(await ports(false), order(), {
      ...opts,
      provider: async () => ({ amount: 90 }),
    });
    expect(r).toEqual({ ok: false, problem: 'over_cap', amount: 90, taxable: 110 });
  });

  it('taxes each line at its tax class’s rate, and shipping at the standard rate', async () => {
    const r = await taxOrder(await ports(false), mixed(), {
      ...opts,
      classes: { 'gift-card': 0, reduced: 0.05 },
    });
    if (!r.ok) throw new Error('refused');
    // 100 × 10% + 100 × 5% + 100 × 0% + 10 shipping × 10%.
    expect(r.totals).toMatchObject({ subtotal: 300, tax: 16, total: 326 });
    expect(r.rate).toBe(0.1);
    expect(r.lines.map((l) => l.taxRate)).toEqual([undefined, 0.05, 0]);
    expect(r.byClass).toEqual([
      { sku: 'BOOK', taxClass: 'reduced', rate: 0.05 },
      { sku: 'GIFT', taxClass: 'gift-card', rate: 0 },
    ]);
  });

  it('takes a class’s rate for the ship-to region over its rate everywhere', async () => {
    const r = await taxOrder(await ports(false), mixed(), {
      ...opts,
      classes: { reduced: 0.05 },
      regions: [
        { country: 'US', region: 'TX', rate: 0.0825 },
        { country: 'US', region: 'TX', class: 'reduced', rate: 0.02 },
      ],
    });
    if (!r.ok) throw new Error('refused');
    // The gift card's class has no rate, so it is taxed as ordinary goods are.
    expect(r.lines.map((l) => l.taxRate)).toEqual([undefined, 0.02, undefined]);
    expect(r.totals.tax).toBe(19.33);
  });

  it('reads no products and taxes one rate when the node rates no class', async () => {
    const p = await ports(false);
    let reads = 0;
    const pricing = { products: async () => (reads++, PRODUCTS) };
    const stale = { ...mixed(), lines: mixed().lines.map((l) => ({ ...l, taxRate: 0 })) };
    const r = await taxOrder({ ...p, pricing }, stale as Order, opts);
    if (!r.ok) throw new Error('refused');
    expect(reads).toBe(0);
    // A rate sent on a line is not the tax node's: it is dropped.
    expect(r.lines.every((l) => l.taxRate === undefined)).toBe(true);
    expect(r.totals.tax).toBe(31);
  });

  it('exempts every class under a certificate, and tells a provider each line’s class', async () => {
    const exempt = await taxOrder(await ports(), mixed(), { ...opts, classes: { reduced: 0.05 } });
    if (!exempt.ok) throw new Error('refused');
    expect(exempt.totals.tax).toBe(0);
    expect(exempt.lines.every((l) => l.taxRate === undefined)).toBe(true);

    let asked: { lines: unknown } | undefined;
    const r = await taxOrder(await ports(false), mixed(), {
      ...opts,
      classes: { reduced: 0.05 },
      provider: async (input) => {
        asked = input;
        return { amount: 15.5 };
      },
    });
    if (!r.ok) throw new Error('refused');
    expect(asked?.lines).toEqual([
      { sku: 'A', qty: 1, amount: 100 },
      { sku: 'BOOK', qty: 2, amount: 100, taxClass: 'reduced' },
      { sku: 'GIFT', qty: 1, amount: 100, taxClass: 'gift-card' },
    ]);
    // The provider's amount is the order's tax: no line keeps a built-in rate beside it.
    expect(r.totals.tax).toBe(15.5);
    expect(r.lines.every((l) => l.taxRate === undefined)).toBe(true);
  });
});

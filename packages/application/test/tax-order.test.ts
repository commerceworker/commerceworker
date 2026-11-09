import type { Order, TaxCertificate } from '@commerceworker/core';
import { InMemoryTaxCertificateStore } from '@commerceworker/test-kit/commerce';
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
  return { certificates };
}

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
});

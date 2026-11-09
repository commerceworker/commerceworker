import { type Order, type ShippingOption, shippingConfigSchema } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { type LiveCarrierQuote, rateShipping } from '../src/commerce';

const config = (live = false) =>
  shippingConfigSchema.parse({
    services: [
      { id: 'ground', title: 'Ground', carrier: 'ups', base: 10, minDays: 3, maxDays: 5 },
      { id: 'air', title: 'Air', carrier: 'ups', base: 30, minDays: 1, maxDays: 2 },
    ],
    ...(live ? { liveCarriers: [{ id: 'acme', carrier: 'acme', url: 'https://rates.test' }] } : {}),
  });
const order = (over: Partial<Order> = {}) =>
  ({
    id: 'o_ship',
    currency: 'USD',
    lines: [{ sku: 'PC-SKU-1', qty: 2, unitPrice: 10 }],
    subtotal: 20,
    shipping: 0,
    tax: 0,
    total: 20,
    meta: {},
    ...over,
  }) as unknown as Order;
const none: LiveCarrierQuote = async () => [];
const ports = (liveQuote = none) => ({
  pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock()),
  liveQuote,
});
const option = (id: string, amount: number): ShippingOption =>
  ({
    id,
    title: id,
    carrier: 'acme',
    amount,
    minDays: 1,
    maxDays: 2,
    free: false,
  }) as ShippingOption;

describe('rating shipping', () => {
  it('charges nothing for a pickup', async () => {
    const r = await rateShipping(
      ports(),
      order({ fulfillment: { method: 'pickup' } } as Partial<Order>),
      {
        config: config(),
        select: 'cheapest',
      },
    );
    expect(r).toMatchObject({ outcome: 'none', totals: { shipping: 0 } });
  });

  it('falls back to the static services and picks the cheapest', async () => {
    const r = await rateShipping(ports(), order(), { config: config(true), select: 'cheapest' });
    expect(r).toMatchObject({
      outcome: 'ok',
      source: 'static',
      units: 2,
      chosen: { id: 'ground' },
    });
    expect(r.outcome === 'ok' && r.totals?.shipping).toBe(10);
  });

  it("uses live carriers' options when any answer", async () => {
    const r = await rateShipping(
      ports(async () => [option('acme-2day', 7)]),
      order(),
      {
        config: config(true),
        select: 'cheapest',
      },
    );
    expect(r).toMatchObject({ outcome: 'ok', source: 'live' });
  });

  it("prefers the provider's options, and falls back saying why when it fails", async () => {
    const quoted = await rateShipping(ports(), order(), {
      config: config(),
      select: 'cheapest',
      provider: {
        id: 'plug',
        quote: async () => ({
          options: [{ id: 'x', title: 'X', amount: 4, minDays: 1, maxDays: 1 }],
        }),
      },
    });
    expect(quoted).toMatchObject({ outcome: 'ok', source: 'provider' });
    const failed = await rateShipping(ports(), order(), {
      config: config(),
      select: 'cheapest',
      provider: { id: 'plug', quote: async () => Promise.reject(new Error('down')) },
    });
    expect(failed).toMatchObject({ outcome: 'ok', source: 'static', providerError: 'down' });
  });

  it('is unavailable when the order asks for an option not offered', async () => {
    const r = await rateShipping(ports(), order({ shippingOption: 'teleport' } as Partial<Order>), {
      config: config(),
      select: 'from_order',
    });
    expect(r).toMatchObject({ outcome: 'unavailable' });
    expect(r.outcome !== 'none' && r.chosen).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** The pricing store the Commerce page's rates table reads, in memory. */
const { InMemoryPricingStore } = await import('@commerceworker/test-kit/commerce');
const clock = { now: () => new Date() };
let pricing = new InMemoryPricingStore({}, clock);
vi.mock('~/lib/wire.server', () => ({ pricingStore: () => pricing, backOffice: () => ({}) }));

const { fxRatesPage } = await import('~/lib/commerce.server');

beforeEach(() => {
  pricing = new InMemoryPricingStore({}, clock);
});

describe('the Commerce page’s exchange rates', () => {
  it('lists each currency with its source, who set it and when, never the base currency', async () => {
    expect(await fxRatesPage()).toEqual([]);
    await pricing.setFxRates([{ currency: 'GBP', rate: 0.79 }], 1_000, 'ecb');
    await pricing.setFxRates([{ currency: 'EUR', rate: 0.93 }], 2_000, 'person', 'ann@example.com');
    expect(await fxRatesPage()).toEqual([
      {
        currency: 'EUR',
        rate: 0.93,
        updatedAt: 2_000,
        source: 'person',
        updatedBy: 'ann@example.com',
      },
      { currency: 'GBP', rate: 0.79, updatedAt: 1_000, source: 'ecb', updatedBy: null },
    ]);
  });
});

import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { refreshFxRates } from '../src/commerce';

const feed = { date: '2026-11-06', perEur: { USD: 1.08, GBP: 0.84, CAD: 1.49, JPY: 162.5 } };
const store = () => new InMemoryPricingStore(structuredClone(PRICING_FIXTURE), new FixedClock());

describe('refreshing exchange rates', () => {
  it('writes only the currencies the deployment sells in, per one US dollar', async () => {
    const pricing = store();
    expect(await refreshFxRates({ pricing }, feed, ['EUR', 'GBP', 'XYZ'], 1)).toEqual({
      ok: true,
      date: '2026-11-06',
      updated: ['EUR', 'GBP'],
      missing: ['XYZ'],
    });
    expect(await pricing.fxRate('EUR')).toBe(0.925926);
    expect(await pricing.fxRate('GBP')).toBe(0.777778);
    // Not named, so not switched on although the feed has it.
    expect(await pricing.fxRate('JPY')).toBeNull();
  });

  it('keeps the old rates when the feed could not be read, and does nothing with none named', async () => {
    const pricing = store();
    const before = await pricing.fxRate('EUR');
    expect(await refreshFxRates({ pricing }, null, ['EUR'], 1)).toMatchObject({ ok: false });
    expect(await refreshFxRates({ pricing }, feed, [], 1)).toEqual({
      ok: false,
      reason: 'No currencies to refresh',
    });
    expect(await pricing.fxRate('EUR')).toBe(before);
  });
});

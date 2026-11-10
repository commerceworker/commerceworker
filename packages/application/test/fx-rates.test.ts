import { REFRESH_OVERWRITES } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { afterEach, describe, expect, it } from 'vitest';
import { listFxRates, planFxRate, refreshFxRates, setFxRate } from '../src/commerce';

const store = () => new InMemoryPricingStore(structuredClone(PRICING_FIXTURE), new FixedClock());
const feed = { date: '2026-11-06', perEur: { USD: 1.08, GBP: 0.84, EUR: 1 } };

describe('listing exchange rates', () => {
  it('shows each rate with when and by whom, and the allowed currencies with none yet', async () => {
    const pricing = store();
    await pricing.setFxRates([{ currency: 'GBP', rate: 0.8 }], 5_000, 'person', 'ada@example.com');
    const { base, rates } = await listFxRates({ pricing }, ['GBP', 'CAD', 'USD']);
    expect(base).toBe('USD');
    expect(rates).toEqual([
      { currency: 'CAD', rate: null, updatedAt: null, source: null, updatedBy: null },
      { currency: 'EUR', rate: 0.92, updatedAt: 0, source: 'ecb', updatedBy: null },
      {
        currency: 'GBP',
        rate: 0.8,
        updatedAt: 5_000,
        source: 'person',
        updatedBy: 'ada@example.com',
      },
    ]);
  });
});

describe('setting an exchange rate', () => {
  it('stores a person’s rate and drafts the audit event with the change', async () => {
    const pricing = store();
    const r = await setFxRate(
      { pricing },
      { currency: 'EUR', rate: 0.97 },
      'ada@example.com',
      9_000,
    );
    expect(r).toMatchObject({ ok: true, previous: 0.92 });
    expect(r.ok && r.audit).toEqual({
      action: 'fx.rate_set',
      target: 'EUR',
      detail: { from: 0.92, to: 0.97, percent: 5.43 },
    });
    expect((await listFxRates({ pricing })).rates[0]).toMatchObject({
      rate: 0.97,
      updatedAt: 9_000,
      source: 'person',
      updatedBy: 'ada@example.com',
    });
  });

  it('flags a large change in the audit event and the plan, and still sets it', async () => {
    const pricing = store();
    const plan = await planFxRate({ pricing }, { currency: 'EUR', rate: 1.2 });
    expect(plan.change.large).toBe(true);
    const r = await setFxRate({ pricing }, { currency: 'EUR', rate: 1.2 }, 'ada', 1);
    expect(r.ok && r.audit.detail).toMatchObject({ large: true });
  });

  it('adds a currency the deployment names, and refuses one nobody uses', async () => {
    const pricing = store();
    expect(
      await setFxRate({ pricing }, { currency: 'CAD', rate: 1.37 }, 'ada', 1, ['CAD']),
    ).toMatchObject({
      ok: true,
      previous: null,
    });
    expect(await pricing.fxRate('CAD')).toBe(1.37);
    expect(
      await setFxRate({ pricing }, { currency: 'JPY', rate: 150 }, 'ada', 1, ['CAD']),
    ).toMatchObject({
      ok: false,
    });
    expect(await pricing.fxRate('JPY')).toBeNull();
  });

  it('refuses the base currency, a bad code and a rate out of bounds, writing nothing', async () => {
    const pricing = store();
    for (const input of [
      { currency: 'USD', rate: 1 },
      { currency: 'eur', rate: 1 },
      { currency: 'EUR', rate: 0 },
      { currency: 'EUR', rate: -1 },
      { currency: 'EUR', rate: Number.NaN },
      { currency: 'EUR', rate: Number.POSITIVE_INFINITY },
      { currency: 'EUR', rate: 1e9 },
    ])
      expect(await setFxRate({ pricing }, input, 'ada', 1)).toMatchObject({ ok: false });
    expect(await pricing.fxRate('EUR')).toBe(0.92);
    expect((await pricing.fxRateRows())[0]?.source).toBe('ecb');
  });
});

describe('the daily refresh and a person’s rate', () => {
  const original = { ...REFRESH_OVERWRITES };
  afterEach(() => Object.assign(REFRESH_OVERWRITES, original));

  it('overwrites a person’s rate when the rule hands it back to the feed', async () => {
    REFRESH_OVERWRITES.person = true;
    const pricing = store();
    await setFxRate({ pricing }, { currency: 'GBP', rate: 0.5 }, 'ada', 1, ['GBP']);
    expect(await refreshFxRates({ pricing }, feed, ['GBP'], 2)).toMatchObject({ updated: ['GBP'] });
    expect((await pricing.fxRateRows()).find((r) => r.currency === 'GBP')).toMatchObject({
      rate: 0.777778,
      source: 'ecb',
      updatedBy: null,
    });
  });

  it('leaves a person’s rate and refreshes the rest, as the rule says today', async () => {
    const pricing = store();
    await setFxRate({ pricing }, { currency: 'GBP', rate: 0.5 }, 'ada', 1, ['GBP']);
    expect(await refreshFxRates({ pricing }, feed, ['GBP', 'EUR'], 2)).toMatchObject({
      updated: ['EUR'],
    });
    expect(await pricing.fxRate('GBP')).toBe(0.5);
  });
});

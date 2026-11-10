import { describe, expect, it } from 'vitest';
import {
  FX_LARGE_CHANGE,
  fxRateChange,
  fxRateProblem,
  parseEcbRates,
  parseFxCurrencies,
  REFRESH_OVERWRITES,
  ratesPerBase,
  refreshMayWrite,
} from '../src';

// The shape the ECB publishes at ECB_DAILY_URL, trimmed to a few currencies.
const ECB = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-11-06'>
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='JPY' rate='162.50'/>
      <Cube currency='GBP' rate='0.8400'/>
      <Cube currency='CAD' rate='1.4900'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('exchange rates from the ECB', () => {
  it('reads the day and each currency per euro', () => {
    expect(parseEcbRates(ECB)).toEqual({
      date: '2026-11-06',
      perEur: { USD: 1.08, JPY: 162.5, GBP: 0.84, CAD: 1.49 },
    });
  });

  it('refuses an answer that is not the feed, so it never overwrites good rates', () => {
    expect(parseEcbRates('<html>Service unavailable</html>')).toBeNull();
    expect(parseEcbRates("<Cube time='2026-11-06'></Cube>")).toBeNull();
    expect(
      parseEcbRates("<Cube time='2026-11-06'><Cube currency='USD' rate='abc'/></Cube>"),
    ).toBeNull();
  });

  it('refuses a feed whose US dollar is implausible, so a bad publish reprices nothing', () => {
    const withUsd = (usd: string) =>
      `<Cube time='2026-11-06'><Cube currency='USD' rate='${usd}'/><Cube currency='GBP' rate='0.84'/></Cube>`;
    expect(parseEcbRates(withUsd('0.0001'))).toBeNull();
    expect(parseEcbRates(withUsd('25'))).toBeNull();
    expect(
      parseEcbRates("<Cube time='2026-11-06'><Cube currency='GBP' rate='0.84'/></Cube>"),
    ).toBeNull();
    expect(parseEcbRates(withUsd('1.08'))?.perEur.GBP).toBe(0.84);
  });

  it('turns per-euro rates into units per one US dollar, the euro included', () => {
    const feed = parseEcbRates(ECB)!;
    expect(ratesPerBase(feed, ['EUR', 'GBP', 'CAD', 'JPY'])).toEqual({
      rates: [
        { currency: 'EUR', rate: 0.925926 },
        { currency: 'GBP', rate: 0.777778 },
        { currency: 'CAD', rate: 1.37963 },
        { currency: 'JPY', rate: 150.462963 },
      ],
      missing: [],
    });
  });

  it('leaves out the base currency and names what the feed lacks', () => {
    const feed = parseEcbRates(ECB)!;
    expect(ratesPerBase(feed, ['usd', 'gbp', 'XYZ', 'GBP'])).toEqual({
      rates: [{ currency: 'GBP', rate: 0.777778 }],
      missing: ['XYZ'],
    });
    // A feed without the base currency can't convert anything; nothing infinite or zero is written.
    expect(ratesPerBase({ date: 'd', perEur: { GBP: 0.84 } }, ['GBP']).missing).toEqual(['GBP']);
    expect(ratesPerBase({ date: 'd', perEur: { USD: 1, XAA: 1e-9 } }, ['XAA'])).toEqual({
      rates: [],
      missing: ['XAA'],
    });
  });

  it('reads FX_CURRENCIES as distinct ISO codes, dropping anything else', () => {
    expect(parseFxCurrencies('EUR, gbp,EUR,,euro,CA')).toEqual(['EUR', 'GBP']);
    expect(parseFxCurrencies(undefined)).toEqual([]);
  });
});

describe('a rate a person sets', () => {
  const known = ['EUR', 'GBP'];
  const ok = (currency: string, rate: number) => fxRateProblem({ currency, rate }, known);

  it('takes a known currency and a rate within bounds', () => {
    expect(ok('EUR', 0.93)).toBeNull();
    expect(ok('GBP', 1e-4)).toBeNull();
    expect(ok('GBP', 1e6)).toBeNull();
  });

  it('refuses the base currency, a bad code and a currency nobody uses', () => {
    expect(ok('USD', 1)).toMatch(/base currency/);
    expect(ok('eur', 1)).toMatch(/three capital letters/);
    expect(ok('EURO', 1)).toMatch(/three capital letters/);
    expect(ok('JPY', 150)).toMatch(/fxCurrencies/);
    // The base stays refused even when a caller lists it as known.
    expect(fxRateProblem({ currency: 'USD', rate: 1 }, ['USD'])).toMatch(/base currency/);
  });

  it('refuses a rate that is not a positive, finite number within bounds', () => {
    for (const rate of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 9e-5, 1_000_001])
      expect(ok('EUR', rate), String(rate)).toMatch(/units of EUR per one USD/);
  });

  it('measures the change from the current rate and flags a large one, never blocking it', () => {
    expect(fxRateChange(0.92, 0.92)).toEqual({ percent: 0, large: false });
    expect(fxRateChange(1, 1 + FX_LARGE_CHANGE / 2).large).toBe(false);
    expect(fxRateChange(1, 1.1).large).toBe(true);
    expect(fxRateChange(1, 0.5)).toEqual({ percent: -50, large: true });
    // Nothing to compare with: no percent, no flag.
    expect(fxRateChange(null, 5)).toEqual({ percent: null, large: false });
    expect(ok('EUR', 92)).toBeNull();
  });
});

describe('the daily refresh and a person’s rate', () => {
  it('keeps a person’s rate, and refreshes its own', () => {
    expect(REFRESH_OVERWRITES).toEqual({ ecb: true, person: false });
    expect(refreshMayWrite('person')).toBe(false);
    expect(refreshMayWrite('ecb')).toBe(true);
    expect(refreshMayWrite(undefined)).toBe(true);
  });
});

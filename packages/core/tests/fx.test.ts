import { describe, expect, it } from 'vitest';
import { parseEcbRates, parseFxCurrencies, ratesPerBase } from '../src';

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

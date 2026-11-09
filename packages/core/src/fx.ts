/**
 * Exchange rates from the European Central Bank's daily reference feed
 * (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml): about 30 currencies against the
 * euro, published once a working day. Pure: the engine fetches the XML; this reads it and turns it
 * into CommerceWorker's convention, units of a currency per one base currency (`fx_rates.rate`).
 */

import { BASE_CURRENCY } from './types';

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/**
 * How many US dollars a euro may plausibly be worth. A feed outside it is a bad publish, not a
 * market move, and is refused whole rather than repricing every order.
 */
export const USD_PER_EUR_BOUNDS = [0.5, 2] as const;

/** The feed's rates: units of each currency per 1 EUR, and the day they are for. */
export type EcbRates = { date: string; perEur: Record<string, number> };

/**
 * Reads the feed: `<Cube time="YYYY-MM-DD">` holding `<Cube currency="USD" rate="1.0821"/>` rows.
 * Null when it isn't that shape (no date, or no rates), or when its US dollar is outside
 * `USD_PER_EUR_BOUNDS` (every rate here is relative to it), so a bad answer never overwrites good
 * rates.
 */
export function parseEcbRates(xml: string): EcbRates | null {
  const feed = readEcb(xml);
  if (!feed) return null;
  const usd = feed.perEur.USD;
  const [lo, hi] = USD_PER_EUR_BOUNDS;
  return usd !== undefined && usd >= lo && usd <= hi ? feed : null;
}

function readEcb(xml: string): EcbRates | null {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) return null;
  const perEur: Record<string, number> = {};
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) perEur[m[1]!] = rate;
  }
  return Object.keys(perEur).length ? { date, perEur } : null;
}

/**
 * Units of each wanted currency per one base currency, from the feed's per-euro rates:
 * `perEur[c] / perEur[base]`, and the euro itself `1 / perEur[base]`. Rounded to 6 decimals.
 * A currency the feed lacks is left out (`missing`); the base currency is never in the result.
 */
export function ratesPerBase(
  feed: EcbRates,
  wanted: readonly string[],
  base: string = BASE_CURRENCY,
): { rates: { currency: string; rate: number }[]; missing: string[] } {
  const perEur: Record<string, number> = { ...feed.perEur, EUR: 1 };
  const baseRate = perEur[base];
  const rates: { currency: string; rate: number }[] = [];
  const missing: string[] = [];
  for (const currency of new Set(wanted.map((c) => c.trim().toUpperCase()))) {
    if (!currency || currency === base) continue;
    const r = perEur[currency];
    const rate = r === undefined || !baseRate ? Number.NaN : Math.round((r / baseRate) * 1e6) / 1e6;
    // Only a finite, positive rate is ever written.
    if (Number.isFinite(rate) && rate > 0) rates.push({ currency, rate });
    else missing.push(currency);
  }
  return { rates, missing };
}

/** `FX_CURRENCIES`: a comma-separated list of ISO 4217 codes. Anything else in it is dropped. */
export function parseFxCurrencies(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{3}$/.test(c)),
    ),
  ];
}

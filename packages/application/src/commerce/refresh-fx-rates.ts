/**
 * Refreshing the workspace's exchange rates from a published feed (the engine's daily cron, from
 * the ECB). Only the currencies the deployment names are written, so a feed can't switch on a
 * currency nobody chose to sell in. A feed that didn't parse writes nothing and keeps the old rates.
 */
import { type EcbRates, ratesPerBase } from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';

export type FxRefresh =
  | { ok: true; date: string; updated: string[]; missing: string[] }
  | { ok: false; reason: string };

export async function refreshFxRates(
  ports: { readonly pricing: PricingStore },
  feed: EcbRates | null,
  currencies: readonly string[],
  now: number,
): Promise<FxRefresh> {
  if (!currencies.length) return { ok: false, reason: 'No currencies to refresh' };
  if (!feed)
    return { ok: false, reason: 'The rates feed could not be read; rates left as they were' };
  const { rates, missing } = ratesPerBase(feed, currencies);
  await ports.pricing.setFxRates(rates, now);
  return { ok: true, date: feed.date, updated: rates.map((r) => r.currency), missing };
}

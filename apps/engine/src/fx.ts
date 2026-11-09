/**
 * The daily exchange-rate refresh (`scheduled`, the daily cron): the ECB's reference rates for the
 * currencies the deployment sells in (`FX_CURRENCIES`, from the registry's `fxCurrencies`). With
 * none named it does nothing. Cloudflare publishes no exchange rates; the ECB's feed is public,
 * needs no account or key, and is what many finance systems use as reference.
 */
import { refreshFxRates } from '@commerceworker/application/commerce';
import { ECB_DAILY_URL, parseEcbRates, parseFxCurrencies } from '@commerceworker/core';
import { pricingStore } from './wire';

export async function refreshRates(
  env: Pick<Env, 'DB'> & { FX_CURRENCIES?: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const currencies = parseFxCurrencies(env.FX_CURRENCIES);
  if (!currencies.length) return { ok: false as const, reason: 'No currencies to refresh' };
  let feed = null;
  try {
    const res = await fetcher(ECB_DAILY_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) feed = parseEcbRates(await res.text());
  } catch (err) {
    console.warn('fx: the ECB feed could not be fetched', err);
  }
  return refreshFxRates({ pricing: pricingStore(env) }, feed, currencies, now);
}

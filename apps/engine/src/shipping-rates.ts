/**
 * Shipping rates: the live carriers a `commerce.shipping_rate` node names, or its provider plugin,
 * quoted over the egress policy, falling back to the node's static services. An outbound adapter;
 * the rate rules themselves are core (`rateOptions`, `parseCarrierQuote`). Labels are booked by the
 * shipping use-cases (@commerceworker/application/commerce) through the shipping port.
 */
import {
  BASE_CURRENCY,
  type Order,
  type ParcelLine,
  PROVIDER_MAX_RATE,
  parseCarrierQuote,
  type RateRequest,
  rateOptions,
  readCappedJson,
  type ShippingConfig,
  type ShippingOption,
  safeFetch,
} from '@commerceworker/core';
import { pricingStore } from './wire';

const CARRIER_TIMEOUT_MS = 5_000;

/** The lines that ship (digital lines don't), with their products' per-unit weight and size. */
export async function physicalLines(env: Env, order: Order): Promise<ParcelLine[]> {
  const bySku = new Map(
    (await pricingStore(env).products(order.lines.map((l) => l.sku))).map((p) => [p.sku, p]),
  );
  const lines = order.lines.filter((l) => bySku.get(l.sku)?.kind !== 'digital');
  return lines.map((l) => {
    const p = bySku.get(l.sku);
    return {
      qty: l.qty,
      weightKg: p?.weightKg,
      lengthCm: p?.lengthCm,
      widthCm: p?.widthCm,
      heightCm: p?.heightCm,
    };
  });
}

/** `SHIPPING_CARRIER_AUTH`: a JSON object of live carrier id → Authorization header value. */
function carrierAuth(env: Env): Record<string, string> {
  try {
    const v = JSON.parse(env.SHIPPING_CARRIER_AUTH ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/**
 * Quotes one live carrier: POSTs `{ itemCount, country, subtotal, currency }` (amounts in the base
 * currency), plus `billableKg` when the basis weighs units, and reads `{ options: [...] }`. Any failure (https only, 5 s, non-2xx, bad JSON)
 * returns no options, so the caller falls back to the static services.
 */
/** The most of a carrier's quote read: a list of options, not a document. */
const CARRIER_MAX_BYTES = 256 * 1024;

async function liveQuote(
  carrier: ShippingConfig['liveCarriers'][number],
  req: RateRequest,
  auth: string | undefined,
): Promise<ShippingOption[]> {
  try {
    // Behind the egress policy: https only, and no redirect carries the carrier's credential.
    const res = await safeFetch(carrier.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({
        itemCount: req.itemCount,
        ...(req.billableKg !== undefined ? { billableKg: req.billableKg } : {}),
        country: req.country ?? null,
        subtotal: req.subtotal,
        currency: BASE_CURRENCY,
      }),
      timeoutMs: CARRIER_TIMEOUT_MS,
    });
    if (!res.ok) return [];
    return parseCarrierQuote(carrier, await readCappedJson(res, CARRIER_MAX_BYTES));
  } catch {
    return [];
  }
}

/**
 * The shipping options for a request, cheapest first: the provider's quote when the node names one
 * and it answers with options, else the live carriers' quotes when any answered, else the static
 * services. A provider's options are checked as a live carrier's are, and its ids carry its id.
 */
export async function quoteShipping(
  env: Env,
  config: ShippingConfig,
  req: RateRequest,
  provider?: { id: string; quote: () => Promise<{ options: unknown[] }> },
): Promise<{
  options: ShippingOption[];
  source: 'provider' | 'live' | 'static';
  /** Why the provider's quote wasn't used, when the node named one. */
  providerError?: string;
}> {
  let providerError: string | undefined;
  if (provider) {
    try {
      const quoted = parseCarrierQuote(
        { id: provider.id, carrier: provider.id, url: '' },
        await provider.quote(),
      ).filter((o) => o.amount <= PROVIDER_MAX_RATE);
      if (quoted.length) return { options: rateOptions(config, req, quoted), source: 'provider' };
      providerError = 'offered no usable options';
    } catch (err) {
      // As with a live carrier: rates fall back rather than fail the order, and the node says so.
      console.warn(`shipping rates from ${provider.id}`, err);
      providerError = err instanceof Error ? err.message : String(err);
    }
  }
  const auth = config.liveCarriers.length ? carrierAuth(env) : {};
  const live = (
    await Promise.all(config.liveCarriers.map((c) => liveQuote(c, req, auth[c.id])))
  ).flat();
  return {
    options: rateOptions(config, req, live),
    source: live.length ? 'live' : 'static',
    ...(providerError ? { providerError } : {}),
  };
}

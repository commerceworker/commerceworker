/**
 * Live carrier quotes for `commerce.shipping_rate`, over the egress policy: the outbound adapter
 * the `rateShipping` use-case takes. Which quote wins (provider, live, static) is that use-case's;
 * the rate rules themselves are core (`rateOptions`, `parseCarrierQuote`). Labels are booked by the
 * shipping use-cases (@commerceworker/application/commerce) through the shipping port.
 */

import type { LiveCarrierQuote } from '@commerceworker/application/commerce';
import {
  BASE_CURRENCY,
  parseCarrierQuote,
  type RateRequest,
  readCappedJson,
  type ShippingConfig,
  type ShippingOption,
  safeFetch,
} from '@commerceworker/core';

const CARRIER_TIMEOUT_MS = 5_000;

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

/** The live-carrier quote `rateShipping` takes, with this deployment's carrier credentials. */
export function liveCarrierQuote(env: Env): LiveCarrierQuote {
  let auth: Record<string, string> | undefined;
  return (carrier, req) => {
    auth ??= carrierAuth(env);
    return liveQuote(carrier, req, auth[carrier.id]);
  };
}

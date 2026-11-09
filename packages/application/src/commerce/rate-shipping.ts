/**
 * Rating an order's shipping (`commerce.shipping_rate`). The rate rules themselves are core
 * (`rateOptions`, `pickOption`, `billableKg`, `shippableLines`); this says which ones, in order:
 * the provider's quote when the node names one and it answers with usable options, else the live
 * carriers' quotes when any answered, else the node's static services. A provider's options are
 * checked as a live carrier's are and bounded by `PROVIDER_MAX_RATE`; a provider that fails falls
 * back rather than failing the order, and the result says why. Rates are in the base currency; the
 * options returned are in the order's.
 */
import {
  billableKg,
  computeTotals,
  fromBase,
  type Order,
  PROVIDER_MAX_RATE,
  parseCarrierQuote,
  pickOption,
  type RateRequest,
  rateOptions,
  type ShippingConfig,
  type ShippingOption,
  type ShippingSelection,
  shippableLines,
  shipToCountry,
  toBase,
} from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';

/** One live carrier's options for a request; none when it didn't answer usably. */
export type LiveCarrierQuote = (
  carrier: ShippingConfig['liveCarriers'][number],
  req: RateRequest,
) => Promise<ShippingOption[]>;

export type ShippingRated =
  /** Nothing ships (a pickup, a delivery, or only digital lines): shipping is 0. */
  | { readonly outcome: 'none'; readonly totals: ReturnType<typeof computeTotals> }
  | {
      readonly outcome: 'ok' | 'unavailable';
      readonly units: number;
      readonly country: string | undefined;
      readonly weight?: { basis: string; billableKg: number; estimatedUnits: number };
      readonly source: 'provider' | 'live' | 'static';
      /** Every option offered, in the order's currency, cheapest first. */
      readonly options: ShippingOption[];
      /** The option chosen; absent when `unavailable`. */
      readonly chosen?: ShippingOption;
      readonly totals?: ReturnType<typeof computeTotals>;
      /** Why the provider's quote wasn't used, when the node named one. */
      readonly providerError?: string;
    };

export async function rateShipping(
  ports: { readonly pricing: PricingStore; readonly liveQuote: LiveCarrierQuote },
  order: Order,
  opts: {
    config: ShippingConfig;
    select: ShippingSelection;
    provider?: { id: string; quote: (req: RateRequest) => Promise<{ options: unknown[] }> };
  },
): Promise<ShippingRated> {
  const method = order.fulfillment?.method ?? 'ship';
  const lines =
    method === 'ship'
      ? shippableLines(order.lines, await ports.pricing.products(order.lines.map((l) => l.sku)))
      : [];
  const units = lines.reduce((n, l) => n + l.qty, 0);
  if (!units) return { outcome: 'none', totals: computeTotals({ ...order, shipping: 0 }) };
  const fx = order.fxRate;
  const country = shipToCountry(order);
  // Weighed only when the basis asks; a unit whose product has no weight or size counts
  // `defaultKg`, and the result says how many did.
  const weighed = billableKg(opts.config, lines);
  const req: RateRequest = {
    itemCount: units,
    ...(weighed ? { billableKg: weighed.kg } : {}),
    country,
    subtotal: toBase(order.subtotal, fx),
  };
  const { options, source, providerError } = await quote(
    ports.liveQuote,
    opts.config,
    req,
    opts.provider,
  );
  const offered = options.map((o) => ({ ...o, amount: fromBase(o.amount, fx) }));
  const chosen = pickOption(offered, opts.select, order.shippingOption);
  return {
    outcome: chosen ? 'ok' : 'unavailable',
    units,
    country,
    ...(weighed
      ? {
          weight: {
            basis: opts.config.basis,
            billableKg: weighed.kg,
            estimatedUnits: weighed.estimated,
          },
        }
      : {}),
    source,
    options: offered,
    ...(chosen ? { chosen, totals: computeTotals({ ...order, shipping: chosen.amount }) } : {}),
    ...(providerError ? { providerError } : {}),
  };
}

async function quote(
  liveQuote: LiveCarrierQuote,
  config: ShippingConfig,
  req: RateRequest,
  provider?: { id: string; quote: (req: RateRequest) => Promise<{ options: unknown[] }> },
): Promise<{
  options: ShippingOption[];
  source: 'provider' | 'live' | 'static';
  providerError?: string;
}> {
  let providerError: string | undefined;
  if (provider) {
    try {
      const quoted = parseCarrierQuote(
        { id: provider.id, carrier: provider.id, url: '' },
        await provider.quote(req),
      ).filter((o) => o.amount <= PROVIDER_MAX_RATE);
      if (quoted.length) return { options: rateOptions(config, req, quoted), source: 'provider' };
      providerError = 'offered no usable options';
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }
  }
  const live = (await Promise.all(config.liveCarriers.map((c) => liveQuote(c, req)))).flat();
  return {
    options: rateOptions(config, req, live),
    source: live.length ? 'live' : 'static',
    ...(providerError ? { providerError } : {}),
  };
}

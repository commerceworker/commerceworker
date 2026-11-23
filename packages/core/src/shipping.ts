/**
 * Shipping rates for the `commerce.shipping_rate` node, and the order totals every pricing node
 * recomputes. Pure: the engine quotes live carriers (the `rateShipping` use-case, with apps/engine/src/shipping-rates.ts's carrier adapter) and passes their options in.
 *
 * Rates are configured on the node, so they are pinned with the flow version: a checkout quote and
 * the order's run read the same config. Amounts are in BASE_CURRENCY, like list prices; the engine
 * converts them at the order's rate.
 *
 * A static service costs `base + perItem × units + perKg × billable kg`, times `intlMultiplier` when
 * the ship-to country is not one of `domesticCountries`. `basis` says what the kilograms are:
 * `units` (the default) rates by units alone, `weight` by each unit's weight, and `dim_weight` by
 * each unit's billable weight, the greater of its weight and its volume over `dimDivisor`
 * (`billableKg`). Live carriers are POSTed the cart and answer with options of
 * their own; when none answers, the static services are used. Options come back cheapest first, and
 * once the subtotal reaches `freeThreshold` the cheapest one is free.
 */

import { z } from 'zod';
import { checkAddress } from './address';
import { money, toBase } from './logic';
import type { Order, OrderLine } from './types';

const serviceSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/, 'Service ids are 1–40 letters, digits, _ or -'),
  title: z.string().min(1).max(80),
  carrier: z.string().min(1).max(40),
  base: z.number().nonnegative(),
  perItem: z.number().nonnegative().default(0),
  /** Per kilogram of billable weight; charged only when the basis is `weight` or `dim_weight`. */
  perKg: z.number().nonnegative().default(0),
  minDays: z.number().int().nonnegative(),
  maxDays: z.number().int().nonnegative(),
});

const liveCarrierSchema = z.object({
  /** Prefixes the ids of the options it returns, and names its credential in the engine. */
  id: z.string().regex(/^[\w-]{1,40}$/, 'Carrier ids are 1–40 letters, digits, _ or -'),
  carrier: z.string().min(1).max(40),
  url: z.url({ protocol: /^https$/, error: 'Live carrier URLs must be https URLs' }),
});

export const SHIPPING_BASES = ['units', 'weight', 'dim_weight'] as const;
export type ShippingBasis = (typeof SHIPPING_BASES)[number];

export const shippingConfigSchema = z
  .object({
    services: z.array(serviceSchema).min(1),
    /** What a service's `perKg` and a carrier's `billableKg` are of; `units` weighs nothing. */
    basis: z.enum(SHIPPING_BASES).default('units'),
    /** cm³ per kg for dimensional weight: 5000 is the common carrier divisor for cm and kg. */
    dimDivisor: z.number().positive().default(5000),
    /** The kilograms a unit counts for when its product has neither weight nor dimensions. */
    defaultKg: z.number().nonnegative().default(1),
    liveCarriers: z.array(liveCarrierSchema).default([]),
    intlMultiplier: z.number().positive().default(1),
    /** ISO 3166-1 alpha-2 codes. A ship-to with no country counts as domestic. */
    domesticCountries: z
      .array(z.string().length(2))
      .default(['US'])
      .transform((cs) => cs.map((c) => c.toUpperCase())),
    /** Subtotal at which the cheapest option is free. */
    freeThreshold: z.number().nonnegative().optional(),
  })
  .refine((c) => c.services.every((s) => s.minDays <= s.maxDays), {
    message: 'A service’s minDays must not exceed its maxDays',
  })
  .refine((c) => new Set(c.services.map((s) => s.id)).size === c.services.length, {
    message: 'Service ids must be unique',
  });
export type ShippingConfig = z.infer<typeof shippingConfigSchema>;
export type LiveCarrier = ShippingConfig['liveCarriers'][number];

export type ShippingOption = {
  id: string;
  title: string;
  carrier: string;
  amount: number;
  minDays: number;
  maxDays: number;
  /** Zeroed by the free-shipping threshold. */
  free?: boolean;
};

/**
 * What the rate is for: physical units, where they go and the subtotal, in BASE_CURRENCY.
 * `billableKg` is set only when the basis weighs units (`weight` or `dim_weight`).
 */
export type RateRequest = {
  itemCount: number;
  billableKg?: number;
  country?: string;
  subtotal: number;
};

/** One line's units as the products table describes them: per-unit kg and cm, null when unknown. */
export type ParcelLine = {
  qty: number;
  weightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
};

/**
 * The billable kilograms of `lines` under the config's basis, summed per unit, to the gram. Under
 * `weight` a unit counts its weight; under `dim_weight` the greater of its weight and its
 * dimensional weight (length × width × height / `dimDivisor`), either alone when only one is known.
 * A unit with nothing to go on counts `defaultKg`, and is counted in `estimated`. Under `units`
 * nothing is weighed: undefined.
 */
export function billableKg(
  config: Pick<ShippingConfig, 'basis' | 'dimDivisor' | 'defaultKg'>,
  lines: ParcelLine[],
): { kg: number; estimated: number } | undefined {
  if (config.basis === 'units') return undefined;
  const known = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  let kg = 0;
  let estimated = 0;
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const actual = known(l.weightKg) ? l.weightKg : undefined;
    const dim =
      config.basis === 'dim_weight' && known(l.lengthCm) && known(l.widthCm) && known(l.heightCm)
        ? (l.lengthCm * l.widthCm * l.heightCm) / config.dimDivisor
        : undefined;
    const each =
      actual === undefined && dim === undefined
        ? config.defaultKg
        : Math.max(actual ?? 0, dim ?? 0);
    if (actual === undefined && dim === undefined) estimated += l.qty;
    kg += each * l.qty;
  }
  return { kg: Math.round(kg * 1000) / 1000, estimated };
}

export const SHIPPING_SELECTIONS = ['from_order', 'cheapest', 'fastest'] as const;
export type ShippingSelection = (typeof SHIPPING_SELECTIONS)[number];

export function isDomestic(config: Pick<ShippingConfig, 'domesticCountries'>, country?: string) {
  const c = country?.trim().toUpperCase();
  return !c || config.domesticCountries.includes(c);
}

/** The ship-to's country as a two-letter code ("USA" → "US"), from `meta.shipTo`; else undefined. */
export function shipToCountry(order: Pick<Order, 'meta'>): string | undefined {
  const c = checkAddress(order.meta?.shipTo).address?.country;
  return c && /^[A-Z]{2}$/.test(c) ? c : undefined;
}

/**
 * A place tax is charged by: a country, or a region within it. `commerce.tax`'s rates and a tax
 * exemption certificate's coverage both name places this way.
 */
export const taxPlaceSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code'),
  region: z.string().min(1).max(10).optional(),
});
export type TaxPlace = z.infer<typeof taxPlaceSchema>;

/**
 * A product's tax class: how its kind of goods is taxed (`reduced`, `books`, `gift-card`). A
 * product with none is taxed at the standard rate.
 */
export const taxClassSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Lowercase letters, digits, "-" or "_" (max 40)');
/** The class of a product that names none; a region without a `class` sets its rate. */
export const STANDARD_TAX_CLASS = 'standard';

const taxRateSchema = z.number().min(0).max(0.5);

/**
 * Tax rates by ship-to place, for `commerce.tax`. An entry with a `class` is that tax class's rate
 * there; one without is the standard rate.
 */
export const taxRegionsSchema = z
  .array(taxPlaceSchema.extend({ rate: taxRateSchema, class: taxClassSchema.optional() }))
  .max(200);
export type TaxRegion = z.infer<typeof taxRegionsSchema>[number];

/** A tax class's rate wherever no region names the class, for `commerce.tax`. */
export const taxClassRatesSchema = z
  .record(taxClassSchema, taxRateSchema)
  .refine((r) => Object.keys(r).length <= 50, 'At most 50 tax classes');
export type TaxClassRates = z.infer<typeof taxClassRatesSchema>;

const isStandard = (c: string | null | undefined) => !c || c === STANDARD_TAX_CLASS;

function placeRate(
  regions: readonly TaxRegion[],
  country: string | undefined,
  region: string | undefined,
  inClass: (x: TaxRegion) => boolean,
): number | undefined {
  if (!country) return undefined;
  const r = region?.toUpperCase();
  return (
    regions.find(
      (x) => inClass(x) && x.country === country && x.region && x.region.toUpperCase() === r,
    )?.rate ?? regions.find((x) => inClass(x) && x.country === country && !x.region)?.rate
  );
}

/**
 * The standard rate for an order shipped to `country` and `region`: a match on both first, then
 * the country alone, then `fallback`. Entries for a tax class don't count.
 */
export function regionalTaxRate(
  regions: readonly TaxRegion[],
  country: string | undefined,
  region: string | undefined,
  fallback: number,
): number {
  return placeRate(regions, country, region, (x) => isStandard(x.class)) ?? fallback;
}

/** Whether a tax node's settings tax any class apart from the standard rate. */
export const taxesByClass = (regions: readonly TaxRegion[], classes: TaxClassRates): boolean =>
  Object.keys(classes).length > 0 || regions.some((x) => !isStandard(x.class));

/**
 * The rate for a product of `taxClass` shipped to `country` and `region`: the class's entry for
 * the region, then for the country, then its rate in `classes`, then `standard` (so a class the
 * node doesn't know is never taxed less than ordinary goods).
 */
export function classTaxRate(
  taxClass: string | null | undefined,
  regions: readonly TaxRegion[],
  classes: TaxClassRates,
  country: string | undefined,
  region: string | undefined,
  standard: number,
): number {
  if (isStandard(taxClass)) return standard;
  return (
    placeRate(regions, country, region, (x) => x.class === taxClass) ??
    classes[taxClass as string] ??
    standard
  );
}

/**
 * The lines with each one's tax rate set where it differs from the order's `standard` rate, and
 * cleared where it doesn't (or for every line when `rates` is absent: one rate for the order).
 */
export function withLineTaxRates<L extends { sku: string; taxRate?: number }>(
  lines: readonly L[],
  standard: number,
  rates?: (sku: string) => number,
): L[] {
  return lines.map((l) => {
    const { taxRate: _old, ...rest } = l;
    const rate = rates?.(l.sku);
    return (rate === undefined || rate === standard ? rest : { ...rest, taxRate: rate }) as L;
  });
}

/** The configured services' rates for a request, unsorted. */
export function staticRates(config: ShippingConfig, req: RateRequest): ShippingOption[] {
  const multiplier = isDomestic(config, req.country) ? 1 : config.intlMultiplier;
  const units = Math.max(1, req.itemCount);
  const kg = config.basis === 'units' ? 0 : (req.billableKg ?? 0);
  return config.services.map((s) => ({
    id: s.id,
    title: s.title,
    carrier: s.carrier,
    amount: money((s.base + s.perItem * units + s.perKg * kg) * multiplier),
    minDays: s.minDays,
    maxDays: s.maxDays,
  }));
}

const quotedSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(80).optional(),
  carrier: z.string().max(40).optional(),
  amount: z.number().nonnegative(),
  minDays: z.number().int().nonnegative().optional(),
  maxDays: z.number().int().nonnegative().optional(),
});

/**
 * A live carrier's answer, `{ options: [{ id, amount, title?, carrier?, minDays?, maxDays? }] }`,
 * as options whose ids carry the carrier's id. Malformed options are dropped.
 */
export function parseCarrierQuote(carrier: LiveCarrier, body: unknown): ShippingOption[] {
  const list = (body as { options?: unknown } | null)?.options;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const o = quotedSchema.safeParse(raw);
    if (!o.success) return [];
    const minDays = o.data.minDays ?? 0;
    return [
      {
        id: `${carrier.id}_${o.data.id}`,
        title: o.data.title || o.data.id,
        carrier: o.data.carrier || carrier.carrier,
        amount: money(o.data.amount),
        minDays,
        maxDays: Math.max(minDays, o.data.maxDays ?? minDays),
      },
    ];
  });
}

/**
 * The options to offer, cheapest first: the live carriers' quotes when any answered, otherwise the
 * static services. The cheapest is free once the subtotal reaches the threshold.
 */
export function rateOptions(
  config: ShippingConfig,
  req: RateRequest,
  live: ShippingOption[] = [],
): ShippingOption[] {
  const base = live.length ? live : staticRates(config, req);
  const sorted = [...base].sort((a, b) => a.amount - b.amount || a.maxDays - b.maxDays);
  const free = config.freeThreshold !== undefined && req.subtotal >= config.freeThreshold;
  return sorted.map((o, i) => (free && i === 0 ? { ...o, amount: 0, free: true } : o));
}

/**
 * The option a selection picks. `from_order` takes the order's `shippingOption` when it names one
 * on offer (undefined when it names one that isn't) and the cheapest when it names none.
 */
export function pickOption(
  options: ShippingOption[],
  select: ShippingSelection,
  wanted?: string,
): ShippingOption | undefined {
  if (!options.length) return undefined;
  if (select === 'from_order' && wanted) return options.find((o) => o.id === wanted);
  if (select === 'fastest')
    return [...options].sort(
      (a, b) => a.maxDays - b.maxDays || a.minDays - b.minDays || a.amount - b.amount,
    )[0];
  return options[0];
}

/**
 * Subtotal, shipping, tax and total from the order's lines, shipping and tax rate. Tax is
 * `(subtotal + shipping when taxShipping) × taxRate`; an order no tax node has run on has none.
 * A line with a `taxRate` of its own (its product's tax class) is taxed at that instead, and the
 * tax is rounded once, for the order.
 */
export function computeTotals(
  order: Pick<Order, 'lines' | 'fxRate'> &
    Partial<Pick<Order, 'shipping' | 'taxRate' | 'taxShipping'>>,
): Pick<Order, 'subtotal' | 'shipping' | 'tax' | 'total' | 'baseTotal'> {
  const subtotal = money(order.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));
  const shipping = money(order.shipping ?? 0);
  const rate = order.taxRate ?? 0;
  // Line rates count only once a tax node has run, so one sent with an order charges nothing.
  const byLine = order.taxRate !== undefined && order.lines.some((l) => l.taxRate !== undefined);
  const tax = byLine
    ? money(
        order.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0) * (l.taxRate ?? rate), 0) +
          (order.taxShipping ? shipping * rate : 0),
      )
    : money((subtotal + (order.taxShipping ? shipping : 0)) * rate);
  const total = money(subtotal + shipping + tax);
  return { subtotal, shipping, tax, total, baseTotal: toBase(total, order.fxRate) };
}

/**
 * The lines that ship, with their products' per-unit weight and size: digital lines (by their
 * product's kind) don't.
 */
export function shippableLines(
  lines: readonly OrderLine[],
  products: readonly {
    sku: string;
    kind?: string | null;
    weightKg?: number | null;
    lengthCm?: number | null;
    widthCm?: number | null;
    heightCm?: number | null;
  }[],
): ParcelLine[] {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  return lines
    .filter((l) => !isDigital(bySku.get(l.sku)?.kind))
    .map((l) => {
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

/** A product delivered as a code or a download, never shipped. */
export const isDigital = (kind: string | null | undefined) => kind === 'digital';

/** The order's digital lines, by their product's kind, with each line's index on the order. */
export function digitalLines(
  lines: readonly OrderLine[],
  products: readonly { sku: string; kind?: string | null }[],
): { index: number; sku: string; qty: number }[] {
  const kinds = new Map(products.map((p) => [p.sku, p.kind]));
  return [...lines.entries()]
    .filter(([, l]) => isDigital(kinds.get(l.sku)))
    .map(([index, l]) => ({ index, sku: l.sku, qty: l.qty }));
}

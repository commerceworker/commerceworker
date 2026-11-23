/**
 * Taxing an order (`commerce.tax`): the rate, from a tax provider or the node's regions, and the
 * customer's exemption certificate in force where the order ships. The certificate is judged as of
 * the order's start (`now`, not the clock), so verifying, revoking or expiry later doesn't change
 * this order; none applies without a ship-to country or for a customer matched from what a buyer
 * typed (`customerTrusted`). Built in, a certificate exempts everything; a provider is told of it
 * and decides what it exempts. A provider's amount is kept as the rate it works out to, so later
 * nodes that recompute totals keep the same tax.
 *
 * Built in, a product's tax class is taxed at its own rate where the node gives one (`classes`, or
 * a region entry with a `class`): each such line keeps its rate, and the products are read only
 * when the node taxes by class. A provider is told each line's class and answers one amount.
 */
import {
  checkAddress,
  classTaxRate,
  computeTotals,
  customerTrusted,
  exemptingCertificate,
  type Order,
  providerTaxProblem,
  regionalTaxRate,
  shipToCountry,
  type TaxCertificate,
  type TaxClassRates,
  type TaxRegion,
  taxesByClass,
  withLineTaxRates,
} from '@commerceworker/core';
import type { PricingStore, TaxCertificateStore } from '@commerceworker/ports/commerce';

/** What a tax provider is asked, and what it answers. */
export type TaxProviderInput = {
  subtotal: number;
  shipping: number;
  includeShipping: boolean;
  currency: string;
  /** Each line's amount and its product's tax class (absent for standard goods). */
  lines: { sku: string; qty: number; amount: number; taxClass?: string }[];
  exemption?: { certificate: string; regions: TaxCertificate['regions'] };
};
export type TaxProvider = (
  input: TaxProviderInput,
) => Promise<{ amount: number; exempted?: boolean }>;

export type TaxedOrder =
  | {
      readonly ok: true;
      readonly rate: number;
      readonly taxShipping: boolean;
      /** The order's lines, each with its own rate where its tax class has one. */
      readonly lines: Order['lines'];
      /** The lines taxed apart from `rate`, by class. */
      readonly byClass: { sku: string; taxClass: string; rate: number }[];
      readonly totals: ReturnType<typeof computeTotals>;
      readonly certificate: TaxCertificate | null;
      readonly exempted: boolean;
    }
  | {
      readonly ok: false;
      /** The provider's amount fails `providerTaxProblem`. */
      readonly problem: 'untaxable' | 'over_cap';
      readonly amount: number;
      readonly taxable: number;
    };

export async function taxOrder(
  ports: {
    readonly certificates: TaxCertificateStore;
    readonly pricing: Pick<PricingStore, 'products'>;
  },
  order: Order,
  opts: {
    now: number;
    exemptions: boolean;
    includeShipping: boolean;
    regions: readonly TaxRegion[];
    /** A tax class's rate where no region names it. */
    classes?: TaxClassRates;
    fallbackRate: number;
    provider?: TaxProvider;
  },
): Promise<TaxedOrder> {
  const taxShipping = opts.includeShipping;
  const shipTo = checkAddress(order.meta?.shipTo).address;
  const country = shipToCountry(order);
  const certificate =
    opts.exemptions && customerTrusted(order) && order.customerId
      ? exemptingCertificate(
          await ports.certificates.forCustomer(order.customerId),
          country,
          shipTo?.region,
          opts.now,
        )
      : null;
  let exempted = !!certificate && !opts.provider;
  let rate = exempted
    ? 0
    : regionalTaxRate(opts.regions, country, shipTo?.region, opts.fallbackRate);
  const classes = opts.classes ?? {};
  // A provider is always told the classes; built in, they matter only when the node rates one.
  const classOf =
    opts.provider || (!exempted && taxesByClass(opts.regions, classes))
      ? new Map(
          (await ports.pricing.products(order.lines.map((l) => l.sku))).flatMap((p) =>
            p.taxClass ? [[p.sku, p.taxClass] as const] : [],
          ),
        )
      : new Map<string, string>();
  // One rate for the order unless the node itself rates a class on it.
  let lines = withLineTaxRates(order.lines, rate);
  const byClass: { sku: string; taxClass: string; rate: number }[] = [];
  if (opts.provider) {
    // What computeTotals will tax: the lines' subtotal and rounded shipping, not stored totals.
    const { subtotal, shipping } = computeTotals({ ...order, lines, taxRate: 0 });
    const answer = await opts.provider({
      subtotal,
      shipping,
      includeShipping: taxShipping,
      currency: order.currency,
      lines: order.lines.map((l) => {
        const taxClass = classOf.get(l.sku);
        return {
          sku: l.sku,
          qty: l.qty,
          amount: l.qty * (l.unitPrice ?? 0),
          ...(taxClass ? { taxClass } : {}),
        };
      }),
      ...(certificate
        ? { exemption: { certificate: certificate.number, regions: certificate.regions } }
        : {}),
    });
    // Only the provider can say its amount reflects the certificate.
    exempted = !!certificate && answer.exempted === true;
    const taxable = subtotal + (taxShipping ? shipping : 0);
    const problem = providerTaxProblem(answer.amount, taxable);
    if (problem) return { ok: false, problem, amount: answer.amount, taxable };
    rate = taxable > 0 ? answer.amount / taxable : 0;
  } else if (classOf.size) {
    const rateOf = (sku: string) =>
      classTaxRate(classOf.get(sku), opts.regions, classes, country, shipTo?.region, rate);
    lines = withLineTaxRates(order.lines, rate, rateOf);
    const seen = new Set<string>();
    for (const l of lines) {
      const taxClass = classOf.get(l.sku);
      if (l.taxRate === undefined || !taxClass || seen.has(l.sku)) continue;
      seen.add(l.sku);
      byClass.push({ sku: l.sku, taxClass, rate: l.taxRate });
    }
  }
  return {
    ok: true,
    rate,
    taxShipping,
    lines,
    byClass,
    totals: computeTotals({ ...order, lines, taxRate: rate, taxShipping }),
    certificate,
    exempted,
  };
}

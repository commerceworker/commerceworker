/**
 * Taxing an order (`commerce.tax`): the rate, from a tax provider or the node's regions, and the
 * customer's exemption certificate in force where the order ships. The certificate is judged as of
 * the order's start (`now`, not the clock), so verifying, revoking or expiry later doesn't change
 * this order; none applies without a ship-to country or for a customer matched from what a buyer
 * typed (`customerTrusted`). Built in, a certificate exempts everything; a provider is told of it
 * and decides what it exempts. A provider's amount is kept as the rate it works out to, so later
 * nodes that recompute totals keep the same tax.
 */
import {
  checkAddress,
  computeTotals,
  customerTrusted,
  exemptingCertificate,
  type Order,
  providerTaxProblem,
  regionalTaxRate,
  shipToCountry,
  type TaxCertificate,
  type TaxRegion,
} from '@commerceworker/core';
import type { TaxCertificateStore } from '@commerceworker/ports/commerce';

/** What a tax provider is asked, and what it answers. */
export type TaxProviderInput = {
  subtotal: number;
  shipping: number;
  includeShipping: boolean;
  currency: string;
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
  ports: { readonly certificates: TaxCertificateStore },
  order: Order,
  opts: {
    now: number;
    exemptions: boolean;
    includeShipping: boolean;
    regions: readonly TaxRegion[];
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
    : regionalTaxRate([...opts.regions], country, shipTo?.region, opts.fallbackRate);
  if (opts.provider) {
    // What computeTotals will tax: the lines' subtotal and rounded shipping, not stored totals.
    const { subtotal, shipping } = computeTotals({ ...order, taxRate: 0 });
    const answer = await opts.provider({
      subtotal,
      shipping,
      includeShipping: taxShipping,
      currency: order.currency,
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
  }
  return {
    ok: true,
    rate,
    taxShipping,
    totals: computeTotals({ ...order, taxRate: rate, taxShipping }),
    certificate,
    exempted,
  };
}

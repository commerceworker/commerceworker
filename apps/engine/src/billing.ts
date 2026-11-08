/**
 * Invoices issued through Stripe: `commerce.invoice` with provider "stripe" (the R2 document is
 * rendered either way). The invoice use-cases (@commerceworker/application/commerce) bound to this
 * deployment's invoices, payments ledger, balances and card processor. Stripe's `invoice.paid`
 * event (./payment-events) settles the invoice here and resumes the order. An invoice Stripe
 * refuses to act on where no refusal was expected fails the step for good.
 */
import { NonRetryableError } from 'cloudflare:workflows';
import * as uc from '@commerceworker/application/commerce';
import type { Order } from '@commerceworker/core';
import { type InvoiceRecord, InvoiceRefusedError } from '@commerceworker/ports/commerce';
import { paymentMode } from './payments';
import { balanceStore, invoiceStore, paymentLedger } from './wire';

export { type InvoiceTerms, TERM_DAYS } from '@commerceworker/core';

export type InvoiceRow = InvoiceRecord;

const ports = (env: Env): uc.InvoicePorts => ({
  ledger: paymentLedger(env),
  mode: paymentMode(env),
  invoices: invoiceStore(env),
});

async function settled<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof InvoiceRefusedError) throw new NonRetryableError(err.message);
    throw err;
  }
}

export const issueStripeInvoice = (
  env: Env,
  order: Order,
  stepKey: string,
  opts: { terms: string; sendEmail: boolean; onAccount: boolean },
) => settled(uc.issueInvoice(ports(env), order, stepKey, opts, Date.now()));

export const voidInvoices = (env: Env, orderId: string) =>
  settled(uc.voidInvoices(ports(env), orderId));

export const settleInvoice = (env: Env, externalId: string, amountPaid?: number) =>
  uc.settleInvoice(
    { invoices: invoiceStore(env), balances: balanceStore(env) },
    externalId,
    amountPaid,
  );

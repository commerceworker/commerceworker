/**
 * Invoices issued through the card processor (`commerce.invoice` with provider "stripe"): issue
 * one per step, void an order's unpaid ones on a rollback or a cancel, and settle one when the
 * processor says it's paid. The customer pays on the processor's hosted page.
 *
 * The invoice is recorded before the processor is called and carries the due date the request
 * asks for, so a retried step sends byte-for-byte the same requests under the same idempotency keys
 * (all derived from the invoice id, derived from the step's effect key) and the processor replays
 * its first answers. When payments aren't live the invoice is recorded as a mock one and nothing is
 * sent.
 *
 * Order matters: the draft is created first, excluding pending items, and each item is attached
 * to it by id; then it is finalized and, if asked, sent.
 */
import { invoiceDue, invoiceDueAt, invoiceItems, type Order } from '@commerceworker/core';
import {
  type BalanceStore,
  balanceEntryId,
  type InvoiceRecord,
  InvoiceRefusedError,
  type InvoiceStore,
} from '@commerceworker/ports/commerce';
import { ensureProcessorCustomer, type PaymentPorts, paymentRowId } from './payments';

export type InvoicePorts = PaymentPorts & { readonly invoices: InvoiceStore };

const DAY = 86_400_000;

/**
 * Issues the order's invoice once per step: the processor customer (the account's, or one created
 * once), a draft, its items, finalization and, with `sendEmail`, the processor's email. Returns the
 * invoice as it stands.
 */
export async function issueInvoice(
  ports: InvoicePorts,
  order: Order,
  stepKey: string,
  opts: { terms: string; sendEmail: boolean; onAccount: boolean },
  now: number,
): Promise<InvoiceRecord> {
  const id = paymentRowId('inv', order.id, stepKey);
  const live = ports.mode.live();
  let row = await ports.invoices.open({
    id,
    orderId: order.id,
    provider: live ? 'stripe' : 'mock',
    status: live ? 'pending' : 'open',
    amount: order.total,
    currency: order.currency,
    terms: opts.terms,
    dueAt: invoiceDueAt(opts.terms, now),
    balanceEntryId: opts.onAccount ? balanceEntryId(order.id, stepKey) : null,
  });
  if (row.provider !== 'stripe' || row.status === 'void') return row;

  const processor = ports.mode.processor();
  const invoicing = processor.invoices;
  if (row.status === 'pending' || row.status === 'draft') {
    const customer = await ensureProcessorCustomer(ports.ledger, processor, order);
    let externalId = row.externalId;
    if (!externalId) {
      externalId = await invoicing.createDraft(
        {
          customer,
          currency: order.currency.toLowerCase(),
          description: order.title || `Order ${order.id}`,
          due: invoiceDue(opts.terms, row.dueAt ?? row.createdAt + DAY),
          metadata: { order_id: order.id, step: stepKey, invoice_id: id },
        },
        id,
      );
      await ports.invoices.markDraft(id, externalId);
    }
    for (const [i, item] of invoiceItems(order).entries())
      await invoicing.addItem(
        {
          customer,
          invoice: externalId,
          currency: order.currency.toLowerCase(),
          amount: item.amount,
          description: item.description,
          metadata: { order_id: order.id, invoice_id: id },
        },
        `${id}_item_${i}`,
      );
    const issued = await invoicing.finalize(externalId, `${id}_finalize`);
    // Only from pending or draft: a payment that already settled it stays paid.
    await ports.invoices.markOpen(id, {
      externalId,
      number: issued.number,
      hostedUrl: issued.hostedUrl,
      dueAt: issued.dueDate ? issued.dueDate * 1000 : row.dueAt,
    });
    row = (await ports.invoices.find(id))!;
  }
  if (opts.sendEmail && row.status === 'open' && row.externalId)
    await invoicing.send(row.externalId, `${id}_send`);
  return row;
}

/**
 * Compensation: voids the order's unpaid invoices. A finalized invoice is voided at the processor,
 * a draft deleted, and the store changes only after the processor has. A paid invoice is left
 * alone (the money arrived; refund it if it must go back) and reported in `paid`. An invoice the
 * processor never confirmed creating (`pending`) is voided here only: an orphaned draft is never
 * finalized or sent.
 */
export async function voidInvoices(ports: InvoicePorts, orderId: string) {
  const rows = await ports.invoices.forOrder(orderId);
  const paid = rows.filter((r) => r.status === 'paid').map((r) => r.number ?? r.id);
  let voided = 0;
  for (const row of rows) {
    if (!['pending', 'draft', 'open'].includes(row.status)) continue;
    if (row.provider === 'stripe' && row.externalId) {
      const invoicing = ports.mode.processor().invoices;
      let status = row.status === 'open' ? 'open' : 'draft';
      for (let attempt = 0; attempt < 2 && status !== 'void' && status !== 'deleted'; attempt++) {
        try {
          if (status === 'draft') {
            await invoicing.delete(row.externalId);
            status = 'deleted';
          } else if (status === 'open' || status === 'uncollectible') {
            await invoicing.void(row.externalId, paymentRowId('void', row.id));
            status = 'void';
          } else break;
        } catch (err) {
          if (!(err instanceof InvoiceRefusedError)) throw err;
          status = err.reason === 'missing' ? 'deleted' : await invoicing.status(row.externalId);
        }
      }
      if (status === 'paid') {
        paid.push(row.number ?? row.id);
        continue;
      }
      if (status !== 'void' && status !== 'deleted') continue;
    }
    if (await ports.invoices.markVoid(row.id, row.status)) voided++;
  }
  return { voided, paid };
}

/**
 * The processor says the invoice is paid: in one transaction it is marked paid and an
 * `invoice_payment` recorded; then the account charge it made comes off the customer's balance
 * (unless a rollback already reversed it), so a redelivered event settles a charge a crash left
 * open. Idempotent. Returns null for an invoice CommerceWorker didn't issue.
 */
export async function settleInvoice(
  ports: { readonly invoices: InvoiceStore; readonly balances: BalanceStore },
  externalId: string,
  amountPaid?: number,
) {
  const row = await ports.invoices.findByExternalId(externalId);
  if (!row) return null;
  const settled = await ports.invoices.markPaid(row.id, {
    id: paymentRowId('ipay', row.id),
    orderId: row.orderId,
    kind: 'invoice_payment',
    amount: amountPaid ?? row.amount,
    status: 'succeeded',
    ref: row.id,
    provider: row.provider,
    externalId,
    currency: row.currency,
  });
  if (row.balanceEntryId) await ports.balances.settle(row.balanceEntryId);
  return { invoiceId: row.id, orderId: row.orderId, settled, row };
}

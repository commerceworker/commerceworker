/**
 * The behaviour every `InvoiceStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Order ids start `ic_`, which the D1 runner clears. Each case gets the
 * store and the payments ledger its payments land in.
 */
import type {
  InvoiceStore,
  NewInvoice,
  NewPayment,
  PaymentLedger,
} from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const invoice = (id: string, over: Partial<NewInvoice> = {}): NewInvoice => ({
  id,
  orderId: 'ic_order',
  provider: 'stripe',
  status: 'pending',
  amount: 120,
  currency: 'USD',
  terms: 'net_30',
  dueAt: 1_000,
  balanceEntryId: null,
  ...over,
});

const payment = (invoiceId: string): NewPayment => ({
  id: `ipay_${invoiceId}`,
  orderId: 'ic_order',
  kind: 'invoice_payment',
  amount: 120,
  status: 'succeeded',
  ref: invoiceId,
  provider: 'stripe',
  externalId: `in_${invoiceId}`,
  currency: 'USD',
});

export function describeInvoiceStoreContract(
  name: string,
  make: () => Promise<{ invoices: InvoiceStore; ledger: PaymentLedger }>,
) {
  describe(`${name}: the invoice store contract`, () => {
    it('records an invoice once: a retry gets what the first stored', async () => {
      const { invoices } = await make();
      const first = await invoices.open(invoice('ic_i1'));
      expect(first).toMatchObject({
        id: 'ic_i1',
        status: 'pending',
        externalId: null,
        paidAt: null,
      });
      expect(await invoices.open(invoice('ic_i1', { amount: 1 }))).toEqual(first);
      expect(await invoices.find('ic_none')).toBeUndefined();
    });

    it('moves pending → draft → open, and finds it by the processor id', async () => {
      const { invoices } = await make();
      await invoices.open(invoice('ic_i2'));
      await invoices.markDraft('ic_i2', 'in_2');
      await invoices.markDraft('ic_i2', 'in_other');
      expect(await invoices.find('ic_i2')).toMatchObject({ status: 'draft', externalId: 'in_2' });
      await invoices.markOpen('ic_i2', {
        externalId: 'in_2',
        number: 'INV-2',
        hostedUrl: 'https://pay.example/2',
        dueAt: 2_000,
      });
      expect(await invoices.findByExternalId('in_2')).toMatchObject({
        id: 'ic_i2',
        status: 'open',
        number: 'INV-2',
        dueAt: 2_000,
      });
    });

    it('marks it paid once, recording its payment, and a paid one stays paid', async () => {
      const { invoices, ledger } = await make();
      await invoices.open(invoice('ic_i3', { status: 'open' }));
      expect(await invoices.markPaid('ic_i3', payment('ic_i3'))).toBe(true);
      expect(await invoices.markPaid('ic_i3', payment('ic_i3'))).toBe(false);
      await invoices.markOpen('ic_i3', {
        externalId: 'x',
        number: null,
        hostedUrl: null,
        dueAt: null,
      });
      expect(await invoices.markVoid('ic_i3', 'open')).toBe(false);
      expect(await invoices.find('ic_i3')).toMatchObject({
        status: 'paid',
        paidAt: expect.any(Number),
      });
      expect((await ledger.forOrder('ic_order')).map((p) => [p.id, p.kind, p.ref])).toEqual([
        ['ipay_ic_i3', 'invoice_payment', 'ic_i3'],
      ]);
    });

    it('voids only from the status it was read in, and a void one is never paid', async () => {
      const { invoices, ledger } = await make();
      await invoices.open(invoice('ic_i4'));
      expect(await invoices.markVoid('ic_i4', 'open')).toBe(false);
      expect(await invoices.markVoid('ic_i4', 'pending')).toBe(true);
      expect(await invoices.markPaid('ic_i4', payment('ic_i4'))).toBe(false);
      expect(await ledger.find('ipay_ic_i4')).toBeUndefined();
    });

    it("lists the order's invoices oldest first", async () => {
      const { invoices } = await make();
      await invoices.open(invoice('ic_b'));
      await invoices.open(invoice('ic_a'));
      await invoices.open(invoice('ic_c', { orderId: 'ic_other' }));
      expect((await invoices.forOrder('ic_order')).map((r) => r.id)).toEqual(['ic_b', 'ic_a']);
    });
  });
}

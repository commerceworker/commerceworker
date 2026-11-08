import {
  describeInvoiceStoreContract,
  InMemoryInvoiceStore,
  InMemoryPaymentLedger,
} from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeInvoiceStoreContract('in memory', async () => {
  const ledger = new InMemoryPaymentLedger({}, clock);
  return { invoices: new InMemoryInvoiceStore(ledger, clock), ledger };
});

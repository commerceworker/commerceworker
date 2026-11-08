/**
 * The invoices port in memory. Paying an invoice records its payment in the payments ledger it is
 * given, as the D1 store records it in the same transaction. The contract in
 * ./invoice-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { Clock } from '@commerceworker/ports';
import type {
  InvoiceRecord,
  InvoiceStore,
  NewInvoice,
  NewPayment,
  PaymentLedger,
} from '@commerceworker/ports/commerce';

export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly rows = new Map<string, InvoiceRecord>();

  constructor(
    private readonly ledger: PaymentLedger,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  private set(id: string, change: Partial<InvoiceRecord>) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...change });
  }

  async open(inv: NewInvoice) {
    if (!this.rows.has(inv.id))
      this.rows.set(inv.id, {
        ...inv,
        externalId: null,
        number: null,
        hostedUrl: null,
        createdAt: this.clock.now().getTime(),
        paidAt: null,
      });
    return this.rows.get(inv.id)!;
  }

  async find(id: string) {
    return this.rows.get(id);
  }

  async findByExternalId(externalId: string) {
    return [...this.rows.values()].find((r) => r.externalId === externalId);
  }

  async forOrder(orderId: string) {
    return [...this.rows.values()]
      .filter((r) => r.orderId === orderId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async markDraft(id: string, externalId: string) {
    if (this.rows.get(id)?.status === 'pending') this.set(id, { status: 'draft', externalId });
  }

  async markOpen(
    id: string,
    issued: {
      externalId: string;
      number: string | null;
      hostedUrl: string | null;
      dueAt: number | null;
    },
  ) {
    const s = this.rows.get(id)?.status;
    if (s === 'pending' || s === 'draft') this.set(id, { status: 'open', ...issued });
  }

  async markVoid(id: string, from: string) {
    if (this.rows.get(id)?.status !== from) return false;
    this.set(id, { status: 'void' });
    return true;
  }

  async markPaid(id: string, payment: NewPayment) {
    const s = this.rows.get(id)?.status;
    const marked = s === 'pending' || s === 'draft' || s === 'open';
    if (marked) this.set(id, { status: 'paid', paidAt: this.clock.now().getTime() });
    if (this.rows.get(id)?.status === 'paid') await this.ledger.record(payment);
    return marked;
  }
}

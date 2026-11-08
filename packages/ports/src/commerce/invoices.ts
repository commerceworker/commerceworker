/**
 * Invoices. `InvoiceStore` records each invoice an order issues and what became of it: `pending`
 * (nothing at the processor yet), `draft`, `open`, `paid` or `void`. Each is recorded before the
 * processor is called and keyed by the step, so a retried step sends the same requests under the
 * same idempotency keys; every status change is guarded by the status it leaves. Paying an invoice
 * records its `invoice_payment` in the same transaction. `InvoiceProcessor` issues them at the card
 * processor. `d1InvoiceStore` (packages/db) and `InMemoryInvoiceStore` (packages/test-kit)
 * implement the store, held to one contract.
 */
import type { NewPayment } from './payments';

export type InvoiceStatus = 'pending' | 'draft' | 'open' | 'paid' | 'void';

export interface InvoiceRecord {
  readonly id: string;
  readonly orderId: string;
  /** `stripe`, or `mock` when payments aren't live. */
  readonly provider: string;
  readonly status: string;
  /** The processor's invoice (in_…). */
  readonly externalId: string | null;
  readonly number: string | null;
  /** The processor's hosted page, where the customer pays. */
  readonly hostedUrl: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly terms: string;
  readonly dueAt: number | null;
  /** The account charge this invoice made, settled when it is paid. */
  readonly balanceEntryId: string | null;
  readonly createdAt: number;
  readonly paidAt: number | null;
}

export type NewInvoice = Pick<
  InvoiceRecord,
  | 'id'
  | 'orderId'
  | 'provider'
  | 'status'
  | 'amount'
  | 'currency'
  | 'terms'
  | 'dueAt'
  | 'balanceEntryId'
>;

export interface InvoiceStore {
  /** Records an invoice once by id and returns what is stored: the first recording wins. */
  open(invoice: NewInvoice): Promise<InvoiceRecord>;
  find(id: string): Promise<InvoiceRecord | undefined>;
  /** The invoice the processor knows by this id. */
  findByExternalId(externalId: string): Promise<InvoiceRecord | undefined>;
  /** The order's invoices, oldest first. */
  forOrder(orderId: string): Promise<InvoiceRecord[]>;
  /** The processor made the draft: `pending` → `draft`, recording its id. */
  markDraft(id: string, externalId: string): Promise<void>;
  /** The processor finalized it: `pending` or `draft` → `open`, so a paid one stays paid. */
  markOpen(
    id: string,
    issued: {
      externalId: string;
      number: string | null;
      hostedUrl: string | null;
      dueAt: number | null;
    },
  ): Promise<void>;
  /** Voids it while it is still in `from`. Returns whether this call voided it. */
  markVoid(id: string, from: string): Promise<boolean>;
  /**
   * The processor says it's paid: in one transaction it becomes `paid` (from pending, draft or
   * open) and `payment` is recorded once it is. Returns whether this call marked it paid.
   */
  markPaid(id: string, payment: NewPayment): Promise<boolean>;
}

/** An invoice the processor finalized. `dueDate` in seconds. */
export interface IssuedInvoice {
  readonly number: string | null;
  readonly hostedUrl: string | null;
  readonly dueDate: number | null;
}

/**
 * A request the processor refused about an invoice: `missing` when it has no such invoice,
 * `refused` otherwise (ask it where the invoice stands).
 */
export class InvoiceRefusedError extends Error {
  override readonly name = 'InvoiceRefusedError';
  constructor(
    message: string,
    readonly reason: 'missing' | 'refused',
  ) {
    super(message);
  }
}

/** Issuing invoices at the card processor. Every write carries an idempotency key. */
export interface InvoiceProcessor {
  createDraft(
    draft: {
      customer: string;
      currency: string;
      description: string;
      due: { daysUntilDue: number } | { dueDate: number };
      metadata: Record<string, string>;
    },
    key: string,
  ): Promise<string>;
  addItem(
    item: {
      customer: string;
      invoice: string;
      currency: string;
      amount: number;
      description: string;
      metadata: Record<string, string>;
    },
    key: string,
  ): Promise<void>;
  finalize(id: string, key: string): Promise<IssuedInvoice>;
  send(id: string, key: string): Promise<void>;
  /** Voids a finalized invoice. Throws `InvoiceRefusedError` when it can't. */
  void(id: string, key: string): Promise<void>;
  /** Deletes a draft. Throws `InvoiceRefusedError` when it can't. */
  delete(id: string): Promise<void>;
  /** Where the processor has the invoice now: draft, open, paid, uncollectible or void. */
  status(id: string): Promise<string>;
}

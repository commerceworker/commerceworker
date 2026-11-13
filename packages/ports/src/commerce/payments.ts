/**
 * The payments ledger: every authorization, capture, charge and refund an order makes, whoever
 * processed it (`provider`: mock, stripe, external, offline), and the card a customer saved for
 * charges off-session. A row is recorded once by its id (derived from the step), so a retried
 * step returns what the first recorded; status changes are guarded by the status they leave, so a
 * void racing a capture leaves exactly one. The processor itself is not here: the engine calls it
 * and records the outcome. `d1PaymentLedger` (packages/db) and `InMemoryPaymentLedger`
 * (packages/test-kit) implement it, held to one contract.
 */

import type { InvoiceProcessor } from './invoices';

export type PaymentProvider = 'mock' | 'stripe' | 'external' | 'offline';

export interface PaymentRecord {
  readonly id: string;
  readonly orderId: string;
  /** `authorization:<method>`, `capture`, `charge`, `refund` or `invoice_payment`. */
  readonly kind: string;
  readonly amount: number;
  readonly status: string;
  /** What it refers to: a capture's authorization, a refund's payment, a decline's reason. */
  readonly ref: string | null;
  readonly provider: string;
  /** The processor's id: a PaymentIntent (pi_…) or a Refund (re_…). */
  readonly externalId: string | null;
  readonly currency: string | null;
  readonly createdAt: number;
}

export type NewPayment = Omit<PaymentRecord, 'createdAt' | 'ref' | 'externalId' | 'currency'> & {
  readonly ref?: string | null;
  readonly externalId?: string | null;
  readonly currency?: string | null;
};

/** The customer's account as payments see it. */
export interface PayingCustomer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly stripeCustomerId: string | null;
  readonly paymentMethodId: string | null;
}

export interface PaymentLedger {
  /** One row by id. */
  find(id: string): Promise<PaymentRecord | undefined>;
  /** These rows, by id; unknown ids are absent. */
  findMany(ids: readonly string[]): Promise<PaymentRecord[]>;
  /**
   * Records a row once by id and returns what is stored: the first recording wins. A row that claims
   * a processor id (an authorization that isn't declined, or a refund) is refused when another row
   * already claims it: `PaymentClaimedError`.
   */
  record(payment: NewPayment): Promise<PaymentRecord>;
  /** Every row of the order, oldest first. */
  forOrder(orderId: string): Promise<PaymentRecord[]>;
  /** The rows that name this processor id, any order. */
  forExternalId(externalId: string): Promise<PaymentRecord[]>;
  /** Voids an authorization while it is still open. Returns whether this call voided it. */
  voidAuthorization(id: string): Promise<boolean>;
  /** The processor canceled an intent: its open authorizations are voided. Returns their orders. */
  voidIntent(externalId: string): Promise<string[]>;
  /**
   * Captures an open authorization: in one transaction it flips to `captured` (naming `capture.id`
   * in its `ref`) only while still `authorized`, and `capture` is recorded only if this call
   * flipped it. Returns the capture row when there is one.
   */
  capture(authorizationId: string, capture: NewPayment): Promise<PaymentRecord | undefined>;
  /** The customer's account, or undefined for a guest or unknown id. */
  customer(customerId: string): Promise<PayingCustomer | undefined>;
  /** Saves the card a `verify` authorization confirmed, and its processor customer when given. */
  saveCard(
    customerId: string,
    card: { paymentMethodId: string; stripeCustomerId?: string },
  ): Promise<void>;
  /**
   * Records the processor customer made for the account, unless one was recorded first. Returns
   * the one stored, so racing steps settle on a single customer.
   */
  claimStripeCustomer(customerId: string, stripeCustomerId: string): Promise<string>;
}

// ── The card processor ────────────────────────────────────────────────────

/** A payment intent as the processor reports it. Amounts in minor units. */
export interface ProcessorIntent {
  readonly id: string;
  /** `requires_capture` (an open authorization), `succeeded`, `canceled`, `requires_action`, … */
  readonly status: string;
  readonly amount: number;
  /** Lower case, as the processor reports it. */
  readonly currency: string;
  readonly customer: string | null;
  readonly paymentMethod: string | null;
  readonly metadata: Record<string, string>;
}

export interface IntentRequest {
  /** Minor units. */
  readonly amount: number;
  /** Lower case. */
  readonly currency: string;
  /** `manual` holds the money for a later capture; `automatic` charges it at once. */
  readonly capture: 'manual' | 'automatic';
  readonly paymentMethod: string;
  readonly customer?: string;
  readonly offSession?: boolean;
  /** Save the method on the customer for charges off-session. */
  readonly saveForLater?: boolean;
  /** Let the processor pick methods that need no redirect (no customer given). */
  readonly anyMethod?: boolean;
  readonly description?: string;
  readonly metadata: Record<string, string>;
}

/** The card was refused or needs the customer: the declined branch, not a retry. */
export class PaymentDeclinedError extends Error {
  override readonly name = 'PaymentDeclinedError';
  constructor(
    readonly reason: string,
    readonly intentId?: string,
  ) {
    super(reason);
  }
}

/**
 * A processor id is already claimed by another row: two orders adopting one PaymentIntent, or one
 * refund recorded twice. The ledger's unique index decides it, so a race has one winner.
 */
export class PaymentClaimedError extends Error {
  override readonly name = 'PaymentClaimedError';
  constructor(readonly externalId: string) {
    super(`${externalId} is already claimed by another payment`);
  }
}

/**
 * The intent isn't in a state that allows the call (canceled before a capture, captured before a
 * cancel). `status` is the intent's, when the processor says.
 */
export class IntentStateError extends Error {
  override readonly name = 'IntentStateError';
  constructor(
    message: string,
    readonly status?: string,
  ) {
    super(message);
  }
}

/** A refund as the processor reports it. */
export interface ProcessorRefund {
  readonly id: string;
  readonly status: string;
  /** Minor units. */
  readonly amount: number;
  readonly metadata: Record<string, string>;
}

/**
 * A card processor (Stripe). Every write carries `key`, an idempotency key derived from the
 * payment row, so a retried step replays the processor's first answer and never pays twice. A
 * failure worth retrying throws as-is; a request the processor refuses throws for good.
 */
export interface PaymentProcessor {
  /** The id recorded as a row's `provider`. */
  readonly id: 'stripe';
  /** Invoices it issues for the customer to pay on its hosted page. */
  readonly invoices: InvoiceProcessor;
  /** Test keys: an order with no method pays with the processor's test card. */
  readonly testMode: boolean;
  /** Creates and confirms an intent. Throws `PaymentDeclinedError` when the card is refused. */
  createIntent(request: IntentRequest, key: string): Promise<ProcessorIntent>;
  retrieveIntent(id: string): Promise<ProcessorIntent>;
  /** Cancels an intent. Throws `IntentStateError` when it can't be canceled. */
  cancelIntent(id: string, key: string): Promise<void>;
  /** Captures `amount` (minor units) of an authorization. Throws `IntentStateError` likewise. */
  captureIntent(id: string, amount: number, key: string): Promise<void>;
  refund(
    request: { intentId: string; amount: number; metadata: Record<string, string> },
    key: string,
  ): Promise<{ id: string; status: string }>;
  /** Every refund of an intent, whoever made it (reconciliation finds the ones made in a dashboard). */
  listRefunds(intentId: string): Promise<ProcessorRefund[]>;
  /** Creates a processor customer and returns its id. */
  createCustomer(
    customer: { email?: string; name?: string; metadata: Record<string, string> },
    key: string,
  ): Promise<string>;
}

/**
 * Who processes new payments. `live()` is false in mock mode, where payments are only recorded;
 * `processor()` is the card processor, called only where a payment needs it (it fails for good
 * when live payments have no credentials).
 */
export interface PaymentMode {
  live(): boolean;
  processor(): PaymentProcessor;
}

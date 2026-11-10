/**
 * Customer balances and credit: what a business customer owes on account, and how much of the rest
 * of their limit open orders have claimed. An invoice node charges the order total to the balance,
 * the invoice's payment settles that charge, and a rollback reverses it, whichever of the two comes
 * first. Every change is a ledger entry applied at most once, so a retried step, a redelivered
 * webhook or a rollback racing a payment moves the balance once. A credit check holds the order's
 * total against the limit in the same atomic step that checks it (`hold`), the invoice converts
 * the hold into its charge, and anything else that ends the order gives it back (`releaseHolds`):
 * a hold lives `held → charged | released | expired` (`CREDIT_HOLD` in core).
 * `d1BalanceStore` (packages/db) implements it on D1 with a guarded ledger;
 * `InMemoryBalanceStore` (packages/test-kit) in memory; one contract holds both.
 */

/** One change to a customer's balance. Charges are positive; a settlement or reversal negative. */
export interface BalanceEntry {
  readonly id: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amount: number;
  readonly applied: boolean;
}

/** A ledger line as the credit account shows it: an applied entry and the balance it left. */
export interface LedgerEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: 'charge' | 'settle' | 'reverse' | 'adjust';
  /** Null for an adjustment, which belongs to no order. */
  readonly orderId: string | null;
  readonly amount: number;
  readonly balanceAfter: number;
  /** An adjustment's author's key, or the charge a settlement or reversal offsets. */
  readonly reference: string | null;
  readonly note: string | null;
}

/** Where a page of the ledger resumes: after this entry, going back in time. */
export interface LedgerCursor {
  readonly at: number;
  readonly id: string;
}

export interface CreditAccount {
  readonly limit: number;
  readonly balance: number;
  /** What open orders have claimed of the limit, not counting a hold that expired. */
  readonly held: number;
  readonly available: number;
}

export interface CreditHold {
  readonly orderId: string;
  readonly stepKey: string;
  readonly customerId: string;
  /** In the base currency. */
  readonly amount: number;
  /** A backstop: past it the hold no longer counts, whatever became of the order. */
  readonly expiresAt: number;
}

/** Whether a hold stands, and what the customer has available now (0 for an unknown customer). */
export interface HoldResult {
  readonly held: boolean;
  readonly available: number;
}

export interface CreditAdjustment {
  /** Unique to the adjustment: applying one key twice moves the balance once. */
  readonly key: string;
  readonly customerId: string;
  /** Negative lowers what is owed (a credit memo, a payment received), positive raises it. */
  readonly amount: number;
  readonly reason: string;
  /** Who made it, as the ledger shows. */
  readonly by: string;
}

/** The id a hold gets: `hld_<orderId>_<stepKey>`, sanitized as a charge's is. */
export const creditHoldId = (orderId: string, stepKey: string) =>
  `hld_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');

/** The id an adjustment gets. */
export const creditAdjustmentId = (key: string) => `adj_${key}`.replace(/[^\w-]/g, '_');

export interface BalanceCharge {
  readonly orderId: string;
  readonly stepKey: string;
  readonly customerId: string;
  /** In the base currency, as credit limits are. */
  readonly amount: number;
}

/** The id a charge gets: `bal_<orderId>_<stepKey>`, with anything but word characters and `-` as `_`. */
export const balanceEntryId = (orderId: string, stepKey: string) =>
  `bal_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');

export interface BalanceStore {
  /**
   * Adds to the customer's balance once per order and step, and in the same batch converts the
   * order's credit holds into the charge. Returns the charge's entry id.
   */
  charge(charge: BalanceCharge): Promise<string>;
  /**
   * The charge's invoice was paid: takes it off the balance, unless it was already settled or
   * reversed. Returns whether this call moved the balance. An unknown or unapplied entry moves nothing.
   */
  settle(entryId: string): Promise<boolean>;
  /**
   * Compensation: takes the order's open charges back off the balance, each at most once and none
   * that a payment already settled. Returns how many this call reversed.
   */
  reverse(orderId: string): Promise<number>;
  /**
   * Claims `amount` of the customer's limit for the order's step, if limit less balance less
   * what is held covers it: the check and the hold are one atomic step, so two orders checked at
   * once can't together exceed the limit, and holds that expired no longer count. A retried step
   * finds its own hold and gets the same answer. Refused (`held: false`) for an unknown customer.
   */
  hold(hold: CreditHold): Promise<HoldResult>;
  /**
   * Gives back every hold the order still has, each at most once, and returns how many this call
   * released. Holds already charged, released or expired are left as they are.
   */
  releaseHolds(orderId: string): Promise<number>;
  /**
   * Records a credit memo, a payment received off the platform or a debit, once per key. Returns
   * the entry's id, or undefined for an unknown customer.
   */
  adjust(adjustment: CreditAdjustment): Promise<string | undefined>;
  /** Sets the customer's credit limit. Returns whether the customer exists. */
  setLimit(customerId: string, limit: number): Promise<boolean>;
  /** The customer's limit, balance and holds, or undefined for an unknown customer. */
  account(customerId: string): Promise<CreditAccount | undefined>;
  /**
   * The customer's ledger, newest first, `limit` at a time after `cursor`, each entry with the
   * balance it left. Adds one read to `account`'s, however deep the page.
   */
  ledger(
    customerId: string,
    cursor: LedgerCursor | undefined,
    limit: number,
  ): Promise<{ entries: LedgerEntry[]; next: LedgerCursor | null }>;
  /** The customer's balance, or undefined for an unknown customer. */
  balance(customerId: string): Promise<number | undefined>;
  /** Every ledger entry for the order: charges, settlements and reversals. */
  entries(orderId: string): Promise<BalanceEntry[]>;
}

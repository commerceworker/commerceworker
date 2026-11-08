/**
 * Customer balances: what a business customer owes on account. An invoice node charges the order
 * total to the balance, the invoice's payment settles that charge, and a rollback reverses it,
 * whichever of the two comes first. Every change is a ledger entry applied at most once, so a
 * retried step, a redelivered webhook or a rollback racing a payment moves the balance once.
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
  /** Adds to the customer's balance once per order and step. Returns the charge's entry id. */
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
  /** The customer's balance, or undefined for an unknown customer. */
  balance(customerId: string): Promise<number | undefined>;
  /** Every ledger entry for the order: charges, settlements and reversals. */
  entries(orderId: string): Promise<BalanceEntry[]>;
}

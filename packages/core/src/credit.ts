/**
 * A business customer's credit account: what is owed (`balance`, which moves at invoicing), what
 * open orders have claimed (`held`) and what is left. The hold is what makes the check safe: it is
 * taken in the same atomic step that checks the limit, so no interleaving of orders can together
 * exceed it. Money is in the base currency throughout, as limits are.
 */
import { defineLifecycle } from './lifecycle';
import { money, toBase } from './logic';

/** A credit hold: `held` until invoicing converts it to the charge, or it is given back. */
export const CREDIT_HOLD_STATES = ['held', 'charged', 'released', 'expired'] as const;
export type CreditHoldState = (typeof CREDIT_HOLD_STATES)[number];

export const CREDIT_HOLD = defineLifecycle<CreditHoldState>({
  held: ['charged', 'released', 'expired'],
  charged: [],
  released: [],
  expired: [],
});

/** A ledger entry's kind (`balance_entries.kind`). Entries are immutable; a reversal is a new row. */
export const CREDIT_ENTRY_KINDS = ['charge', 'settle', 'reverse', 'adjust'] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];

/** What a customer can still order on account: the limit less what is owed and what is held. */
export const creditAvailable = (a: { creditLimit: number; balance: number; held?: number }) =>
  money(a.creditLimit - a.balance - (a.held ?? 0));

/** What an order claims of the limit: its total in the base currency. */
export const creditHoldAmount = (order: { total: number; baseTotal?: number; fxRate?: number }) =>
  money(order.baseTotal ?? toBase(order.total, order.fxRate));

/** How long a hold lasts when the node names no time: a backstop for an order that never ends. */
export const DEFAULT_CREDIT_HOLD_DAYS = 30;

/** Why an adjustment can't be recorded, or null. A reason is required: it is the audit trail. */
export function creditAdjustmentProblem(a: { amount: number; reason: string }): string | null {
  if (!Number.isFinite(a.amount) || a.amount === 0) return 'The amount can’t be zero.';
  if (Math.abs(a.amount) > MAX_CREDIT_ADJUSTMENT) return 'That amount is out of range.';
  if (!a.reason.trim()) return 'Give a reason: it is what the ledger shows.';
  return null;
}

/** Why a limit can't be set, or null. */
export function creditLimitProblem(limit: number): string | null {
  if (!Number.isFinite(limit) || limit < 0 || limit > MAX_CREDIT_ADJUSTMENT)
    return 'A credit limit is zero or more.';
  return null;
}

export const MAX_CREDIT_ADJUSTMENT = 1_000_000_000;

/** The id a hold gets: `hld_<orderId>_<stepKey>`, sanitized as a charge's is. */
export const creditHoldId = (orderId: string, stepKey: string) =>
  `hld_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');

/** The id an adjustment gets. */
export const creditAdjustmentId = (key: string) => `adj_${key}`.replace(/[^\w-]/g, '_');

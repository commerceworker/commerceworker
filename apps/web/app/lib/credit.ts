/**
 * The customer page's credit forms, read: an amount typed as a person writes it ("1,250.50"), and
 * how each ledger entry reads. Pure; the engine's `set_credit_limit` and `adjust_credit` check
 * what these send.
 */
import type { CreditEntryKind } from '@commerceworker/core';

/** "1,250.50" or "$1250" as a number, or why it can't be read. Never negative: direction is chosen apart. */
export function amountFrom(text: string): number | string {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!t) return 'Enter an amount.';
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'An amount is digits with at most two decimals.';
  return Number(t);
}

/** How each kind of ledger entry reads. */
export const ENTRY_KINDS: Record<CreditEntryKind, string> = {
  charge: 'Invoiced',
  settle: 'Paid',
  reverse: 'Reversed',
  adjust: 'Adjustment',
};

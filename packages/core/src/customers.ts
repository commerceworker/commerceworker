/**
 * Customer rules every store applies the same way.
 */
import { money, toBase } from './logic';

/** A name as matching compares it: lower case, punctuation and runs of spacing folded to one space. */
export function customerNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The one candidate whose name is exactly `name`, ignoring case, spacing and punctuation. The name
 * often comes from a model reading a document anyone can write, so a near match, or one of several
 * matches, attaches nobody: the order then waits for a person to choose the customer.
 */
export function matchCustomerByName<T extends { name: string }>(
  candidates: readonly T[],
  name: string,
): T | undefined {
  const needle = customerNameKey(name);
  if (!needle) return undefined;
  const matches = candidates.filter((c) => customerNameKey(c.name) === needle);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A credit check (`commerce.credit_check`): a business customer's available credit (limit less
 * balance, both in the base currency) against the order's total in the base currency. A consumer
 * or a guest has no account; `noAccount` says whether that passes.
 */
export function creditCheck(
  customer: { kind: string; creditLimit: number; balance: number } | null | undefined,
  order: { total: number; baseTotal?: number; fxRate?: number },
  opts: { noAccount: 'ok' | 'over_limit' },
):
  | { ok: boolean; account: false }
  | { ok: boolean; account: true; available: number; total: number; over: number } {
  if (customer?.kind !== 'business') return { ok: opts.noAccount === 'ok', account: false };
  const available = money(customer.creditLimit - customer.balance);
  const total = order.baseTotal ?? toBase(order.total, order.fxRate);
  return { ok: total <= available, account: true, available, total, over: total - available };
}

/** The budget a `commerce.budget_check` node holds an order to when it names none (base currency). */
export const DEFAULT_ORDER_BUDGET = 25_000;

/** Whether an order's total, in the base currency, is within a budget (`commerce.budget_check`). */
export function budgetCheck(
  order: { total: number; baseTotal?: number; fxRate?: number },
  budget: number,
): { within: boolean; total: number } {
  const total = order.baseTotal ?? toBase(order.total, order.fxRate);
  return { within: total <= budget, total };
}

/**
 * Business customers' credit: the check an order makes (and the hold that makes it safe), giving
 * the hold back, and what staff do to an account (its limit, an adjustment) and read of it (the
 * limit, balance, what is held and the ledger). The credit-check node, the REST routes, the MCP
 * tools and the customer page all run these. Time comes in as an argument; the caller records the
 * audit draft.
 */
import {
  BASE_CURRENCY,
  creditAdjustmentProblem,
  creditCheck,
  creditHoldAmount,
  creditLimitProblem,
  money,
} from '@commerceworker/core';
import type {
  BalanceStore,
  CompanyDirectory,
  LedgerCursor,
  PricingStore,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export type CreditPorts = {
  readonly balances: BalanceStore;
  readonly pricing: Pick<PricingStore, 'customer'>;
  /** A business customer is its company: one that isn't active takes no new credit. */
  readonly companies: Pick<CompanyDirectory, 'company'>;
};

export type CreditChecked =
  | { ok: boolean; account: false; kind: string | null }
  | {
      ok: boolean;
      account: true;
      limit: number;
      balance: number;
      /** What was available to this order when it was checked, before its own hold. */
      available: number;
      total: number;
      over: number;
      /** Whether this order now holds its total (false for a refusal, or a check without a hold). */
      held: boolean;
      /** Why the check refused without comparing: the customer's company isn't active. */
      refused?: string;
    };

/**
 * The credit check. A consumer or a guest has no account (`noAccount` says whether that passes).
 * For a business customer with `hold` it is the guarded hold: the check and the claim are one
 * atomic step in the store, so orders checked at the same time can't together exceed the limit,
 * and a retried step finds its own hold. Without `hold` it only compares, as the check always did.
 * `expiresAt` is a backstop, for a hold nothing gave back.
 */
export async function holdCredit(
  ports: CreditPorts,
  order: { id: string; customerId?: string; total: number; baseTotal?: number; fxRate?: number },
  stepKey: string,
  opts: { noAccount: 'ok' | 'over_limit'; hold: boolean; expiresAt: number },
): Promise<CreditChecked> {
  const customer = await ports.pricing.customer(order.customerId);
  if (customer?.kind !== 'business') {
    return { ...creditCheck(customer, order, opts), account: false, kind: customer?.kind ?? null };
  }
  const total = creditHoldAmount(order);
  // An order from an inactive company is declined when it starts (`companyOrderProblem`); a flow
  // that gets here anyway (the company changed since) takes no credit either.
  const company = await ports.companies.company({ all: true }, customer.id);
  if (company && company.status !== 'active')
    return {
      ok: false,
      account: true,
      limit: customer.creditLimit,
      balance: customer.balance,
      available: 0,
      total,
      over: total,
      held: false,
      refused: `Company ${customer.id} isn't active (${company.status})`,
    };
  if (!opts.hold) {
    const held = (await ports.balances.account(customer.id))?.held ?? 0;
    const r = creditCheck({ ...customer, held }, order, opts);
    return r.account
      ? { ...r, limit: customer.creditLimit, balance: customer.balance, held: false }
      : { ...r, kind: customer.kind };
  }
  const r = await ports.balances.hold({
    orderId: order.id,
    stepKey,
    customerId: customer.id,
    amount: total,
    expiresAt: opts.expiresAt,
  });
  // `available` after a hold excludes it; report what the order saw.
  const available = money(r.held ? r.available + total : r.available);
  return {
    ok: r.held,
    account: true,
    limit: customer.creditLimit,
    balance: customer.balance,
    available,
    total,
    over: total - available,
    held: r.held,
  };
}

/** Gives back the credit an order holds: its rollback, a cancel, and every end but an invoice. */
export const releaseCredit = (ports: Pick<CreditPorts, 'balances'>, orderId: string) =>
  ports.balances.releaseHolds(orderId);

const refuse = (error: string) => ({ ok: false as const, error });

const NOT_ON_ACCOUNT = 'Only a business customer has a credit account.';

/** A business customer, or why there is none. */
async function accountOf(ports: CreditPorts, customerId: string) {
  const customer = await ports.pricing.customer(customerId);
  if (!customer) return refuse('No such customer.');
  if (customer.kind !== 'business') return refuse(NOT_ON_ACCOUNT);
  return { ok: true as const, customer };
}

const cursorOf = (after: string | undefined): LedgerCursor | undefined | 'invalid' => {
  if (!after) return undefined;
  const at = after.indexOf(':');
  const ms = Number(after.slice(0, at));
  return at > 0 && Number.isFinite(ms) && at < after.length - 1
    ? { at: ms, id: after.slice(at + 1) }
    : 'invalid';
};

/**
 * The customer's credit: limit, balance, what open orders hold, what is available, and a page of
 * the ledger, newest first. `next` pages back; null at the end. An unknown or consumer customer is
 * refused.
 */
export async function getCreditAccount(
  ports: CreditPorts,
  customerId: string,
  page: { after?: string; limit?: number } = {},
) {
  const found = await accountOf(ports, customerId);
  if (!found.ok) return found;
  const cursor = cursorOf(page.after);
  if (cursor === 'invalid') return refuse('That page cursor isn’t one this ledger gave.');
  const [account, ledger] = await Promise.all([
    ports.balances.account(customerId),
    ports.balances.ledger(customerId, cursor, Math.min(Math.max(page.limit ?? 25, 1), 100)),
  ]);
  if (!account) return refuse('No such customer.');
  return {
    ok: true as const,
    value: {
      customerId,
      ...account,
      currency: BASE_CURRENCY,
      entries: ledger.entries,
      next: ledger.next ? `${ledger.next.at}:${ledger.next.id}` : null,
    },
  };
}

/** A company that is suspended, closed or rejected has its limit left as it was. */
const FROZEN = ['suspended', 'closed', 'rejected'];

/** What setting a limit would do, for a preview: the account now, and why it can't go ahead. */
export async function planCreditLimit(ports: CreditPorts, customerId: string, limit: number) {
  const found = await accountOf(ports, customerId);
  if (!found.ok) return { current: null, problem: found.error };
  const company = await ports.companies.company({ all: true }, customerId);
  return {
    current: (await ports.balances.account(customerId)) ?? null,
    problem:
      company && FROZEN.includes(company.status)
        ? `Company ${customerId} is ${company.status}: reinstate it before changing its credit limit.`
        : creditLimitProblem(limit),
  };
}

/** Sets a business customer's credit limit. Orders already holding credit keep their holds. */
export async function setCreditLimit(
  ports: CreditPorts,
  input: { customerId: string; limit: number },
  by: string,
) {
  const planned = await planCreditLimit(ports, input.customerId, input.limit);
  if (planned.problem || !planned.current) return refuse(planned.problem ?? 'No such customer.');
  if (!(await ports.balances.setLimit(input.customerId, input.limit)))
    return refuse('No such customer.');
  const audit: AuditDraft = {
    action: 'credit.limit_set',
    target: input.customerId,
    detail: { from: planned.current.limit, to: input.limit, by },
  };
  return { ok: true as const, previous: planned.current.limit, limit: input.limit, audit };
}

/** Why an adjustment can't be recorded, or null, for a preview. */
export async function planCreditAdjustment(
  ports: CreditPorts,
  input: { customerId: string; amount: number; reason: string },
) {
  const found = await accountOf(ports, input.customerId);
  if (!found.ok) return { current: null, problem: found.error };
  return {
    current: (await ports.balances.account(input.customerId)) ?? null,
    problem: creditAdjustmentProblem(input),
  };
}

/**
 * Records a credit memo or a payment received off the platform (negative), or a debit (positive),
 * as an immutable ledger entry with its reason. `key` is unique to the request, so a retry records
 * it once; undoing one is another adjustment.
 */
export async function adjustCredit(
  ports: CreditPorts,
  input: { customerId: string; amount: number; reason: string },
  key: string,
  by: string,
) {
  const planned = await planCreditAdjustment(ports, input);
  if (planned.problem || !planned.current) return refuse(planned.problem ?? 'No such customer.');
  const entryId = await ports.balances.adjust({
    key,
    customerId: input.customerId,
    amount: input.amount,
    reason: input.reason.trim(),
    by,
  });
  if (!entryId) return refuse('No such customer.');
  const balance =
    (await ports.balances.account(input.customerId))?.balance ?? planned.current.balance;
  const audit: AuditDraft = {
    action: 'credit.adjusted',
    target: input.customerId,
    detail: { entry: entryId, amount: input.amount, reason: input.reason.trim(), balance },
  };
  return { ok: true as const, entryId, balance, audit };
}

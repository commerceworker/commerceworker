/**
 * Subscriptions: the lifecycle state machine and calendar-correct billing periods. Pure, so the
 * subscription flow's renewal wait, the admin and the API agree on what a subscription can do next
 * and when it renews. Ported from Commerce Worker v1 (its `packages/subscriptions`), whose store
 * and provider code stays behind: payments run through the flow's charge nodes.
 */

/** Billing interval unit. */
export type SubscriptionInterval = 'day' | 'week' | 'month' | 'year';

/** Subscription lifecycle status. */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'paused'
  | 'past_due'
  | 'canceled'
  | 'expired';

/** History action recorded when a subscription state change occurs. */
export type SubscriptionAction =
  | 'created'
  | 'renewed'
  | 'paused'
  | 'resumed'
  | 'canceled'
  | 'expired'
  | 'payment_failed'
  | 'payment_succeeded'
  | 'updated';

/**
 * Move `date` to the given month (and optionally year), keeping its day-of-month but clamping to
 * the last valid day of the target month.
 *
 * `setUTCMonth` alone overflows instead of clamping: 31 January + 1 month becomes 31 February,
 * which normalises to 3 March. That skipped February entirely and moved the subscription's billing
 * anchor to the 3rd permanently — every subscription created on the 29th, 30th or 31st drifted.
 * Setting the day to 1 first makes the month assignment unambiguous, then the day is restored
 * against the real length of the target month, so 31 Jan → 28 Feb → 31 Mar.
 */
function clampedAdvance(date: Date, targetMonth: number, targetYear?: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (targetYear !== undefined) date.setUTCFullYear(targetYear);
  date.setUTCMonth(targetMonth);
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

/** Advance `from` by one billing period (UTC calendar math). */
export function advancePeriod(
  from: Date,
  intervalUnit: SubscriptionInterval,
  intervalCount: number,
): Date {
  const next = new Date(from);
  switch (intervalUnit) {
    case 'day':
      next.setUTCDate(next.getUTCDate() + intervalCount);
      break;
    case 'week':
      next.setUTCDate(next.getUTCDate() + intervalCount * 7);
      break;
    case 'month':
      clampedAdvance(next, next.getUTCMonth() + intervalCount);
      break;
    case 'year':
      clampedAdvance(next, next.getUTCMonth(), next.getUTCFullYear() + intervalCount);
      break;
  }
  return next;
}

/**
 * Valid subscription state transitions.
 *
 * ```
 * trialing  → active, canceled, expired
 * active    → paused, past_due, canceled
 * paused    → active, canceled
 * past_due  → active, canceled, expired
 * canceled  → expired
 * expired   → (terminal)
 * ```
 */
const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  trialing: ['active', 'canceled', 'expired'],
  active: ['paused', 'past_due', 'canceled'],
  paused: ['active', 'canceled'],
  past_due: ['active', 'canceled', 'expired'],
  canceled: ['expired'],
  expired: [],
};

/** Check whether a status transition is valid. */
export function canSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * Assert a transition is valid and return the new status.
 * Throws if the transition is not allowed.
 */
export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  if (!canSubscriptionTransition(from, to)) {
    throw new Error(`Invalid subscription transition: ${from} → ${to}`);
  }
}

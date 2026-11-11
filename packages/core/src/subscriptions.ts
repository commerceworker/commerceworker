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

/** The longest a period of each unit can be, so the search below never starts past the answer. */
const LONGEST_PERIOD_MS: Record<SubscriptionInterval, number> = {
  day: 86_400_000,
  week: 604_800_000,
  month: 31 * 86_400_000,
  year: 366 * 86_400_000,
};

/** The most units one period may span: a hundred years of each, which no billing cycle nears. */
export const MAX_PERIOD_COUNT: Record<SubscriptionInterval, number> = {
  day: 36_500,
  week: 5_200,
  month: 1_200,
  year: 100,
};

/** The latest instant a JavaScript Date holds (±8.64e15 ms from the epoch). */
const MAX_DATE_MS = 8.64e15;

/** True for an epoch-ms a Date can represent. */
export const inDateRange = (ms: number): boolean =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

/**
 * The first period boundary at or after the anchor that is still ahead of `now`, for a schedule that
 * starts at `anchor` and repeats every `intervalCount` units. An anchor still in the future is itself
 * the first boundary (a trial's end renews then, not a period later). Each boundary is
 * `advancePeriod` from the anchor itself, never from the boundary before: chaining would carry
 * February's clamp into March (31 Jan → 28 Feb → 28 Mar), where counting from the anchor gives
 * 31 Jan → 28 Feb → 31 Mar. A pure function of its inputs, so the renewal wait can compute it once
 * in a step and replay the same instant. Throws a RangeError for an anchor or `now` a Date can't
 * hold, a count that isn't a whole number of 1 to `MAX_PERIOD_COUNT`, or a boundary past the end of
 * time, rather than searching for one forever.
 */
export function nextPeriodBoundary(
  anchor: Date | number,
  intervalUnit: SubscriptionInterval,
  intervalCount: number,
  now: Date | number,
): number {
  const anchorMs = new Date(anchor).getTime();
  const at = new Date(now).getTime();
  if (!(intervalUnit in MAX_PERIOD_COUNT)) throw new RangeError(`Unknown period “${intervalUnit}”`);
  if (!inDateRange(anchorMs)) throw new RangeError('The anchor is not a date');
  if (!inDateRange(at)) throw new RangeError('The clock is not a date');
  if (
    !Number.isInteger(intervalCount) ||
    intervalCount < 1 ||
    intervalCount > MAX_PERIOD_COUNT[intervalUnit]
  )
    throw new RangeError(
      `A period is 1 to ${MAX_PERIOD_COUNT[intervalUnit]} ${intervalUnit}s, not ${intervalCount}`,
    );
  if (anchorMs > at) return anchorMs;
  const start = new Date(anchorMs);
  // Skip whole periods that can't have ended yet; a period is never longer than the bound.
  let k = Math.max(
    1,
    Math.floor((at - anchorMs) / (intervalCount * LONGEST_PERIOD_MS[intervalUnit])),
  );
  for (;;) {
    const boundary = advancePeriod(start, intervalUnit, intervalCount * k).getTime();
    // An Invalid Date compares false with everything, so it would loop for good.
    if (Number.isNaN(boundary)) throw new RangeError('The next period is past the end of time');
    if (boundary > at) return boundary;
    k++;
  }
}

/**
 * A calendar wait's deadline, `at` (the real boundary) and `wake` (when to sleep until). Under a demo
 * `scale`, time since the anchor runs `scale` times faster, so each renewal still reports the next
 * calendar date while waiting a scaled fraction of it; the sleep is never under one second.
 */
export function calendarWait(
  anchor: number,
  intervalUnit: SubscriptionInterval,
  intervalCount: number,
  now: number,
  scale = 1,
): { at: number; wake: number } {
  const speed = Math.max(1, scale);
  const at = nextPeriodBoundary(
    anchor,
    intervalUnit,
    intervalCount,
    anchor + (now - anchor) * speed,
  );
  return { at, wake: Math.max(now + 1000, Math.round(anchor + (at - anchor) / speed)) };
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

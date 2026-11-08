/**
 * Billing period advance.
 *
 * Every renewal moves the period forward through here, so an off-by-one interval is an off-by-one
 * charge. The calendar arithmetic is deliberately UTC — a local-time implementation would shift a
 * subscription's billing date by a day twice a year across a DST boundary.
 */
import { describe, expect, it } from 'vitest';
import { advancePeriod } from '../src/subscriptions';

describe('advancePeriod', () => {
  it('advances by day', () => {
    const from = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    expect(advancePeriod(from, 'day', 1).toISOString()).toBe(
      new Date(Date.UTC(2024, 0, 16, 12, 0, 0)).toISOString(),
    );
  });

  it('advances by week as seven days', () => {
    const from = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    expect(advancePeriod(from, 'week', 1).toISOString()).toBe(
      new Date(Date.UTC(2024, 0, 22, 12, 0, 0)).toISOString(),
    );
  });

  it('advances by month in UTC', () => {
    const from = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    const next = advancePeriod(from, 'month', 1);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2024, 1, 15, 12, 0, 0)).toISOString());
  });

  it('advances by year', () => {
    const from = new Date(Date.UTC(2023, 5, 15, 0, 0, 0));
    const next = advancePeriod(from, 'year', 1);
    expect(next.getUTCFullYear()).toBe(2024);
  });

  it('multiplies the interval count', () => {
    const from = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(advancePeriod(from, 'week', 3).toISOString()).toBe(
      new Date(Date.UTC(2024, 0, 22)).toISOString(),
    );
    expect(advancePeriod(from, 'month', 3).toISOString()).toBe(
      new Date(Date.UTC(2024, 3, 1)).toISOString(),
    );
  });

  it('does not mutate the date it was given', () => {
    // The caller reuses `sub.currentPeriodEnd` as the new period start, so mutating in place
    // would collapse the period to zero length.
    const from = new Date(Date.UTC(2024, 0, 15));
    const before = from.toISOString();
    advancePeriod(from, 'month', 1);
    expect(from.toISOString()).toBe(before);
  });

  it('clamps a month-end date to the last day of a shorter month', () => {
    // Regression: `setUTCMonth` overflows rather than clamping, so 31 Jan + 1 month became 31 Feb
    // and normalised to 3 March — February was skipped entirely.
    const jan31 = new Date(Date.UTC(2023, 0, 31));
    expect(advancePeriod(jan31, 'month', 1).toISOString()).toBe(
      new Date(Date.UTC(2023, 1, 28)).toISOString(),
    );
  });

  it('clamps to 29 February in a leap year', () => {
    const jan31 = new Date(Date.UTC(2024, 0, 31));
    expect(advancePeriod(jan31, 'month', 1).toISOString()).toBe(
      new Date(Date.UTC(2024, 1, 29)).toISOString(),
    );
  });

  it('recovers the original day when advancing from the original date', () => {
    const jan31 = new Date(Date.UTC(2023, 0, 31));
    expect(advancePeriod(jan31, 'month', 2).toISOString()).toBe(
      new Date(Date.UTC(2023, 2, 31)).toISOString(),
    );
  });

  it('keeps the clamped day when advancing from an already-clamped date', () => {
    // A known limitation, pinned so it is not mistaken for a regression. `renewSubscription`
    // advances from the previous `currentPeriodEnd`, so cycles chain: 31 Jan → 28 Feb → 28 Mar,
    // and the anchor settles on the 28th rather than returning to the 31st.
    //
    // This function cannot do better on its own — it only sees one date, and 28 Feb is
    // indistinguishable from a subscription genuinely anchored on the 28th. Restoring the 31st
    // needs an explicit billing anchor stored on the subscription, which is a schema change.
    // The severe half of the bug is fixed either way: no month is ever skipped.
    const feb28 = advancePeriod(new Date(Date.UTC(2023, 0, 31)), 'month', 1);
    expect(advancePeriod(feb28, 'month', 1).toISOString()).toBe(
      new Date(Date.UTC(2023, 2, 28)).toISOString(),
    );
  });

  it('never skips a month', () => {
    // Walk a year from the 31st; every step must land in the next calendar month.
    let d = new Date(Date.UTC(2023, 0, 31));
    const months: number[] = [];
    for (let i = 0; i < 12; i++) {
      d = advancePeriod(d, 'month', 1);
      months.push(d.getUTCMonth());
    }
    expect(months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0]);
  });

  it('preserves the time of day across a clamped month', () => {
    const jan31 = new Date(Date.UTC(2023, 0, 31, 9, 30, 15));
    expect(advancePeriod(jan31, 'month', 1).toISOString()).toBe(
      new Date(Date.UTC(2023, 1, 28, 9, 30, 15)).toISOString(),
    );
  });

  it('clamps a leap day to 28 February in a common year', () => {
    const leapDay = new Date(Date.UTC(2024, 1, 29));
    expect(advancePeriod(leapDay, 'year', 1).toISOString()).toBe(
      new Date(Date.UTC(2025, 1, 28)).toISOString(),
    );
  });

  it('keeps an ordinary date unchanged by the clamp', () => {
    const mid = new Date(Date.UTC(2023, 0, 15, 12, 0, 0));
    expect(advancePeriod(mid, 'month', 1).toISOString()).toBe(
      new Date(Date.UTC(2023, 1, 15, 12, 0, 0)).toISOString(),
    );
    expect(advancePeriod(mid, 'year', 1).toISOString()).toBe(
      new Date(Date.UTC(2024, 0, 15, 12, 0, 0)).toISOString(),
    );
  });
});

import {
  assertSubscriptionTransition as assertTransition,
  canSubscriptionTransition as canTransition,
  type SubscriptionStatus,
} from '../src/subscriptions';

describe('subscription state machine', () => {
  it('allows documented transitions', () => {
    const pairs: Array<[SubscriptionStatus, SubscriptionStatus]> = [
      ['trialing', 'active'],
      ['trialing', 'canceled'],
      ['active', 'paused'],
      ['active', 'past_due'],
      ['past_due', 'expired'],
      ['paused', 'active'],
      ['canceled', 'expired'],
    ];
    for (const [from, to] of pairs) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('expired', 'active')).toBe(false);
    expect(canTransition('canceled', 'active')).toBe(false);
  });

  it('assertTransition throws on invalid', () => {
    expect(() => assertTransition('expired', 'active')).toThrow(/Invalid subscription transition/);
  });
});

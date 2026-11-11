/**
 * Billing period advance.
 *
 * Every renewal moves the period forward through here, so an off-by-one interval is an off-by-one
 * charge. The calendar arithmetic is deliberately UTC — a local-time implementation would shift a
 * subscription's billing date by a day twice a year across a DST boundary.
 */
import { describe, expect, it } from 'vitest';
import { advancePeriod, calendarWait, nextPeriodBoundary } from '../src/subscriptions';

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

describe('nextPeriodBoundary', () => {
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 9);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('walks 31 Jan to the end of February, then back to the 31st', () => {
    const anchor = day(2024, 1, 31);
    const first = nextPeriodBoundary(anchor, 'month', 1, anchor);
    expect(iso(first)).toBe('2024-02-29');
    const second = nextPeriodBoundary(anchor, 'month', 1, first);
    expect(iso(second)).toBe('2024-03-31');
    // A non-leap year clamps to the 28th, and April's 30th is its own clamp, not a drift from March.
    const plain = day(2023, 1, 31);
    expect(iso(nextPeriodBoundary(plain, 'month', 1, plain))).toBe('2023-02-28');
    expect(iso(nextPeriodBoundary(plain, 'month', 1, day(2023, 3, 31)))).toBe('2023-04-30');
  });

  it('is the boundary strictly after now, so a wake at the boundary waits for the next', () => {
    const anchor = day(2024, 1, 15);
    expect(nextPeriodBoundary(anchor, 'month', 1, day(2024, 2, 15) - 1)).toBe(day(2024, 2, 15));
    expect(nextPeriodBoundary(anchor, 'month', 1, day(2024, 2, 15))).toBe(day(2024, 3, 15));
  });

  it('counts periods and units from the anchor', () => {
    const anchor = day(2024, 1, 31);
    expect(iso(nextPeriodBoundary(anchor, 'month', 3, anchor))).toBe('2024-04-30');
    expect(iso(nextPeriodBoundary(anchor, 'week', 2, anchor))).toBe('2024-02-14');
    expect(iso(nextPeriodBoundary(day(2024, 2, 29), 'year', 1, day(2024, 3, 1)))).toBe(
      '2025-02-28',
    );
  });

  it('catches up across many elapsed periods without skipping an anchor day', () => {
    const anchor = day(2020, 1, 31);
    expect(iso(nextPeriodBoundary(anchor, 'month', 1, day(2026, 2, 10)))).toBe('2026-02-28');
    expect(iso(nextPeriodBoundary(anchor, 'month', 1, day(2026, 2, 28)))).toBe('2026-03-31');
    expect(iso(nextPeriodBoundary(anchor, 'day', 1, day(2024, 1, 1)))).toBe('2024-01-02');
  });

  it('takes an anchor still ahead as the first boundary, as a trial ending renews at its end', () => {
    const anchor = day(2099, 1, 31);
    expect(nextPeriodBoundary(anchor, 'month', 1, day(2026, 1, 1))).toBe(anchor);
    // Once the anchor has passed, the periods count from it.
    expect(iso(nextPeriodBoundary(anchor, 'month', 1, anchor))).toBe('2099-02-28');
  });

  it('throws on what a Date cannot hold, rather than searching forever', () => {
    const now = day(2026, 1, 1);
    expect(() => nextPeriodBoundary(1.7e18, 'month', 1, now)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(Number.NaN, 'month', 1, now)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'month', 1, 1.7e18)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'month', 5e6, now + 1)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'month', 0, now + 1)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'week', 1.5, now + 1)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'year', 101, now + 1)).toThrow(RangeError);
    // A boundary that overflows the Date range is an Invalid Date, which never exceeds `now`.
    expect(() => nextPeriodBoundary(8.64e15 - 1000, 'year', 1, 8.64e15 - 1)).toThrow(RangeError);
    expect(() => nextPeriodBoundary(now, 'fortnight' as never, 1, now + 1)).toThrow(RangeError);
  });
});

describe('calendarWait', () => {
  const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 9);

  it('wakes at the boundary itself at real time', () => {
    const anchor = at(2024, 1, 31);
    const now = at(2024, 2, 10);
    expect(calendarWait(anchor, 'month', 1, now)).toEqual({
      at: at(2024, 2, 29),
      wake: at(2024, 2, 29),
    });
  });

  it('under TIME_SCALE reports advancing dates and sleeps a scaled fraction of each', () => {
    const scale = 1000;
    const anchor = at(2024, 1, 31);
    // Wall time since the anchor, as the scale sees it: 31 Jan to 29 Feb in 1/1000 of the time.
    const boundaryAt = at(2024, 2, 29);
    const first = calendarWait(anchor, 'month', 1, anchor + 1, scale);
    expect(first.at).toBe(boundaryAt);
    expect(first.wake).toBe(Math.round(anchor + (boundaryAt - anchor) / scale));
    // Woken there, the next renewal is the next month, not the same instant again.
    const woke = first.wake;
    const second = calendarWait(anchor, 'month', 1, woke, scale);
    expect(new Date(second.at).toISOString().slice(0, 10)).toBe('2024-03-31');
    expect(second.wake).toBeGreaterThan(woke);
  });

  it('never sleeps under a second, and a future anchor wakes at it', () => {
    const now = at(2026, 1, 1);
    expect(calendarWait(now - 1, 'week', 1, now, 1e9).wake).toBe(now + 1000);
    const trialEnds = at(2026, 2, 1);
    expect(calendarWait(trialEnds, 'month', 1, now)).toEqual({ at: trialEnds, wake: trialEnds });
  });
});

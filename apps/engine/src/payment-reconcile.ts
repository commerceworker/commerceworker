/**
 * Hourly Stripe reconciliation (the engine's hourly cron). A webhook Stripe couldn't deliver (or the
 * web app dropped) leaves the ledger behind: this lists Stripe's `/v1/events` since a stored cursor,
 * for the types `handleStripeEvent` acts on, and offers each to that same handler, which claims the
 * event id first, so one a webhook already handled is a `duplicate` and nothing happens twice. It is
 * the one place a refund or capture made in Stripe's dashboard reaches the ledger if its webhook is
 * lost.
 *
 * Stripe lists newest first and keeps events 30 days. A window is read page by page (at most
 * `MAX_PAGES`) and reversed, so events are applied in the order they happened, ties included. When a
 * window is more than that, the pages are the newest of it: the window is narrowed to end at the
 * oldest second read (`created[lt]`) and read again, until one fits, and the oldest such window is
 * applied; the cursor then stops inside it, and the next pass carries on from there, so no event is
 * skipped however many there are. The cursor is the `created` of the oldest event not finished with:
 * one whose handling threw, or that answered `retry` (say a refund whose capture hasn't been applied)
 * within Stripe's own three days of redelivery. It stays there until a pass finishes it, otherwise it
 * moves to just behind the newest event applied; listing is inclusive and the claim makes a repeat
 * free. A difference the handler can't fix (`mismatch`) is logged at error level and counted, once,
 * since its event is claimed.
 *
 * An event whose handling throws is counted by the handler; the fifth failure marks it `poisoned`
 * (logged once as `stripe_event_poisoned`, counted as `reconcile_mismatch` with `what: poisoned`), and
 * from then on it is a duplicate, so it no longer holds the cursor and the pass stops re-reading up to
 * 29 days of Stripe's events for it. A claim whose handler died (still `processing` after ten minutes)
 * is taken again by the next pass; until then it answers `retry` and holds the cursor.
 */
import { stripeFor, stripeMode } from './gateway';
import { ops } from './metrics';
import { HANDLED_EVENT_TYPES, handleStripeEvent } from './payment-events';
import { paymentEventLog } from './wire';

const DAY = 86_400;
/** Where the first pass starts: what a webhook may still be retrying, with room to spare. */
const FIRST_LOOKBACK = 3 * DAY;
/** Stripe keeps events 30 days; asking for older ones is refused. */
const MAX_LOOKBACK = 29 * DAY;
/** Pages of 100 per read of a window. */
const MAX_PAGES = 50;
/** An event that throws this many times is set aside, so the cursor moves past it. */
export const POISON_AFTER = 5;
/** The cursor stays this far behind the newest event, in case Stripe lists one late. */
const SETTLE = 300;

export type ReconcileSummary = {
  seen: number;
  handled: number;
  duplicate: number;
  mismatched: number;
  /** Events that reached `POISON_AFTER` failures in this pass and were set aside. */
  poisoned: number;
  unresolved: number;
  failed: number;
  cursor?: number;
};

export async function reconcileStripe(
  env: Env,
  nowMs = Date.now(),
  /** Pages per window; the tests make it small. */
  maxPages = MAX_PAGES,
): Promise<ReconcileSummary | 'off'> {
  if (!stripeMode(env)) return 'off';
  const stripe = stripeFor(env);
  const log = paymentEventLog(env);
  const now = Math.floor(nowMs / 1000);
  const stored = await log.cursor('stripe');
  const since = Math.max(stored ?? now - FIRST_LOOKBACK, now - MAX_LOOKBACK);

  type Listed = Awaited<ReturnType<typeof stripe.events.list>>['data'];
  /** The window's events, newest first, and whether the page cap cut off its older end. */
  const readWindow = async (upper?: number) => {
    const got: Listed = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await stripe.events.list({
        created: { gte: since, ...(upper === undefined ? {} : { lt: upper }) },
        types: [...HANDLED_EVENT_TYPES],
        limit: 100,
        starting_after: after,
      });
      got.push(...res.data);
      after = res.data.at(-1)?.id;
      if (!res.has_more || !after) return { got, capped: false };
    }
    return { got, capped: true };
  };
  let window = await readWindow();
  let upper: number | undefined;
  while (window.capped) {
    const next = (window.got.at(-1)?.created ?? since) + 1;
    if (upper !== undefined && next >= upper) {
      // More than a window's worth in one second: nothing narrower to ask for.
      console.error(JSON.stringify({ type: 'stripe_reconcile_capped', since, upper }));
      break;
    }
    upper = next;
    window = await readWindow(upper);
  }
  // Oldest first, as they happened (Stripe's order within a second is kept, reversed).
  const events = window.got.reverse();

  const summary: ReconcileSummary = {
    seen: events.length,
    handled: 0,
    duplicate: 0,
    mismatched: 0,
    poisoned: 0,
    unresolved: 0,
    failed: 0,
  };
  let blocked: number | undefined;
  for (const ev of events) {
    try {
      const r = await handleStripeEvent(
        env,
        { provider: 'stripe', id: ev.id, type: ev.type, data: ev.data },
        nowMs,
        POISON_AFTER,
      );
      if (r.outcome === 'duplicate') summary.duplicate++;
      else if (r.poisoned) summary.poisoned++;
      else summary.handled++;
      if (r.mismatch) {
        summary.mismatched++;
        console.error(
          JSON.stringify({
            type: 'stripe_reconcile_mismatch',
            event: ev.id,
            eventType: ev.type,
            orderId: r.orderId,
            reason: r.reason,
          }),
        );
        ops().reconcileMismatch('stripe');
      }
      if (r.outcome === 'retry' && ev.created > now - FIRST_LOOKBACK) {
        summary.unresolved++;
        blocked ??= ev.created;
      }
    } catch (err) {
      console.error(
        JSON.stringify({ type: 'stripe_reconcile_failed', event: ev.id, eventType: ev.type }),
        err,
      );
      summary.failed++;
      summary.unresolved++;
      blocked ??= ev.created;
    }
  }
  const newest = events.at(-1)?.created ?? now;
  // Inside a narrowed window the newer events are still to come: stop at the newest one applied.
  const cursor = Math.max(since, Math.min(blocked ?? newest, now - SETTLE));
  await log.advance('stripe', cursor, nowMs);
  summary.cursor = cursor;
  // After the cursor is saved: the events that threw are tried again next hour, and the run shows as failed.
  if (summary.failed) throw new Error(`Stripe reconciliation: ${summary.failed} events failed`);
  return summary;
}

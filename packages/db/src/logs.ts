/**
 * The logs ports (`IntakeLog`, `PaymentEventLog`, `UsageStore`, @commerceworker/ports/commerce) on
 * D1: `inbound_emails`, `payment_events` and `ai_usage`. Moved here from the engine. The contract
 * in @commerceworker/test-kit/commerce holds these and the in-memory stores to the same behaviour.
 */
import type {
  IntakeLog,
  PaymentEventLog,
  UsageStore,
  WebhookReceipts,
} from '@commerceworker/ports/commerce';
import { and, eq, lt, lte, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { aiUsage, inboundEmails, paymentCursors, paymentEvents, webhookReceipts } from './schema';

export function d1IntakeLog(d1: D1Database): IntakeLog {
  const d = createDb(d1);
  return {
    async record(e) {
      await d.insert(inboundEmails).values(e).onConflictDoNothing();
    },
  };
}

export function d1PaymentEventLog(d1: D1Database): PaymentEventLog {
  const d = createDb(d1);
  return {
    async claim(id, provider, type, now, staleMs) {
      // One statement: a new id inserts, and a row that is `released`, or `processing` since before
      // `staleMs` ago, is taken over by the guarded UPDATE, so two takers can't both win.
      const claimed = await d
        .insert(paymentEvents)
        .values({ id, provider, type, receivedAt: now, status: 'processing', claimedAt: now })
        .onConflictDoUpdate({
          target: paymentEvents.id,
          set: { status: 'processing', claimedAt: now },
          setWhere: or(
            eq(paymentEvents.status, 'released'),
            and(
              eq(paymentEvents.status, 'processing'),
              lte(paymentEvents.claimedAt, now - staleMs),
            ),
          ),
        })
        .returning({ id: paymentEvents.id });
      if (claimed.length > 0) return 'claimed';
      const row = await d
        .select({ status: paymentEvents.status })
        .from(paymentEvents)
        .where(eq(paymentEvents.id, id))
        .get();
      return row?.status === 'poisoned'
        ? 'poisoned'
        : row?.status === 'done'
          ? 'done'
          : 'processing';
    },
    async link(id, orderId) {
      await d.update(paymentEvents).set({ orderId }).where(eq(paymentEvents.id, id));
    },
    async finish(id, outcome) {
      await d
        .update(paymentEvents)
        .set({ status: 'done', outcome })
        .where(eq(paymentEvents.id, id));
    },
    async release(id) {
      await d
        .update(paymentEvents)
        .set({ status: 'released' })
        .where(and(eq(paymentEvents.id, id), eq(paymentEvents.status, 'processing')));
    },
    async fail(id, poisonAfter) {
      // The count and the status move in one statement, so the failure that reaches the limit is the
      // only one that sees `poisoned`.
      const limit = poisonAfter ?? Number.MAX_SAFE_INTEGER;
      const row = await d
        .update(paymentEvents)
        .set({
          failures: sql`${paymentEvents.failures} + 1`,
          status: sql`CASE WHEN ${paymentEvents.failures} + 1 >= ${limit} THEN 'poisoned' ELSE 'released' END`,
        })
        .where(eq(paymentEvents.id, id))
        .returning({ failures: paymentEvents.failures, status: paymentEvents.status });
      const r = row[0];
      return { failures: r?.failures ?? 0, poisoned: r?.status === 'poisoned' };
    },
    async cursor(provider) {
      const row = await d
        .select({ cursor: paymentCursors.cursor })
        .from(paymentCursors)
        .where(eq(paymentCursors.provider, provider))
        .get();
      return row?.cursor;
    },
    async advance(provider, cursor, now) {
      await d
        .insert(paymentCursors)
        .values({ provider, cursor, updatedAt: now })
        .onConflictDoUpdate({
          target: paymentCursors.provider,
          set: { cursor: sql`MAX(${paymentCursors.cursor}, ${cursor})`, updatedAt: now },
        });
    },
  };
}

export function d1UsageStore(d1: D1Database): UsageStore {
  const d = createDb(d1);
  return {
    async tokens(principalId, day) {
      const row = await d
        .select({ tokens: aiUsage.tokens })
        .from(aiUsage)
        .where(and(eq(aiUsage.principalId, principalId), eq(aiUsage.day, day)))
        .get();
      return row?.tokens ?? 0;
    },
    async add(principalId, day, tokens) {
      await d
        .insert(aiUsage)
        .values({ principalId, day, tokens, calls: 1 })
        .onConflictDoUpdate({
          target: [aiUsage.principalId, aiUsage.day],
          set: { tokens: sql`${aiUsage.tokens} + ${tokens}`, calls: sql`${aiUsage.calls} + 1` },
        });
    },
    async prune(beforeDay) {
      const gone = await d
        .delete(aiUsage)
        .where(lt(aiUsage.day, beforeDay))
        .returning({ day: aiUsage.day });
      return gone.length;
    },
  };
}

export function d1WebhookReceipts(d1: D1Database): WebhookReceipts {
  const d = createDb(d1);
  return {
    async claim(id, now, ttlMs) {
      // Expired receipts go first, in the same batch: an old one never blocks a new claim.
      const [, claimed] = await d.batch([
        d.delete(webhookReceipts).where(lt(webhookReceipts.receivedAt, now - ttlMs)),
        d
          .insert(webhookReceipts)
          .values({ id, receivedAt: now })
          .onConflictDoNothing()
          .returning({ id: webhookReceipts.id }),
      ]);
      return claimed.length > 0;
    },
    async release(id) {
      await d.delete(webhookReceipts).where(eq(webhookReceipts.id, id));
    },
  };
}

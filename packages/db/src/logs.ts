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
import { and, eq, lt, sql } from 'drizzle-orm';
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
    async claim(id, provider, type, now) {
      const claimed = await d
        .insert(paymentEvents)
        .values({ id, provider, type, receivedAt: now })
        .onConflictDoNothing()
        .returning({ id: paymentEvents.id });
      return claimed.length > 0;
    },
    async link(id, orderId) {
      await d.update(paymentEvents).set({ orderId }).where(eq(paymentEvents.id, id));
    },
    async release(id) {
      await d.delete(paymentEvents).where(eq(paymentEvents.id, id));
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

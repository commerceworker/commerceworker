import { isWebhookSendRequest, type OutboxEntry } from '@commerceworker/domain';
import type { Queue } from '@commerceworker/ports';
import type { AppContext } from '../context';

/** Queue topic that carries relayed domain events to the worker dispatcher. */
export const EVENTS_TOPIC = 'commerceworker.events';

/**
 * Queue topic for bulk-job chunk processing. Isolated from the events topic
 * so a 100k-entry job's chunks never starve interactive event delivery (and
 * its consumer concurrency can be tuned independently against the database).
 */
export const BULK_TOPIC = 'commerceworker.bulk';

/** Default topic router: bulk chunk work → bulk topic, everything else (webhook send requests
 *  too) → events. Hosts without a bulk queue binding pass `routeTopic: () =>
 *  EVENTS_TOPIC` to keep single-topic operation. */
export function defaultRouteTopic(event: OutboxEntry): string {
  if (isWebhookSendRequest(event)) return EVENTS_TOPIC;
  return event.type === 'bulk.chunk_due' || event.type === 'environment.purge_due'
    ? BULK_TOPIC
    : EVENTS_TOPIC;
}

export interface RelayOptions {
  readonly batchSize?: number;
  /** Maps each event to its queue topic (default {@link defaultRouteTopic}). */
  readonly routeTopic?: (event: OutboxEntry) => string;
}

/**
 * Drains the transactional outbox: reads pending events, enqueues each onto
 * its topic, and marks them relayed. Because events were appended in the same
 * transaction as the state change, this guarantees at-least-once delivery with
 * no lost events. Returns the number relayed.
 *
 * The read + enqueue + mark run inside one transaction so concurrent relayers
 * (the post-commit nudge racing the cron sweeper or another isolate's nudge)
 * skip each other's claimed rows instead of double-enqueueing — `readPending` is a
 * lease claim (D1 has no row locks). A crash after enqueue
 * but before commit re-delivers (at-least-once), never loses.
 */
export async function relayOutbox(
  ctx: AppContext,
  queue: Queue,
  opts: RelayOptions = {},
): Promise<number> {
  const routeTopic = opts.routeTopic ?? defaultRouteTopic;
  return ctx.store.withTransaction(async (tx) => {
    const batch = await tx.outbox.readPending(opts.batchSize ?? 250);
    if (batch.length === 0) return 0;
    // Group by topic, one batched enqueue per topic. dedupeKey: queues that
    // support producer-side dedupe collapse the
    // crash-between-enqueue-and-commit redelivery; queues that don't
    // (Cloudflare Queues) ignore it — consumers stay idempotent.
    const byTopic = new Map<string, OutboxEntry[]>();
    for (const event of batch) {
      const topic = routeTopic(event);
      const list = byTopic.get(topic) ?? [];
      list.push(event);
      byTopic.set(topic, list);
    }
    for (const [topic, events] of byTopic) {
      await queue.enqueueMany(
        topic,
        events.map((event) => ({ payload: event, dedupeKey: event.id })),
      );
    }
    await tx.outbox.markRelayed(batch.map((e) => e.id));
    return batch.length;
  });
}

/**
 * Repeatedly relays until the outbox is empty or `maxIterations` is reached —
 * so a burst larger than one batch (a bulk publish) drains in one trigger
 * instead of waiting out successive cron ticks. Returns the total relayed.
 */
export async function drainOutbox(
  ctx: AppContext,
  queue: Queue,
  opts: RelayOptions & { maxIterations?: number } = {},
): Promise<number> {
  const maxIterations = opts.maxIterations ?? 10;
  let total = 0;
  for (let i = 0; i < maxIterations; i++) {
    const relayed = await relayOutbox(ctx, queue, opts);
    total += relayed;
    if (relayed === 0) break;
  }
  return total;
}

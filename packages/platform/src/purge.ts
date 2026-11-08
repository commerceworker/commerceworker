/**
 * A purge queue's consumer body: cache-tag purges, rationed to Cloudflare's limit (5 purge calls
 * a minute, up to 100 tags each). Workers Caching is per Worker, so each Worker that caches drains
 * its own queue with this: delivery `commerceworker-purge`, media `commerceworker-media-purge`.
 */
import type { PurgeMessage } from './messages';

/** Tags per purge call, and the pause after each call: Cloudflare allows 5 calls a minute. */
export const PURGE_TAGS = 100;
export const PURGE_PACE_MS = 12_000;
/**
 * Calls one batch makes before handing the rest back to the queue: 40 paced calls take 8 minutes,
 * well inside a consumer's 15. An urgent purge is never dropped for its age: a document stays
 * servable stale for a day (`stale-while-revalidate`), so a missed purge would mean the old
 * copy is served once more, perhaps hours later.
 */
export const PURGE_CALLS = 40;

/**
 * Seconds before a message handed back goes out again: `base`, doubling with each delivery, up to
 * `cap`. Every hand-back spends one of the queue's retries, so a backlog that keeps outrunning
 * the purge ration spreads out instead of reaching the dead-letter queue within minutes.
 */
export const backoff = (attempts: number, base: number, cap: number) =>
  Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);

/** `skipped`: nothing was purged (no Workers Caching here), so nothing was rationed either. */
type Purge = (tags: string[]) => Promise<{ success: boolean; skipped?: true }>;

/**
 * Purges a batch's tags, paced, oldest message first. A refused call retries what it didn't cover
 * once the bucket refills; after PURGE_CALLS calls the rest goes back to the queue. Both back off
 * with the message's attempts.
 */
export async function drain(
  batch: MessageBatch<PurgeMessage>,
  purge: Purge,
  wait: (ms: number) => Promise<void> = (ms) => scheduler.wait(ms),
): Promise<void> {
  const queue = [...batch.messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const done = new Set<string>();
  let calls = 0;
  while (queue.length) {
    if (calls >= PURGE_CALLS) {
      for (const m of queue) m.retry({ delaySeconds: backoff(m.attempts, 12, 300) });
      return;
    }
    // Whole messages, up to PURGE_TAGS tags (one larger than that goes alone, split below).
    const take: Message<PurgeMessage>[] = [];
    const tags = new Set<string>();
    for (const m of queue) {
      const fresh = m.body.tags.filter((t) => !done.has(t) && !tags.has(t));
      if (take.length && tags.size + fresh.length > PURGE_TAGS) break;
      take.push(m);
      for (const t of fresh) tags.add(t);
    }
    if (!take.length) break;
    queue.splice(0, take.length);
    const all = [...tags];
    for (let i = 0; i < all.length; i += PURGE_TAGS) {
      const chunk = all.slice(i, i + PURGE_TAGS);
      const r = await purge(chunk);
      if (!r.success) {
        // Rate limited (or refused): try these again once the bucket refills.
        for (const m of [...take, ...queue])
          m.retry({ delaySeconds: backoff(m.attempts, 30, 900) });
        return;
      }
      calls++;
      for (const t of chunk) done.add(t);
      if (!r.skipped) await wait(PURGE_PACE_MS);
    }
    for (const m of take) m.ack();
  }
}

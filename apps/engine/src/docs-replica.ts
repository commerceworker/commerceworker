/**
 * The replica of the order documents bucket (`DOCS`): the queue consumer that applies R2's event
 * notifications to it, the consumer of its dead-letter queue, and the nightly reconcile Workflow
 * (apps/engine/wrangler.jsonc, rendered per deployment from the registry's `redundancy`; the
 * rules are in @commerceworker/application's `object-replica.ts`, the bucket access in wire.ts).
 *
 * A create copies the object, a delete moves the copy to `deleted/<date>/`. Both look at what the
 * buckets hold now, so a redelivered or reordered event is safe. An event that fails is retried; one
 * that fails for good lands in the dead-letter queue, is kept in the replica under `dlq/` and logged
 * at error level (the catalog's dead letters work the same way), and the reconcile finds the object
 * regardless.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type ReconcileReport,
  reconcileCopies,
  reconcileExtras,
  replicaDate,
  replicateDelete,
  replicateObject,
  reportKey,
  summarize,
} from '@commerceworker/application/commerce';
import { docsPrimary, docsReplica } from './wire';

/** The queue's base name, with the deployment's suffix after it; the dead-letter queue's has `-dlq` first. */
export const isDocsReplicaDlq = (queue: string) =>
  /^commerceworker-docs-replica-dlq(-|$)/.test(queue);
export const isDocsReplicaQueue = (queue: string) =>
  /^commerceworker-docs-replica(-|$)/.test(queue);

/** The part of R2's notification the consumer reads (docs: R2, "Event notifications"). */
type ObjectEvent = { action: string; object: { key: string }; eventTime?: string };

const CREATES = new Set(['PutObject', 'CopyObject', 'CompleteMultipartUpload']);
const DELETES = new Set(['DeleteObject', 'LifecycleDeletion']);

function eventOf(body: unknown): ObjectEvent | null {
  const e = body as Partial<ObjectEvent> | null;
  return e && typeof e.action === 'string' && typeof e.object?.key === 'string'
    ? (e as ObjectEvent)
    : null;
}

/** Seconds before the next delivery on a message's `attempts`th failure: 30, doubling, up to 15 minutes. */
const backoff = (attempts: number) => Math.min(30 * 2 ** Math.max(attempts - 1, 0), 900);

export async function applyObjectEvents(batch: MessageBatch, env: Env): Promise<void> {
  const primary = docsPrimary(env);
  const replica = docsReplica(env);
  await Promise.all(
    batch.messages.map(async (msg) => {
      const event = eventOf(msg.body);
      const key = event?.object.key;
      if (
        !event ||
        key === undefined ||
        !(CREATES.has(event.action) || DELETES.has(event.action))
      ) {
        // Retrying can't make it a different message.
        console.error(
          JSON.stringify({ type: 'docs_replica_unreadable', queue: batch.queue, id: msg.id }),
        );
        msg.ack();
        return;
      }
      try {
        if (CREATES.has(event.action)) {
          const outcome = await replicateObject(primary, replica, key);
          // A locked key whose copy differs: R2's lock won't let us replace it, and these keys are
          // written once, so a difference is something to look at.
          if (outcome === 'held')
            console.error(JSON.stringify({ type: 'docs_replica_held', key, id: msg.id }));
        } else {
          const at = event.eventTime ? new Date(event.eventTime) : msg.timestamp;
          await replicateDelete(primary, replica, key, replicaDate(at));
        }
        msg.ack();
      } catch (err) {
        console.warn(
          JSON.stringify({ type: 'docs_replica_retry', key, id: msg.id, attempts: msg.attempts }),
          err,
        );
        msg.retry({ delaySeconds: backoff(msg.attempts) });
      }
    }),
  );
}

/** Keeps each dead letter in the replica (`dlq/<queue>/<date>/<id>.json`), logs it, then acknowledges it. */
export async function keepDeadLetters(batch: MessageBatch, env: Env): Promise<void> {
  const replica = docsReplica(env);
  await Promise.all(
    batch.messages.map(async (msg) => {
      const key = `dlq/${batch.queue}/${replicaDate(msg.timestamp)}/${msg.id}.json`;
      try {
        await replica.write(
          key,
          JSON.stringify({
            queue: batch.queue,
            id: msg.id,
            timestamp: msg.timestamp.toISOString(),
            attempts: msg.attempts,
            body: msg.body,
          }),
          { contentType: 'application/json; charset=utf-8' },
        );
      } catch (err) {
        console.error(`dead letter ${msg.id} from ${batch.queue} not kept:`, err);
        msg.retry({ delaySeconds: backoff(msg.attempts) });
        return;
      }
      // Error level, so Workers Observability counts it among the Issues that alert.
      console.error(
        JSON.stringify({
          type: 'dlq_message',
          queue: batch.queue,
          id: msg.id,
          attempts: msg.attempts,
        }),
      );
      msg.ack();
    }),
  );
}

const COPY = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } } as const;

/**
 * Nightly: lists both buckets a page a step, copies what the replica lacks or holds stale, flags
 * what it holds that the primary doesn't, and writes `replica/<date>.json` into the replica.
 */
export class DocsReplicaReconcile extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const date = replicaDate(event.timestamp);
    const primary = docsPrimary(this.env);
    const replica = docsReplica(this.env);
    const startedAt = await step.do('start', async () => new Date().toISOString());

    const copies = {
      scanned: 0,
      copied: 0,
      held: [] as string[],
      failed: [] as { key: string; error: string }[],
    };
    let cursor: string | undefined;
    for (let n = 0; ; n++) {
      const page = await step.do(`copy#${n}`, COPY, () =>
        reconcileCopies(primary, replica, cursor),
      );
      copies.scanned += page.scanned;
      copies.copied += page.copied;
      copies.held.push(...page.held);
      copies.failed.push(...page.failed);
      cursor = page.cursor;
      if (!cursor) break;
    }

    const extras = { scanned: 0, keys: [] as string[] };
    cursor = undefined;
    for (let n = 0; ; n++) {
      const page = await step.do(`extras#${n}`, COPY, () =>
        reconcileExtras(primary, replica, cursor),
      );
      extras.scanned += page.scanned;
      extras.keys.push(...page.extras);
      cursor = page.cursor;
      if (!cursor) break;
    }

    return await step.do('report', COPY, async () => {
      const report: ReconcileReport = summarize(
        { date, startedAt, finishedAt: new Date().toISOString() },
        copies,
        extras,
      );
      await replica.write(reportKey(date), JSON.stringify(report), {
        contentType: 'application/json; charset=utf-8',
      });
      const line = JSON.stringify({
        type: 'docs_replica_reconcile',
        outcome: report.outcome,
        primary: report.primary,
        replica: report.replica,
        copied: report.copied,
        held: report.held.length,
        failed: report.failed.length,
        extras: report.extras.count,
      });
      // A copy that failed or can't be replaced is an error; extras are for an operator to look at.
      if (report.failed.length || report.held.length) console.error(line);
      else if (report.extras.count) console.warn(line);
      else console.log(line);
      return { date, outcome: report.outcome, copied: report.copied };
    });
  }
}

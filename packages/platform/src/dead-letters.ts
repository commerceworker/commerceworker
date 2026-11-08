/**
 * A dead-letter queue's consumer body: a message that used up its retries is logged and kept under
 * `dlq/` in the media bucket (30-day lifecycle rule, `scripts/provision.sh`), then acked.
 *
 * Bodies can carry customer content (`entry.published` has every field value), and a record outlives
 * the entry it came from, so a record holds only what identifies the message. That list is an
 * allowlist: a key nobody has reviewed, on a new event type too, is left out and named in `omitted`.
 * A domain event's content is still recoverable while its outbox row is kept, by its `id`
 * (docs/backup-and-restore.md).
 */
import type { R2BucketLike } from '@commerceworker/adapters/blob-r2';
import { redactCredentials } from '@commerceworker/redaction';

const IDENTIFYING_KEYS = new Set([
  'action',
  'assetId',
  'attempt',
  'bucket',
  'chunkId',
  'collectionId',
  'contentTypeApiId',
  'eTag',
  'entryId',
  'entryIds',
  'environmentId',
  'eventTime',
  'id',
  'inviteId',
  'jobId',
  'key',
  'kind',
  'linkId',
  'menuId',
  'nodeId',
  'occurredAt',
  'previousVersion',
  'promotionId',
  'releaseId',
  'rerun',
  'runId',
  'size',
  'spaceId',
  'tags',
  'taskId',
  'termId',
  'type',
  'version',
  'webhookId',
  'workflowId',
]);

/** Keys whose object value is read key by key, under the same list. */
const NESTED_KEYS = new Set(['event', 'object', 'scope']);

type Kept = string | number | boolean | null | readonly string[] | KeptObject;
interface KeptObject {
  readonly [key: string]: Kept;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keptValue(value: unknown): Kept | undefined {
  if (typeof value === 'string') return redactCredentials(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => redactCredentials(item));
  }
  return undefined;
}

function select(body: Record<string, unknown>, path: string, omitted: string[]): KeptObject {
  const kept: Record<string, Kept> = {};
  for (const [key, value] of Object.entries(body)) {
    const at = `${path}${key}`;
    if (NESTED_KEYS.has(key) && isObject(value)) {
      kept[key] = select(value, `${at}.`, omitted);
      continue;
    }
    const safe = IDENTIFYING_KEYS.has(key) ? keptValue(value) : undefined;
    if (safe === undefined) omitted.push(redactCredentials(at));
    else kept[key] = safe;
  }
  return kept;
}

/** What a dead-letter record keeps of a message body, and the keys it left out. */
export function redactDeadLetter(body: unknown): {
  readonly body: KeptObject;
  readonly omitted: readonly string[];
} {
  if (!isObject(body)) return { body: {}, omitted: ['(body)'] };
  const omitted: string[] = [];
  return { body: select(body, '', omitted), omitted };
}

/** Where a dead letter is kept: by queue and day, so an incident reads as one listing. */
export function deadLetterKey(queue: string, message: Pick<Message, 'id' | 'timestamp'>): string {
  return `dlq/${queue}/${message.timestamp.toISOString().slice(0, 10)}/${message.id}.json`;
}

/**
 * Logs and keeps each message, then acks it. A failed write hands the message back for the queue's
 * own retries (a dead-letter queue has no further queue, so it is dropped after them); the log line
 * comes first so that a message nothing could store still left a trace. `onRecorded` counts it.
 */
export async function recordDeadLetters(
  batch: MessageBatch,
  bucket: Pick<R2BucketLike, 'put'> | undefined,
  onRecorded: () => void,
): Promise<void> {
  for (const message of batch.messages) {
    const key = deadLetterKey(batch.queue, message);
    const record = {
      queue: batch.queue,
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      attempts: message.attempts,
      ...redactDeadLetter(message.body),
    };
    console.error(JSON.stringify({ msg: 'message dead-lettered', key, ...record }));
    try {
      await bucket?.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (err) {
      console.error(
        JSON.stringify({ msg: 'dead letter not stored', key, error: redactCredentials(err) }),
      );
      message.retry();
      continue;
    }
    onRecorded();
    message.ack();
  }
}

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { recordDeadLetters, redactDeadLetter } from '@commerceworker/platform/dead-letters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const timestamp = new Date('2026-11-04T10:00:00.000Z');
const scope = { spaceId: 'shop', environmentId: 'main' };
const published = {
  id: 'evt-1',
  type: 'entry.published',
  occurredAt: '2026-11-04T09:00:00.000Z',
  scope,
  entryId: 'entry-1',
  contentTypeApiId: 'article',
  version: 3,
  fields: { title: { 'en-US': 'Private draft title' } },
};

function batchOf(queue: string, body: unknown) {
  return createMessageBatch(queue, [{ id: 'dead-1', timestamp, attempts: 4, body }]);
}

afterEach(() => vi.restoreAllMocks());

describe('a dead letter', () => {
  it('is kept without its content, logged the same way and acked', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf('commerceworker-events-dlq', published);
    const ctx = createExecutionContext();
    await worker.queue(batch, env as never, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['dead-1']);

    const key = 'dlq/commerceworker-events-dlq/2026-11-04/dead-1.json';
    const text = await (await env.MEDIA_BUCKET.get(key))?.text();
    expect(JSON.parse(text ?? '{}')).toEqual({
      queue: 'commerceworker-events-dlq',
      id: 'dead-1',
      timestamp: timestamp.toISOString(),
      attempts: 4,
      body: {
        id: 'evt-1',
        type: 'entry.published',
        occurredAt: '2026-11-04T09:00:00.000Z',
        scope,
        entryId: 'entry-1',
        contentTypeApiId: 'article',
        version: 3,
      },
      omitted: ['fields'],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private draft title');
  });

  it('leaves out what a webhook retry’s event carries', () => {
    const { body, omitted } = redactDeadLetter({
      kind: 'webhook.retry',
      webhookId: 'hook-1',
      attempt: 2,
      event: published,
    });
    expect(body).toMatchObject({ kind: 'webhook.retry', event: { id: 'evt-1', scope } });
    expect(omitted).toEqual(['event.fields']);
  });

  it('leaves out a key nobody has reviewed, and any object under a kept key', () => {
    const { body, omitted } = redactDeadLetter({
      id: 'evt-2',
      type: 'something.new',
      summary: 'Written by a person',
      version: { nested: 'Written by a person' },
    });
    expect(body).toEqual({ id: 'evt-2', type: 'something.new' });
    expect(omitted).toEqual(['summary', 'version']);
  });

  it('masks a credential in a value it keeps', () => {
    const { body } = redactDeadLetter({ id: 'Bearer abcdefgh12345678' });
    expect(body).toEqual({ id: 'Bearer ***' });
  });

  it('keeps nothing of a body that is not an object', () => {
    expect(redactDeadLetter('a secret string')).toEqual({ body: {}, omitted: ['(body)'] });
  });

  it('goes back to the queue, uncounted, when the write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf('commerceworker-events-dlq', published);
    const counted = vi.fn();
    const bucket = { put: vi.fn().mockRejectedValue(new Error('storage down')) };
    await recordDeadLetters(batch, bucket, counted);
    const ctx = createExecutionContext();
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['dead-1']);
    expect(result.explicitAcks).toEqual([]);
    expect(counted).not.toHaveBeenCalled();
  });
});

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createR2ObjectBucket } from '@commerceworker/adapters/object-replica-r2';
import { describeObjectBucketContract } from '@commerceworker/test-kit/commerce';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { docsReader, documentStore } from '../src/wire';

const today = new Date().toISOString().slice(0, 10);
const QUEUE = 'commerceworker-docs-replica';
const DLQ = 'commerceworker-docs-replica-dlq';

// The real R2 binding, held to the same contract as the in-memory bucket (test-kit).
describeObjectBucketContract('R2 binding', async () => createR2ObjectBucket(env.DOCS_REPLICA));

let n = 0;
const event = (action: string, key: string, eventTime = new Date().toISOString()) => ({
  account: 'acct',
  action,
  bucket: 'commerceworker-docs',
  object: { key },
  eventTime,
});

/** Delivers messages to the Worker's `queue()` as Queues would, and returns what it did with them. */
async function deliver(queue: string, bodies: unknown[], over: Partial<Env> = {}) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body) => ({ id: `msg-${++n}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue!(batch, { ...env, ...over } as Env);
  return getQueueResult(batch, ctx);
}

const put = (key: string, body: string) =>
  env.DOCS.put(key, body, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: { kind: 'invoice' },
  });
const replicaText = async (key: string) => (await env.DOCS_REPLICA.get(key))?.text();

describe('the replica consumer', () => {
  it('copies a created object with its content type and metadata', async () => {
    await put('orders/rep-1/invoice.html', '<p>invoice</p>');
    const result = await deliver(QUEUE, [event('PutObject', 'orders/rep-1/invoice.html')]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    const copy = await env.DOCS_REPLICA.get('orders/rep-1/invoice.html');
    expect(await copy!.text()).toBe('<p>invoice</p>');
    expect(copy!.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
    expect(copy!.customMetadata?.kind).toBe('invoice');
    expect(copy!.customMetadata?.['cw-source-etag']).toBe(
      (await env.DOCS.head('orders/rep-1/invoice.html'))!.etag,
    );
  });

  it('is idempotent: a replayed event copies nothing and changes nothing', async () => {
    await put('orders/rep-2/a.html', 'one');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-2/a.html')]);
    const first = await env.DOCS_REPLICA.head('orders/rep-2/a.html');
    const result = await deliver(QUEUE, [
      event('PutObject', 'orders/rep-2/a.html'),
      event('CompleteMultipartUpload', 'orders/rep-2/a.html'),
    ]);
    expect(result.explicitAcks).toHaveLength(2);
    const again = await env.DOCS_REPLICA.head('orders/rep-2/a.html');
    expect(again!.etag).toBe(first!.etag);
    expect(again!.uploaded.getTime()).toBe(first!.uploaded.getTime());
  });

  it('refreshes the copy when the object is overwritten', async () => {
    await put('orders/rep-3/a.html', 'one');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-3/a.html')]);
    await put('orders/rep-3/a.html', 'two, longer');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-3/a.html')]);
    expect(await replicaText('orders/rep-3/a.html')).toBe('two, longer');
  });

  it('moves the copy to deleted/<date>/ when the object is deleted, and survives a replay', async () => {
    await put('orders/rep-4/a.html', 'erase me');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-4/a.html')]);
    await env.DOCS.delete('orders/rep-4/a.html');
    const eventTime = '2026-11-12T23:59:00.000Z';
    for (const action of ['DeleteObject', 'LifecycleDeletion']) {
      const result = await deliver(QUEUE, [event(action, 'orders/rep-4/a.html', eventTime)]);
      expect(result.explicitAcks).toHaveLength(1);
    }
    expect(await env.DOCS_REPLICA.head('orders/rep-4/a.html')).toBeNull();
    const moved = await env.DOCS_REPLICA.get('deleted/2026-11-12/orders/rep-4/a.html');
    expect(await moved!.text()).toBe('erase me');
    expect(moved!.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
  });

  it('does not move a copy whose object was written again after the delete event', async () => {
    await put('orders/rep-5/a.html', 'v1');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-5/a.html')]);
    await put('orders/rep-5/a.html', 'v2!');
    await deliver(QUEUE, [event('DeleteObject', 'orders/rep-5/a.html')]);
    expect(await replicaText('orders/rep-5/a.html')).toBe('v1');
    await deliver(QUEUE, [event('PutObject', 'orders/rep-5/a.html')]);
    expect(await replicaText('orders/rep-5/a.html')).toBe('v2!');
  });

  it('ignores the write check and its own prefixes', async () => {
    await env.DOCS.put('health/probe', 'x');
    await deliver(QUEUE, [event('PutObject', 'health/probe')]);
    expect(await env.DOCS_REPLICA.head('health/probe')).toBeNull();
    await env.DOCS.delete('health/probe');
  });

  it('retries an event it could not apply, and acknowledges one it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await put('orders/rep-6/a.html', 'x');
    const down = {
      ...env.DOCS_REPLICA,
      head: async () => {
        throw new Error('replica down');
      },
    } as unknown as R2Bucket;
    const failed = await deliver(QUEUE, [event('PutObject', 'orders/rep-6/a.html')], {
      DOCS_REPLICA: down,
    });
    expect(failed.retryMessages).toHaveLength(1);
    expect(failed.explicitAcks).toEqual([]);
    const junk = await deliver(QUEUE, [{ nothing: true }, event('RestoreObject', 'orders/x')]);
    expect(junk.explicitAcks).toHaveLength(2);
    expect(
      error.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('docs_replica_unreadable')),
    ).toHaveLength(2);
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('the dead-letter queue', () => {
  it('keeps each dead letter in the replica, logs it at error level and acknowledges it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = event('PutObject', 'orders/rep-dlq/a.html');
    const result = await deliver(DLQ, [body]);
    expect(result.explicitAcks).toHaveLength(1);
    const logged = error.mock.calls.map((c) => String(c[0])).find((l) => l.includes('dlq_message'));
    expect(JSON.parse(logged!)).toMatchObject({ type: 'dlq_message', queue: DLQ });
    error.mockRestore();
    const kept = await env.DOCS_REPLICA.list({ prefix: `dlq/${DLQ}/` });
    const saved = await (await env.DOCS_REPLICA.get(kept.objects.at(-1)!.key))!.json<any>();
    expect(saved).toMatchObject({ queue: DLQ, body });
  });
});

describe('the read fallback', () => {
  const failing = (status = 503) =>
    new Proxy(env.DOCS, {
      get: (target, prop) =>
        prop === 'get'
          ? async () => {
              throw Object.assign(new Error('get: service unavailable (10043)'), { status });
            }
          : Reflect.get(target, prop).bind?.(target),
    }) as R2Bucket;

  it('reads an order document from the replica when DOCS fails, and counts it', async () => {
    await env.DOCS_REPLICA.put('orders/rep-7/inv.html', 'from the replica');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = documentStore({ ...env, DOCS: failing() } as Env);
    expect(await store.text('orders/rep-7/inv.html')).toBe('from the replica');
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('docs_replica_read'));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: 'docs_replica_read', key: 'orders/rep-7/inv.html', reason: 'error', found: true },
    ]);
    warn.mockRestore();
  });

  it('never writes to the replica when a write to DOCS fails', async () => {
    const broken = new Proxy(env.DOCS, {
      get: (target, prop) =>
        prop === 'put'
          ? async () => {
              throw new Error('put: internal error (10001)');
            }
          : Reflect.get(target, prop).bind?.(target),
    }) as R2Bucket;
    const store = documentStore({ ...env, DOCS: broken } as Env);
    await expect(store.put('rep-8', 'invoices', 'a.html', 'x')).rejects.toThrow('10001');
    expect(await env.DOCS_REPLICA.head('orders/rep-8/invoices/a.html')).toBeNull();
  });

  it('reads DOCS alone when the replica is not bound', () => {
    expect(docsReader({ DOCS: env.DOCS })).toBe(env.DOCS);
  });
});

describe('the nightly reconcile', () => {
  const intro: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];
  beforeAll(async () => {
    const i = await introspectWorkflow(env.DOCS_RECONCILE);
    await i.modifyAll(async (m) => m.disableRetryDelays());
    intro.push(i);
  });
  afterAll(async () => {
    for (const i of intro) await i.dispose();
  });

  async function run(id: string) {
    await env.DOCS_RECONCILE.create({ id });
    const end = Date.now() + 50_000;
    while (Date.now() < end) {
      const s = await (await env.DOCS_RECONCILE.get(id)).status();
      if (['errored', 'complete', 'terminated'].includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the reconcile did not end');
  }

  it('re-copies a missing or stale object, flags an extra, and writes replica/<date>.json', async () => {
    await put('orders/rec-1/missing.html', 'never announced');
    await put('orders/rec-1/stale.html', 'old');
    await deliver(QUEUE, [event('PutObject', 'orders/rec-1/stale.html')]);
    await put('orders/rec-1/stale.html', 'newer and longer');
    await env.DOCS_REPLICA.put('orders/rec-1/orphan.html', 'its delete event was lost');

    const s = await run('rec-1');
    expect(s.status, JSON.stringify(s.error)).toBe('complete');
    expect(await replicaText('orders/rec-1/missing.html')).toBe('never announced');
    expect(await replicaText('orders/rec-1/stale.html')).toBe('newer and longer');
    // Flagged, not moved.
    expect(await replicaText('orders/rec-1/orphan.html')).toBe('its delete event was lost');

    const report = await (await env.DOCS_REPLICA.get(`replica/${today}.json`))!.json<any>();
    expect(report).toMatchObject({ date: today, outcome: 'attention' });
    expect(report.copied).toBeGreaterThanOrEqual(2);
    expect(report.extras.sample).toContain('orders/rec-1/orphan.html');
    expect(report.primary).toBeGreaterThanOrEqual(2);
    expect(report.replica).toBeGreaterThanOrEqual(report.primary);
    expect(report.failed).toEqual([]);

    // A second run has nothing to copy: the repairs held.
    expect((await run('rec-2')).status).toBe('complete');
    const again = await (await env.DOCS_REPLICA.get(`replica/${today}.json`))!.json<any>();
    expect(again.copied).toBe(0);
  });
});

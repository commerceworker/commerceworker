import type { ObjectBody } from '@commerceworker/ports/commerce';
import { describe, expect, it, vi } from 'vitest';
import {
  createR2ObjectBucket,
  createReplicaFallbackBucket,
  type R2ContentLike,
  type R2ReplicaBucketLike,
} from '../../src/object-replica-r2/index';

const body = (text: string): ObjectBody => ({
  body: new Response(text).body as ReadableStream,
  size: text.length,
  text: async () => text,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
});

/** A primary whose every read throws `error`, and a replica holding `text` under `k`. */
function pair(error: unknown, text: string | null = 'copy') {
  const primary = {
    get: vi.fn(async () => {
      throw error;
    }),
    head: vi.fn(async () => null),
    put: vi.fn(async () => {
      throw error;
    }),
    delete: vi.fn(async () => {
      throw error;
    }),
  };
  const replica = {
    get: vi.fn(async () => (text === null ? null : body(text))),
    put: vi.fn(),
  };
  const events: unknown[] = [];
  const bucket = createReplicaFallbackBucket(primary, replica, {
    timeoutMs: 20,
    onFallback: (e) => events.push(e),
  });
  return { primary, replica, bucket, events };
}

const serviceError = Object.assign(new Error('get: internal error (10001)'), { status: 500 });

describe('the read fallback', () => {
  it('reads the replica when the primary throws a service error, and counts it', async () => {
    const { bucket, events } = pair(serviceError);
    expect(await (await bucket.get('k'))!.text()).toBe('copy');
    expect(events).toEqual([{ key: 'k', reason: 'error', found: true }]);
  });

  it('reads the replica when the primary does not answer in time, and drops its late body', async () => {
    const cancel = vi.fn();
    const late = { ...body('late'), body: { cancel } as unknown as ReadableStream };
    const primary = {
      get: () => new Promise<ObjectBody>((r) => setTimeout(() => r(late), 60)),
      head: async () => null,
      put: async () => null,
      delete: async () => undefined,
    };
    const events: unknown[] = [];
    const bucket = createReplicaFallbackBucket(
      primary,
      { get: async () => body('copy') },
      { timeoutMs: 10, onFallback: (e) => events.push(e) },
    );
    expect(await (await bucket.get('k'))!.text()).toBe('copy');
    expect(events).toEqual([{ key: 'k', reason: 'timeout', found: true }]);
    await new Promise((r) => setTimeout(r, 80));
    expect(cancel).toHaveBeenCalled();
  });

  it('answers null when the replica has no copy either', async () => {
    const { bucket, events } = pair(serviceError, null);
    expect(await bucket.get('k')).toBeNull();
    expect(events).toEqual([{ key: 'k', reason: 'error', found: false }]);
  });

  it('throws the primary error when the replica fails too', async () => {
    const { bucket, replica, events } = pair(serviceError);
    replica.get.mockRejectedValue(new Error('replica down'));
    await expect(bucket.get('k')).rejects.toBe(serviceError);
    expect(events).toEqual([]);
  });

  it('does not read the replica for a bug in the call or a 4xx, or when the primary answers', async () => {
    for (const err of [
      new TypeError('bad key'),
      Object.assign(new Error('forbidden'), { status: 403 }),
    ]) {
      const { bucket, replica } = pair(err);
      await expect(bucket.get('k')).rejects.toBe(err);
      expect(replica.get).not.toHaveBeenCalled();
    }
    const replica = { get: vi.fn() };
    const bucket = createReplicaFallbackBucket(
      {
        get: async () => null,
        head: async () => null,
        put: async () => null,
        delete: async () => undefined,
      },
      replica,
      { onFallback: vi.fn() },
    );
    expect(await bucket.get('missing')).toBeNull();
    expect(replica.get).not.toHaveBeenCalled();
  });

  it('never fails a write or a delete over: they reach the primary alone and throw its error', async () => {
    const { bucket, primary, replica, events } = pair(serviceError);
    await expect(bucket.put('k', 'v' as never)).rejects.toBe(serviceError);
    await expect(bucket.delete('k')).rejects.toBe(serviceError);
    expect(primary.put).toHaveBeenCalledOnce();
    expect(replica.put).not.toHaveBeenCalled();
    expect(replica.get).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('the R2 object bucket', () => {
  it('maps R2 objects to the port and asks a listing for metadata', async () => {
    const o = (key: string): R2ContentLike =>
      ({
        ...body('abc'),
        key,
        etag: 'e',
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { a: 'b' },
      }) as R2ContentLike;
    const list = vi.fn(async () => ({ objects: [o('a')], truncated: true, cursor: 'c1' }));
    const put = vi.fn();
    const r2: R2ReplicaBucketLike = {
      head: async () => o('a'),
      get: async () => o('a'),
      put,
      delete: vi.fn(),
      list,
    };
    const b = createR2ObjectBucket(r2);
    expect(await b.head('a')).toEqual({
      key: 'a',
      size: 3,
      etag: 'e',
      contentType: 'text/plain',
      customMetadata: { a: 'b' },
    });
    expect(await b.list({ prefix: 'p/', limit: 5 })).toMatchObject({ cursor: 'c1' });
    expect(list).toHaveBeenCalledWith({
      prefix: 'p/',
      limit: 5,
      include: ['httpMetadata', 'customMetadata'],
    });
    await b.write('a', 'x', { contentType: 't', customMetadata: { m: '1' } });
    expect(put).toHaveBeenCalledWith('a', 'x', {
      httpMetadata: { contentType: 't' },
      customMetadata: { m: '1' },
    });
  });
});

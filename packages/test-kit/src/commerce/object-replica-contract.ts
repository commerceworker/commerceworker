/**
 * The behaviour every object bucket keeps: the in-memory bucket runs it in node, and the R2 adapter
 * in workerd (apps/engine/tests/docs-replica.test.ts, against the Workers pool's real R2).
 */
import type { ObjectBucket } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const text = async (stream: ReadableStream) => new Response(stream).text();

export function describeObjectBucketContract(name: string, make: () => Promise<ObjectBucket>) {
  describe(`object bucket (${name})`, () => {
    it('stores bytes, content type and custom metadata, and reads them back', async () => {
      const b = await make();
      await b.write('orders/o1/a.html', '<p>hi</p>', {
        contentType: 'text/html; charset=utf-8',
        customMetadata: { k: 'v' },
      });
      const o = await b.read('orders/o1/a.html');
      expect(o).toMatchObject({
        key: 'orders/o1/a.html',
        size: 9,
        contentType: 'text/html; charset=utf-8',
        customMetadata: { k: 'v' },
      });
      expect(await text(o!.body)).toBe('<p>hi</p>');
      expect(await b.head('orders/o1/a.html')).toMatchObject({ size: 9, etag: o!.etag });
    });

    it('answers null for a missing key and removes idempotently', async () => {
      const b = await make();
      expect(await b.head('nope')).toBeNull();
      expect(await b.read('nope')).toBeNull();
      await b.write('x', 'x', {});
      await b.remove('x');
      await b.remove('x');
      expect(await b.head('x')).toBeNull();
    });

    it('writes over a key, and a new write has a new etag', async () => {
      const b = await make();
      await b.write('k', 'one', {});
      const first = await b.head('k');
      await b.write('k', 'three', {});
      const second = await b.head('k');
      expect(second?.size).toBe(5);
      expect(second?.etag).not.toBe(first?.etag);
    });

    it('lists by prefix in key order, a page at a time, with metadata', async () => {
      const b = await make();
      for (const k of ['p/c', 'p/a', 'p/b', 'q/a'])
        await b.write(k, k, { customMetadata: { n: k } });
      const first = await b.list({ prefix: 'p/', limit: 2 });
      expect(first.objects.map((o) => o.key)).toEqual(['p/a', 'p/b']);
      expect(first.objects[0]?.customMetadata).toEqual({ n: 'p/a' });
      expect(first.cursor).toBeTruthy();
      const rest = await b.list({ prefix: 'p/', cursor: first.cursor, limit: 2 });
      expect(rest.objects.map((o) => o.key)).toEqual(['p/c']);
      expect(rest.cursor).toBeUndefined();
    });
  });
}

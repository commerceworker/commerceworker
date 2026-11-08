import { describe, expect, it } from 'vitest';
import {
  createMediaPathSigner,
  createMediaUrlSigner,
  createR2BlobStore,
  handleMediaRequest,
  keyFromMediaPath,
  type R2BucketLike,
} from '../../src/blob-r2/index';

/**
 * An R2 bucket with multipart, holding R2's rules: parts must all be the same size but the last,
 * and an upload that was completed or aborted is gone (NoSuchUpload).
 */
function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let seq = 0;
  const bytesOf = async (v: unknown) =>
    typeof v === 'string'
      ? new TextEncoder().encode(v)
      : new Uint8Array(await new Response(v as BodyInit).arrayBuffer());
  const bucket: R2BucketLike = {
    async get(key, options) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = options?.range
        ? o.subarray(options.range.offset, options.range.offset + options.range.length)
        : o;
      return {
        body: new Response(bytes).body as ReadableStream,
        size: o.byteLength,
        httpEtag: `"e${o.byteLength}"`,
        text: async () => new TextDecoder().decode(bytes),
      };
    },
    async put(key, value) {
      objects.set(key, await bytesOf(value));
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload(key) {
      const uploadId = `u${++seq}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const live = () => {
        const u = uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error('NoSuchUpload (10024)');
        return u;
      };
      return {
        async uploadPart(partNumber, value) {
          live().parts.set(partNumber, await bytesOf(value));
          return { partNumber, etag: `p${partNumber}` };
        },
        async complete(parts) {
          const u = live();
          const chunks = parts.map((p) => u.parts.get(p.partNumber) as Uint8Array);
          const first = chunks[0]?.byteLength;
          if (chunks.slice(0, -1).some((c) => c.byteLength !== first)) {
            throw new Error('InvalidPart (10048): All non-trailing parts must have the same size');
          }
          const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.byteLength;
          }
          objects.set(key, out);
          uploads.delete(uploadId);
          return { size: out.byteLength, httpEtag: `"m-${parts.length}"` };
        },
        async abort() {
          live();
          uploads.delete(uploadId);
        },
      };
    },
  };
  return { bucket, objects, uploads };
}

const KEY = 'space-1/main/asset-1/film.mov';
const signer = createMediaUrlSigner('test-secret');
const NOW = 1_700_000_000;

describe('R2 multipart uploads', () => {
  it('signs part URLs bound to the upload, the part and its length, and assembles the object', async () => {
    const { bucket, objects } = fakeR2();
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.test', now: () => NOW });
    const multipart = blob.multipart;
    if (!multipart) throw new Error('multipart missing');
    const { uploadId } = await multipart.create(KEY, 'video/quicktime');
    const signed1 = await multipart.partUrl(KEY, uploadId, 1, 4);
    const signed2 = await multipart.partUrl(KEY, uploadId, 2, 2);
    const put = (url: string, body: string) =>
      handleMediaRequest(
        new Request(url, {
          method: 'PUT',
          body,
          headers: { 'content-length': String(body.length) },
        }),
        { bucket, signer, now: () => NOW },
      );
    const r1 = await put(signed1.url, 'abcd');
    const r2 = await put(signed2.url, 'ef');
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const head = await multipart.complete(KEY, uploadId, [
      { partNumber: 2, etag: r2.headers.get('etag') ?? '' },
      { partNumber: 1, etag: r1.headers.get('etag') ?? '' },
    ]);
    expect(head.size).toBe(6);
    expect(new TextDecoder().decode(objects.get(KEY))).toBe('abcdef');
    // Once completed, the upload is gone: a late part finds nothing to write into.
    expect((await put(signed1.url, 'wxyz')).status).toBe(404);
    expect(new TextDecoder().decode(objects.get(KEY))).toBe('abcdef');
  });

  it('takes a part again before completion: a retry replaces the part it retries', async () => {
    const { bucket, objects } = fakeR2();
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.test', now: () => NOW });
    const multipart = blob.multipart;
    if (!multipart) throw new Error('multipart missing');
    const { uploadId } = await multipart.create(KEY, 'video/quicktime');
    const { url } = await multipart.partUrl(KEY, uploadId, 1, 2);
    const put = (body: string) =>
      handleMediaRequest(
        new Request(url, { method: 'PUT', body, headers: { 'content-length': '2' } }),
        { bucket, signer, now: () => NOW },
      );
    expect((await put('xx')).status).toBe(200);
    const again = await put('ab');
    expect(again.status).toBe(200);
    await multipart.complete(KEY, uploadId, [
      { partNumber: 1, etag: again.headers.get('etag') ?? '' },
    ]);
    expect(new TextDecoder().decode(objects.get(KEY))).toBe('ab');
  });

  it('refuses a part of another length, a forged part number or upload, and an expired URL', async () => {
    const { bucket } = fakeR2();
    const blob = createR2BlobStore(bucket, { signer, now: () => NOW });
    const multipart = blob.multipart;
    if (!multipart) throw new Error('multipart missing');
    const { uploadId } = await multipart.create(KEY, 'video/quicktime');
    const { url } = await multipart.partUrl(KEY, uploadId, 1, 4);
    const put = (u: string, body: string, now = NOW) =>
      handleMediaRequest(
        new Request(`https://api.test${u}`, {
          method: 'PUT',
          body,
          headers: { 'content-length': String(body.length) },
        }),
        { bucket, signer, now: () => now },
      );
    expect((await put(url, 'abc')).status).toBe(400);
    expect((await put(url.replace('part=1', 'part=2'), 'abcd')).status).toBe(403);
    expect((await put(url.replace(`upload=${uploadId}`, 'upload=other'), 'abcd')).status).toBe(403);
    expect((await put(url.replace('len=4', 'len=3'), 'abc')).status).toBe(403);
    // Another key: the path is signed too.
    expect((await put(url.replace('asset-1', 'asset-2'), 'abcd')).status).toBe(403);
    expect((await put(url, 'abcd', NOW + 3600)).status).toBe(403);
    // A single-PUT URL can't be turned into a part upload by adding the parameters.
    const single = (await blob.getUploadUrl(KEY, 'video/quicktime')).url;
    expect((await put(`${single}&upload=${uploadId}&part=1&len=4`, 'abcd')).status).toBe(403);
    expect(keyFromMediaPath(new URL(`https://x${url}`).pathname)).toBe(KEY);
  });

  it('aborts an upload, and an upload already gone is not an error', async () => {
    const { bucket, uploads } = fakeR2();
    const multipart = createR2BlobStore(bucket, { signer }).multipart;
    if (!multipart) throw new Error('multipart missing');
    const { uploadId } = await multipart.create(KEY, 'video/quicktime');
    await multipart.abort(KEY, uploadId);
    expect(uploads.size).toBe(0);
    await expect(multipart.abort(KEY, uploadId)).resolves.toBeUndefined();
  });

  it('reads a byte range, and writes server-side parts (a zip)', async () => {
    const { bucket } = fakeR2();
    const blob = createR2BlobStore(bucket, { signer });
    await blob.put(KEY, 'hello world', 'text/plain');
    const range = await blob.openRange?.(KEY, 6, 5);
    const chunks: Uint8Array[] = [];
    for await (const c of range?.body ?? []) chunks.push(c);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('world');
    expect(range?.size).toBe(11);
    const multipart = blob.multipart;
    if (!multipart) throw new Error('multipart missing');
    const { uploadId } = await multipart.create('zips/s/e/j/a.zip', 'application/zip');
    const part = await multipart.uploadPart('zips/s/e/j/a.zip', uploadId, 1, new Uint8Array(3));
    expect(await multipart.complete('zips/s/e/j/a.zip', uploadId, [part])).toMatchObject({
      size: 3,
    });
  });

  it('a bucket without multipart offers none', () => {
    const { bucket } = fakeR2();
    const { createMultipartUpload: _c, resumeMultipartUpload: _r, ...plain } = bucket;
    expect(createR2BlobStore(plain, { signer }).multipart).toBeUndefined();
  });
});

describe('share link tokens', () => {
  const paths = createMediaPathSigner('test-secret');
  const scope = { spaceId: 'shop', environmentId: 'main' };

  it('verifies only its own scope and link, and is never an asset path’s token', () => {
    const token = paths.linkToken(scope, 'link-1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(paths.verifyLink(scope, 'link-1', token)).toBe(true);
    expect(paths.verifyLink(scope, 'link-2', token)).toBe(false);
    expect(paths.verifyLink({ ...scope, environmentId: 'staging' }, 'link-1', token)).toBe(false);
    expect(paths.verifyLink(scope, 'link-1', `${token}=`)).toBe(false);
    expect(paths.verify(scope, 'link-1', 1, token)).toBe(false);
    expect(paths.verifyLink(scope, 'asset-1', paths.token(scope, 'asset-1', 1))).toBe(false);
    expect(createMediaPathSigner('other').verifyLink(scope, 'link-1', token)).toBe(false);
  });
});

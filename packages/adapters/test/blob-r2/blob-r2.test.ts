import { describe, expect, it } from 'vitest';
import {
  createMediaPathSigner,
  createMediaUrlSigner,
  createR2BlobStore,
  handleMediaRequest,
  keyFromMediaPath,
  type R2BucketLike,
  type R2ObjectBodyLike,
  readUrlExpiry,
} from '../../src/blob-r2/index';

/** In-memory R2 bucket: stores bytes + content type, like the binding. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket: R2BucketLike = {
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      const obj: R2ObjectBodyLike = {
        body: new Response(o.bytes).body as ReadableStream,
        size: o.bytes.byteLength,
        httpEtag: `"etag-${o.bytes.byteLength}"`,
        httpMetadata: { contentType: o.contentType },
        text: async () => new TextDecoder().decode(o.bytes),
      };
      return obj;
    },
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
      // R2's create-once condition: nothing stored, `null` back, when the key exists.
      if (options?.onlyIf?.get('if-none-match') === '*' && objects.has(key)) return null;
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return { httpEtag: `"etag-${bytes.byteLength}"` };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    // Pages of two, so a listing that only reads the first page shows in a test.
    async list({ prefix, cursor }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2);
      const truncated = start + 2 < keys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(start + 2) } : {}),
      };
    },
  };
  return { bucket, objects };
}

const KEY = 'space-1/main/0190-asset/my photo.png';
const signer = createMediaUrlSigner('test-secret');
const NOW = 1_700_000_000;

describe('createR2BlobStore', () => {
  it('round-trips server-side put/get and deletes', async () => {
    const { bucket } = fakeBucket();
    const blob = createR2BlobStore(bucket, { signer });
    await blob.put('k/a.json', '{"x":1}', 'application/json');
    expect(await blob.get('k/a.json')).toBe('{"x":1}');
    await blob.delete('k/a.json');
    expect(await blob.get('k/a.json')).toBeNull();
  });

  it('streams an object with its size and type, and null for a missing key', async () => {
    const { bucket } = fakeBucket();
    const store = createR2BlobStore(bucket, { signer });
    await store.put('s/e/a/file.pdf', 'hello', 'application/pdf');
    const opened = await store.open?.('s/e/a/file.pdf');
    expect(opened?.size).toBe(5);
    expect(opened?.contentType).toBe('application/pdf');
    let text = '';
    for await (const chunk of opened?.body ?? []) text += new TextDecoder().decode(chunk);
    expect(text).toBe('hello');
    expect(await store.open?.('s/e/a/missing')).toBeNull();
  });

  it('describes an object without its bytes, through head or a read let go unread', async () => {
    const { bucket } = fakeBucket();
    const viaGet = createR2BlobStore(bucket, { signer });
    await viaGet.put('s/e/a/v2/file/new.png', 'bytes', 'image/png');
    expect(await viaGet.head?.('s/e/a/v2/file/new.png')).toEqual({
      size: 5,
      etag: '"etag-5"',
      contentType: 'image/png',
    });
    expect(await viaGet.head?.('s/e/a/v2/file/missing.png')).toBeNull();
    const heads: string[] = [];
    const withHead: R2BucketLike = {
      ...bucket,
      async head(key) {
        heads.push(key);
        return key.endsWith('new.png') ? { size: 5, httpEtag: '"h"' } : null;
      },
    };
    const viaHead = createR2BlobStore(withHead, { signer });
    expect(await viaHead.head?.('s/e/a/v2/file/new.png')).toEqual({ size: 5, etag: '"h"' });
    expect(heads).toEqual(['s/e/a/v2/file/new.png']);
  });

  it('issues signed media URLs under the configured origin, encoding key segments', async () => {
    const { bucket } = fakeBucket();
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.example/' });
    const url = new URL(await blob.getDownloadUrl(KEY));
    expect(url.origin).toBe('https://api.example');
    expect(url.pathname).toBe('/media/space-1/main/0190-asset/my%20photo.png');
    expect(url.searchParams.get('sig')).toBeTruthy();
    expect(keyFromMediaPath(url.pathname)).toBe(KEY);
  });

  it('defaults to root-relative URLs when no origin is configured', async () => {
    const blob = createR2BlobStore(fakeBucket().bucket, { signer });
    expect(await blob.getDownloadUrl('a/b')).toMatch(/^\/media\/a\/b\?sig=/);
  });
});

describe('handleMediaRequest', () => {
  async function upload(bucket: R2BucketLike, now = NOW) {
    const blob = createR2BlobStore(bucket, {
      signer,
      baseUrl: 'https://api.example',
      now: () => now,
    });
    const { url, headers } = await blob.getUploadUrl(KEY, 'image/png');
    return { blob, url, headers };
  }

  it('accepts a signed PUT, stores bytes with the signed content type, then serves a signed GET', async () => {
    const { bucket, objects } = fakeBucket();
    const { blob, url } = await upload(bucket);
    const put = await handleMediaRequest(
      new Request(url, {
        method: 'PUT',
        // The client lies about the type; the signed `ct` wins.
        headers: { 'content-type': 'text/html', 'content-length': '5' },
        body: 'hello',
      }),
      { bucket, signer, now: () => NOW },
    );
    expect(put.status).toBe(200);
    expect(objects.get(KEY)?.contentType).toBe('image/png');

    const get = await handleMediaRequest(new Request(await blob.getDownloadUrl(KEY)), {
      bucket,
      signer,
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toContain('sandbox');
    expect(await get.text()).toBe('hello');
  });

  it('never lets a signed PUT write over bytes already stored, even through its own URL', async () => {
    const { bucket, objects } = fakeBucket();
    const { url } = await upload(bucket);
    const put = (body: string) =>
      handleMediaRequest(
        new Request(url, {
          method: 'PUT',
          headers: { 'content-length': String(body.length) },
          body,
        }),
        { bucket, signer, now: () => NOW },
      );
    const first = await put('hello');
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"etag-5"');
    // The same URL, still inside its 15 minutes, after the file was committed or ingested.
    const second = await put('evil!!');
    expect(second.status).toBe(412);
    expect(new TextDecoder().decode(objects.get(KEY)?.bytes)).toBe('hello');
  });

  it('stores a retried PUT whose first attempt never landed', async () => {
    const { bucket, objects } = fakeBucket();
    const { url } = await upload(bucket);
    const flaky: R2BucketLike = {
      ...bucket,
      async put() {
        throw new Error('network: connection reset');
      },
    };
    const request = () =>
      new Request(url, { method: 'PUT', headers: { 'content-length': '5' }, body: 'hello' });
    await expect(
      handleMediaRequest(request(), { bucket: flaky, signer, now: () => NOW }),
    ).rejects.toThrow(/connection reset/);
    expect(objects.has(KEY)).toBe(false);
    const retry = await handleMediaRequest(request(), { bucket, signer, now: () => NOW });
    expect(retry.status).toBe(200);
    expect(new TextDecoder().decode(objects.get(KEY)?.bytes)).toBe('hello');
  });

  it('refuses an expired upload URL', async () => {
    const { bucket } = fakeBucket();
    const { url } = await upload(bucket, NOW - 10_000);
    const res = await handleMediaRequest(
      new Request(url, { method: 'PUT', headers: { 'content-length': '1' }, body: 'x' }),
      { bucket, signer, now: () => NOW },
    );
    expect(res.status).toBe(403);
  });

  it('refuses a tampered key, a forged signature, and an upload URL replayed as a GET', async () => {
    const { bucket } = fakeBucket();
    const { blob, url } = await upload(bucket);
    const other = url.replace('my%20photo.png', 'other.png');
    expect(
      (
        await handleMediaRequest(
          new Request(other, { method: 'PUT', headers: { 'content-length': '1' }, body: 'x' }),
          { bucket, signer, now: () => NOW },
        )
      ).status,
    ).toBe(403);
    const forged = (await blob.getDownloadUrl(KEY)).replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await handleMediaRequest(new Request(forged), { bucket, signer })).status).toBe(403);
    // Same params signed for PUT do not authorize GET.
    expect((await handleMediaRequest(new Request(url), { bucket, signer })).status).toBe(403);
  });

  it('refuses unsigned requests and oversize uploads', async () => {
    const { bucket } = fakeBucket();
    expect(
      (await handleMediaRequest(new Request('https://api.example/media/a/b'), { bucket, signer }))
        .status,
    ).toBe(403);
    const { url } = await upload(bucket);
    const res = await handleMediaRequest(
      new Request(url, { method: 'PUT', headers: { 'content-length': '10' }, body: '0123456789' }),
      { bucket, signer, now: () => NOW, maxUploadBytes: 5 },
    );
    expect(res.status).toBe(413);
  });

  it('forces download for types a browser could execute', async () => {
    const { bucket } = fakeBucket();
    await bucket.put('a/page.html', '<script>alert(1)</script>', {
      httpMetadata: { contentType: 'text/html' },
    });
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.example' });
    const res = await handleMediaRequest(new Request(await blob.getDownloadUrl('a/page.html')), {
      bucket,
      signer,
    });
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('routes signed GETs with params through the transform hook, and only those', async () => {
    const { bucket } = fakeBucket();
    await bucket.put(KEY, 'png-bytes', { httpMetadata: { contentType: 'image/png' } });
    const seen: string[] = [];
    const transform = async (_o: R2ObjectBodyLike, params: URLSearchParams) => {
      seen.push(params.get('w') ?? '');
      return new Response('transformed');
    };
    const params = new URLSearchParams({ w: '200' });
    params.set('sig', await signer.sign('GET', KEY, params));
    const path = `https://api.example/media/space-1/main/0190-asset/my%20photo.png`;
    const res = await handleMediaRequest(new Request(`${path}?${params}`), {
      bucket,
      signer,
      transform,
    });
    expect(await res.text()).toBe('transformed');
    expect(seen).toEqual(['200']);

    // Changing a signed transform param invalidates the URL.
    const tampered = `${path}?${params.toString().replace('w=200', 'w=9000')}`;
    expect(
      (await handleMediaRequest(new Request(tampered), { bucket, signer, transform })).status,
    ).toBe(403);
  });
});

describe('deletePrefix', () => {
  it('deletes every page under the prefix except what keep names, and nothing outside it', async () => {
    const { bucket, objects } = fakeBucket();
    const store = createR2BlobStore(bucket, { signer });
    for (const key of [
      's1/staging/a1/x.png',
      's1/staging/a2/y.png',
      's1/staging/shared/z.png',
      's1/staging/a3/w.png',
      's1/stagingx/a4/v.png',
      's1/main/a5/u.png',
    ]) {
      await store.put(key, 'bytes', 'image/png');
    }
    const deleted = await store.deletePrefix?.('s1/staging/', (key) => key.includes('/shared/'));
    expect(deleted).toBe(3);
    expect([...objects.keys()].sort()).toEqual([
      's1/main/a5/u.png',
      's1/staging/shared/z.png',
      's1/stagingx/a4/v.png',
    ]);
  });
});

describe('short-lived reads', () => {
  it('expire on a window boundary, so reads within one window share a URL', () => {
    expect(readUrlExpiry(1000, 900)).toBe(2700);
    expect(readUrlExpiry(1799, 900)).toBe(2700);
    expect(readUrlExpiry(1801, 900)).toBe(3600);
  });

  it('serve until exp, refuse after it, and can point at another origin', async () => {
    const { bucket } = fakeBucket();
    await bucket.put(KEY, 'bytes', { httpMetadata: { contentType: 'image/png' } });
    let now = NOW;
    const blob = createR2BlobStore(bucket, {
      signer,
      baseUrl: 'https://api.example',
      now: () => now,
    });
    const url = await blob.getDownloadUrl(KEY, {
      expiresInSeconds: 900,
      origin: 'https://media.example',
    });
    expect(new URL(url).origin).toBe('https://media.example');
    expect(new URL(url).searchParams.get('exp')).toBe(String(readUrlExpiry(NOW, 900)));
    // Within the window the same URL comes back.
    now += 60;
    expect(
      await blob.getDownloadUrl(KEY, { expiresInSeconds: 900, origin: 'https://media.example' }),
    ).toBe(url);

    const opts = { bucket, signer, now: () => now };
    const ok = await handleMediaRequest(new Request(url), opts);
    expect(ok.status).toBe(200);
    // A draft's bytes: kept by the reader only, and not past the expiry.
    expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);

    now = readUrlExpiry(NOW, 900) + 1;
    expect((await handleMediaRequest(new Request(url), opts)).status).toBe(403);
    // Stretching exp breaks the signature.
    const stretched = url.replace(/exp=\d+/, `exp=${now + 900}`);
    expect((await handleMediaRequest(new Request(stretched), opts)).status).toBe(403);
  });

  it('are the only reads a host that requires an expiry serves, and it takes no upload', async () => {
    const { bucket } = fakeBucket();
    await bucket.put(KEY, 'bytes', { httpMetadata: { contentType: 'image/png' } });
    const blob = createR2BlobStore(bucket, { signer, now: () => NOW });
    const strict = { bucket, signer, now: () => NOW, requireExpiry: true, readOnly: true };
    const stored = await blob.getDownloadUrl(KEY);
    expect((await handleMediaRequest(new Request(`https://m${stored}`), strict)).status).toBe(403);
    // The api, which doesn't require one, still honours what assets stored at creation.
    expect(
      (await handleMediaRequest(new Request(`https://m${stored}`), { bucket, signer })).status,
    ).toBe(200);
    const { url } = await blob.getUploadUrl(KEY, 'image/png');
    const put = await handleMediaRequest(
      new Request(`https://m${url}`, {
        method: 'PUT',
        headers: { 'content-length': '1' },
        body: 'x',
      }),
      strict,
    );
    expect(put.status).toBe(405);
  });
});

describe('the media path signer', () => {
  const signer = createMediaPathSigner('path-secret-0123456789abcdef0123456789');
  const main = { spaceId: 'shop', environmentId: 'main' };

  it('makes one 22-character base64url token per scope, asset and version', () => {
    const t = signer.token(main, 'a1', 1);
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(signer.token(main, 'a1', 1)).toBe(t);
    for (const other of [
      signer.token({ ...main, environmentId: 'staging' }, 'a1', 1),
      signer.token({ ...main, spaceId: 'shop2' }, 'a1', 1),
      signer.token(main, 'a2', 1),
      signer.token(main, 'a1', 2),
      createMediaPathSigner('another-secret-0123456789abcdef01234').token(main, 'a1', 1),
    ]) {
      expect(other).not.toBe(t);
    }
    expect(signer.verify(main, 'a1', 1, t)).toBe(true);
  });

  it('refuses another address’s token, a tampered one, and non-canonical encodings', () => {
    const t = signer.token(main, 'a1', 1);
    expect(signer.verify({ ...main, environmentId: 'staging' }, 'a1', 1, t)).toBe(false);
    expect(signer.verify(main, 'a1', 2, t)).toBe(false);
    const flipped = `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`;
    expect(signer.verify(main, 'a1', 1, flipped)).toBe(false);
    expect(signer.verify(main, 'a1', 1, `${t}==`)).toBe(false);
    expect(signer.verify(main, 'a1', 1, t.slice(0, 20))).toBe(false);
    expect(signer.verify(main, 'a1', 1, '')).toBe(false);
  });
});

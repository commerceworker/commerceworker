import {
  createMediaUrlSigner,
  createR2BlobStore,
  keyFromMediaPath,
  type R2BucketLike,
} from '@commerceworker/adapters/blob-r2';
import {
  createCfImageTransformer,
  type ImagesBindingLike,
} from '@commerceworker/adapters/images-cf';
import {
  createStreamVideoHost,
  type StreamBindingLike,
} from '@commerceworker/adapters/video-stream';
import {
  type AppContext,
  assetFileKey,
  commitAssetFile,
  createAsset,
  createSpace,
  createVideoAsset,
  getAsset,
  READ_URL_TTL_SECONDS,
  replaceAssetFile,
  setAssetMetadata,
  transformAssetUrl,
} from '@commerceworker/application';
import { mediaAdapters } from '@commerceworker/platform/media';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type MediaRouteDeps, mediaRoutes } from '../src/routes/media';

/** The routes as the api entry binds them: adapters from `@commerceworker/platform/media`. */
const routes = ({
  ctx,
  onUploaded,
  ...adapters
}: Omit<MediaRouteDeps, 'media'> & Parameters<typeof mediaAdapters>[0]) =>
  mediaRoutes({ ctx, media: mediaAdapters(adapters), ...(onUploaded ? { onUploaded } : {}) });

const scope = { spaceId: 's1', environmentId: 'main' };
const signer = createMediaUrlSigner('k');

function fakeBucket(): R2BucketLike {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new Response(o.bytes).body as ReadableStream,
        size: o.bytes.byteLength,
        httpEtag: '"e"',
        httpMetadata: { contentType: o.type },
        text: async () => new TextDecoder().decode(o.bytes),
      };
    },
    async put(key, value, options) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      if (options?.onlyIf?.get('if-none-match') === '*' && objects.has(key)) return null;
      objects.set(key, { bytes, type: options?.httpMetadata?.contentType });
      // As R2: the etag names the bytes.
      return { httpEtag: `"${new TextDecoder().decode(bytes)}"` };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

function fakeImages() {
  const formats: string[] = [];
  const handle = {
    transform: () => handle,
    async output(o: { format: string }) {
      formats.push(o.format);
      return { response: () => new Response('img', { headers: { 'content-type': o.format } }) };
    },
  };
  const images = { input: () => handle } as unknown as ImagesBindingLike;
  return { images, formats };
}

function ctx(extra: Partial<AppContext> = {}): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    ...extra,
  };
}

describe('/media routes', () => {
  it('uploads through a signed PUT, downloads, and transforms via the Images binding', async () => {
    const bucket = fakeBucket();
    const { images, formats } = fakeImages();
    const app = routes({ ctx: ctx(), bucket, signer, images });
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://w.example' });

    const { url } = await blob.getUploadUrl('s1/main/a/p.png', 'image/png');
    const put = await app.request(url, {
      method: 'PUT',
      headers: { 'content-length': '3' },
      body: 'png',
    });
    expect(put.status).toBe(200);

    const download = await app.request(await blob.getDownloadUrl('s1/main/a/p.png'));
    expect(await download.text()).toBe('png');

    const params = new URLSearchParams({ w: '100', fm: 'auto' });
    params.set('sig', await signer.sign('GET', 's1/main/a/p.png', params));
    const transformed = await app.request(`https://w.example/media/s1/main/a/p.png?${params}`, {
      headers: { accept: 'image/avif,image/webp' },
    });
    expect(transformed.headers.get('content-type')).toBe('image/avif');
    expect(transformed.headers.get('vary')).toBe('Accept');
    expect(formats).toEqual(['image/avif']);
  });

  it('starts ingest for a completed upload only, and a failed notice never fails it', async () => {
    const bucket = fakeBucket();
    const uploaded: string[] = [];
    const app = routes({
      ctx: ctx(),
      bucket,
      signer,
      onUploaded: async (key) => {
        uploaded.push(key);
        throw new Error('queue down');
      },
    });
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://w.example' });
    const { url } = await blob.getUploadUrl('s1/main/a/my file.png', 'image/png');
    const put = await app.request(url, {
      method: 'PUT',
      headers: { 'content-length': '3' },
      body: 'png',
    });
    expect(put.status).toBe(200);
    expect(uploaded).toEqual(['s1/main/a/my file.png']);

    // A refused upload (forged signature) and a download start nothing.
    await app.request(url.replace(/sig=[^&]+/, 'sig=forged'), { method: 'PUT', body: 'x' });
    await app.request(await blob.getDownloadUrl('s1/main/a/my file.png'));
    expect(uploaded).toHaveLength(1);
  });

  it('stores a signed PUT once: the same URL used again is 412, starts nothing and keeps the bytes', async () => {
    const bucket = fakeBucket();
    const uploaded: { key: string; etag?: string }[] = [];
    const app = routes({
      ctx: ctx(),
      bucket,
      signer,
      onUploaded: async (key, etag) => {
        uploaded.push({ key, ...(etag ? { etag } : {}) });
      },
    });
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://w.example' });
    const { url } = await blob.getUploadUrl('s1/main/a/p.png', 'image/png');
    const statuses: number[] = [];
    for (const body of ['one', 'two']) {
      const put = await app.request(url, {
        method: 'PUT',
        headers: { 'content-length': '3' },
        body,
      });
      statuses.push(put.status);
    }
    expect(statuses).toEqual([200, 412]);
    expect(uploaded).toEqual([{ key: 's1/main/a/p.png', etag: '"one"' }]);
    const download = await app.request(await blob.getDownloadUrl('s1/main/a/p.png'));
    expect(await download.text()).toBe('one');
  });

  it('a draft’s Management transform is signed for its current version’s key, and expires', async () => {
    const NOW = 1_800_000_000;
    const bucket = fakeBucket();
    const { images, formats } = fakeImages();
    const c = ctx({ images: createCfImageTransformer({ signer, now: () => NOW }) });
    const blob = createR2BlobStore(bucket, {
      signer,
      baseUrl: 'https://w.example',
      now: () => NOW,
    });
    const app = routes({ ctx: c, bucket, signer, images, now: () => NOW });
    await createSpace(c, { spaceId: 's1', name: 'S', defaultLocale: 'en-US' });

    // A draft whose file was replaced: its bytes are at v2's key now, not where the stored URL
    // (signed at upload, non-expiring) points.
    const { asset } = await createAsset(c, blob, scope, {
      fileName: 'p.png',
      contentType: 'image/png',
    });
    await blob.put(assetFileKey(scope, asset), 'v1', 'image/png');
    const r = await replaceAssetFile(c, blob, scope, asset.id, {
      fileName: 'q.png',
      contentType: 'image/png',
    });
    await blob.put(keyFromMediaPath(new URL(r.upload.url).pathname) ?? '', 'v2', 'image/png');
    await commitAssetFile(c, blob, scope, asset.id, r.commit);
    await setAssetMetadata(c, scope, asset.id, { focalPoint: { x: 0.2, y: 0.8 } });
    const v2 = await getAsset(c, scope, asset.id);
    expect(v2.version).toBe(2);
    const key = assetFileKey(scope, v2);
    expect(key).toMatch(new RegExp(`/${asset.id}/v2/file-[^/]+/q\\.png$`));

    const { url } = await transformAssetUrl(c, blob, scope, asset.id, { width: 100, fit: 'crop' });
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.pathname)).toBe(`/media/${key}`);
    expect(Number(parsed.searchParams.get('exp'))).toBeGreaterThan(NOW);
    expect(Number(parsed.searchParams.get('exp'))).toBeLessThanOrEqual(
      NOW + 2 * READ_URL_TTL_SECONDS,
    );
    // The focal point is the crop's gravity, and the signature covers every parameter.
    expect(parsed.searchParams.get('g')).toBe('0.2x0.8');
    const sig = parsed.searchParams.get('sig') ?? '';
    expect(await signer.verify('GET', key, parsed.searchParams, sig)).toBe(true);

    const served = await app.request(url, { headers: { accept: 'image/webp' } });
    expect(served.status).toBe(200);
    expect(formats).toEqual(['image/webp']);
    // Once its read URL has expired, so has the transform.
    const later = routes({ ctx: c, bucket, signer, images, now: () => NOW + 3600 });
    expect((await later.request(url)).status).toBe(403);
  });

  it('is not mounted without a bucket', async () => {
    const app = routes({ ctx: ctx() });
    expect((await app.request('https://w.example/media/a/b?sig=x')).status).toBe(404);
  });
});

async function streamSignature(secret: string, time: number, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${time}.${body}`)));
  return `time=${time},sig1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('POST /webhooks/stream', () => {
  it('refreshes the referenced asset from the Stream API on a verified notification', async () => {
    let state = { state: 'inprogress', ready: false };
    const stream: StreamBindingLike = {
      createDirectUpload: async () => ({ uploadURL: 'https://upload/x', id: 'uid1' }),
      video: () => ({
        details: async () => ({
          readyToStream: state.ready,
          status: { state: state.state },
          hlsPlaybackUrl: 'https://s/uid1/manifest/video.m3u8',
          thumbnail: 'https://s/uid1/thumbnails/thumbnail.jpg',
        }),
        delete: async () => {},
      }),
    };
    const c = ctx({ video: createStreamVideoHost(stream) });
    await createSpace(c, { spaceId: 's1', name: 'S', defaultLocale: 'en-US' });
    const { asset } = await createVideoAsset(c, scope, {
      fileName: 'v.mp4',
      contentType: 'video/mp4',
    });
    const app = routes({ ctx: c, streamWebhookSecret: 'whsec', now: () => 1000 });

    state = { state: 'ready', ready: true };
    // The payload claims nothing we store; only uid + meta are read from it.
    const body = JSON.stringify({
      uid: 'uid1',
      readyToStream: true,
      meta: { assetId: asset.id, spaceId: 's1', environmentId: 'main' },
    });
    const res = await app.request('https://w.example/webhooks/stream', {
      method: 'POST',
      headers: { 'webhook-signature': await streamSignature('whsec', 1000, body) },
      body,
    });
    expect(res.status).toBe(204);
    const stored = await c.store.assets.get(scope, asset.id);
    expect(stored?.file.video).toMatchObject({
      status: 'ready',
      thumbnailUrl: 'https://s/uid1/thumbnails/thumbnail.jpg',
    });

    const forged = await app.request('https://w.example/webhooks/stream', {
      method: 'POST',
      headers: { 'webhook-signature': await streamSignature('wrong', 1000, body) },
      body,
    });
    expect(forged.status).toBe(401);
  });
});

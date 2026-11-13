import { createExecutionContext, createMessageBatch, getQueueResult, SELF } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { createKvAssetGate } from '@commerceworker/adapters/asset-gate-kv';
import {
  createMediaPathSigner,
  createMediaUrlSigner,
  signedMediaUrl,
} from '@commerceworker/adapters/blob-r2';
import {
  type AppContext,
  cloneEnvironment,
  commitAssetFile,
  createAsset,
  createAssetRendition,
  createEnvironment,
  createSpace,
  deleteEnvironment,
  dispatchEvent,
  expireAsset,
  publishAsset,
  replaceAssetFile,
  runEnvironmentPurge,
  setAssetMetadata,
  setAssetRights,
  syncAssetGate,
  unpublishAsset,
} from '@commerceworker/application';
import {
  type Asset,
  type AssetVariant,
  assetMediaPath,
  type Principal,
} from '@commerceworker/domain';
import type { PurgeMessage } from '@commerceworker/platform/messages';
import type { AssetGate, ContentStore } from '@commerceworker/ports';
import { createD1Store } from '@commerceworker/store';
import { FakeBlobStore, RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import {
  byteRange,
  canonicalMediaUrl,
  contentDisposition,
  serveMedia,
  serveMediaRange,
} from '../src/serve';

const ORIGIN = 'https://media.example.test';

let seq = 0;
function context(): AppContext {
  return {
    store: createD1Store(env.DB),
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
  };
}

const gate = createKvAssetGate(env.KV_CACHE);
/** The api and delivery make each path's token with the same secret the Worker checks. */
const paths = createMediaPathSigner(env.MEDIA_SIGNING_SECRET);

/** A body read as bytes (`.text()` on an image type warns), then as text or JSON. */
const textOf = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());
const jsonOf = async <T>(res: Response) => JSON.parse(await textOf(res)) as T;

/** A space of its own per test (the D1 is shared by the file), with one uploaded image. */
async function uploaded(
  opts: { contentType?: string; fileName?: string; bytes?: string } = {},
): Promise<{ ctx: AppContext; scope: { spaceId: string; environmentId: string }; asset: Asset }> {
  const ctx = context();
  const scope = { spaceId: `media-space-${++seq}`, environmentId: 'main' };
  await createSpace(ctx, { spaceId: scope.spaceId, name: 'Media', defaultLocale: 'en-US' });
  const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
    fileName: opts.fileName ?? 'hero shot.jpg',
    contentType: opts.contentType ?? 'image/jpeg',
  });
  await env.MEDIA_BUCKET.put(asset.r2Key as string, opts.bytes ?? 'JPEG-BYTES', {
    httpMetadata: { contentType: opts.contentType ?? 'image/jpeg' },
  });
  return { ctx, scope, asset };
}

/** Publishes it and runs what the engine runs for the event: the gate follows the snapshot. */
async function published(opts: Parameters<typeof uploaded>[0] = {}) {
  const u = await uploaded(opts);
  await publishAsset(u.ctx, u.scope, u.asset.id);
  expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('written');
  return u;
}

const urlOf = (
  u: { scope: { spaceId: string; environmentId: string }; asset: Asset },
  variant: AssetVariant,
  version = 1,
  token = paths.token(u.scope, u.asset.id, version),
) =>
  `${ORIGIN}${assetMediaPath({
    scope: u.scope,
    assetId: u.asset.id,
    version,
    token,
    variant,
    fileName: u.asset.file.fileName,
  })}`;

/** Drains one media purge through this Worker's consumer, as the engine's message would. */
async function purgeMedia(tags: string[]) {
  const batch = createMessageBatch<PurgeMessage>('commerceworker-media-purge', [
    { id: `purge-${++seq}`, timestamp: new Date(), attempts: 1, body: { tags } },
  ]);
  const ctx = Object.assign(createExecutionContext(), { exports });
  await worker.queue(batch, env as never, ctx);
  await getQueueResult(batch, ctx);
}

describe('the media Worker', () => {
  it('serves a published original, immutable and tagged for purges', async () => {
    const u = await published();
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(200);
    expect(await textOf(res)).toBe('JPEG-BYTES');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-tag')).toBe(
      `cwa:${u.scope.spaceId}:main:${u.asset.id},cwe:${u.scope.spaceId}:main`,
    );
    // Conditional reads answer 304 against the object's ETag.
    const etag = res.headers.get('etag') as string;
    const again = await SELF.fetch(urlOf(u, { kind: 'original' }), {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('answers 404 once the asset is unpublished and its media purged', async () => {
    const u = await published();
    expect((await SELF.fetch(urlOf(u, { kind: 'original' }))).status).toBe(200);

    await unpublishAsset(u.ctx, u.scope, u.asset.id);
    expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('removed');
    // The media purge the engine enqueues, drained by this Worker's consumer.
    const batch = createMessageBatch<PurgeMessage>('commerceworker-media-purge', [
      {
        id: 'purge-1',
        timestamp: new Date(),
        attempts: 1,
        body: { tags: [`cwa:${u.scope.spaceId}:main:${u.asset.id}`] },
      },
    ]);
    // The consumer purges through this Worker's own cached entrypoint (ctx.exports).
    const ctx = Object.assign(createExecutionContext(), { exports });
    await worker.queue(batch, env as never, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['purge-1']);

    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps a dead-lettered purge’s tags, so an operator can purge them by hand', async () => {
    const timestamp = new Date('2026-11-04T10:00:00.000Z');
    const tags = ['cwa:shop:main:asset-1'];
    const batch = createMessageBatch<PurgeMessage>('commerceworker-media-purge-dlq', [
      { id: 'dead-1', timestamp, attempts: 1, body: { tags } },
    ]);
    const ctx = Object.assign(createExecutionContext(), { exports });
    await worker.queue(batch, env as never, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['dead-1']);
    const kept = await env.MEDIA_BUCKET.get(
      'dlq/commerceworker-media-purge-dlq/2026-11-04/dead-1.json',
    );
    expect((await kept?.json<{ body: unknown }>())?.body).toEqual({ tags });
  });

  it('reads a D1 replica when the gate has no entry yet, and writes nothing', async () => {
    const u = await uploaded();
    await publishAsset(u.ctx, u.scope, u.asset.id);
    // The engine hasn't handled the event: no gate entry.
    expect(await gate.get(u.scope, u.asset.id)).toBeNull();
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(200);
    expect(await gate.get(u.scope, u.asset.id)).toBeNull();
  });

  it('answers 410 once the asset’s rights have expired, and 404 once the sweep takes it out', async () => {
    const u = await published();
    expect((await SELF.fetch(urlOf(u, { kind: 'original' }))).status).toBe(200);
    // Rights on a published asset apply at once: the engine carries them into the gate.
    await setAssetRights(u.ctx, u.scope, u.asset.id, {
      license: 'editorial',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await purgeMedia([`cwa:${u.scope.spaceId}:main:${u.asset.id}`]);
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(410);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The engine's expiry sweep unpublishes it; its events remove the gate and purge again.
    expect(await expireAsset(u.ctx, u.scope, u.asset.id, new Date())).toBe(true);
    expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('removed');
    await purgeMedia([`cwa:${u.scope.spaceId}:main:${u.asset.id}`]);
    expect((await SELF.fetch(urlOf(u, { kind: 'original' }))).status).toBe(404);
  });

  it('keeps serving the published version after a replace, and 404s it once a republish retires it', async () => {
    const u = await published({ bytes: 'V1-BYTES' });
    const blob = new FakeBlobStore();
    const v1 = urlOf(u, { kind: 'original' });
    expect(await textOf(await SELF.fetch(v1))).toBe('V1-BYTES');

    const r = await replaceAssetFile(u.ctx, blob, u.scope, u.asset.id, {
      fileName: 'second take.jpg',
      contentType: 'image/jpeg',
    });
    const key = `${u.scope.spaceId}/main/${u.asset.id}/v2/file-${r.commit.attempt}/second take.jpg`;
    await blob.put(key, 'x', 'image/jpeg');
    await env.MEDIA_BUCKET.put(key, 'V2-BYTES', { httpMetadata: { contentType: 'image/jpeg' } });
    await commitAssetFile(u.ctx, blob, u.scope, u.asset.id, r.commit);
    // The draft has a new file; Delivery still serves the published one, under its URL.
    expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('written');
    const before = await SELF.fetch(v1);
    expect(before.status).toBe(200);
    expect(await textOf(before)).toBe('V1-BYTES');

    await publishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await purgeMedia([`cwa:${u.scope.spaceId}:main:${u.asset.id}`]);
    const old = await SELF.fetch(v1);
    expect(old.status).toBe(404);
    expect(old.headers.get('cache-control')).toBe('no-store');
    const v2 = `${ORIGIN}${assetMediaPath({
      scope: u.scope,
      assetId: u.asset.id,
      version: 2,
      token: paths.token(u.scope, u.asset.id, 2),
      variant: { kind: 'original' },
      fileName: 'second take.jpg',
    })}`;
    const current = await SELF.fetch(v2);
    expect(current.status).toBe(200);
    expect(await textOf(current)).toBe('V2-BYTES');
    expect(current.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers 404 for an unknown variant, version or file name', async () => {
    const u = await published();
    const original = urlOf(u, { kind: 'original' });
    for (const bad of [
      original.replace('/o/', '/w123/'), // off the ladder
      original.replace('/o/', '/w4000/'),
      original.replace('/o/', '/x/'),
      urlOf(u, { kind: 'original' }, 2), // not the published version (a token of its own)
      original.replace(/\/[^/]+$/, '/other.jpg'),
      urlOf(u, { kind: 'rendition', name: 'no-such-preset' }),
      `${ORIGIN}/${u.scope.spaceId}/main/${u.asset.id}`,
    ]) {
      const res = await SELF.fetch(bad);
      expect(res.status, bad).toBe(404);
    }
    // Not something the service can resize: only the original exists.
    const pdf = await published({ contentType: 'application/pdf', fileName: 'brief.pdf' });
    expect((await SELF.fetch(urlOf(pdf, { kind: 'width', width: 640 }))).status).toBe(404);
    const doc = await SELF.fetch(urlOf(pdf, { kind: 'original' }));
    expect(doc.status).toBe(200);
  });

  it('negotiates a width step’s format from Accept and says it varies', async () => {
    const u = await published();
    const step = `${urlOf(u, { kind: 'width', width: 640 })}?fm=auto`;
    const formatFor = async (accept?: string) => {
      const res = await SELF.fetch(step, accept ? { headers: { accept } } : {});
      expect(res.status).toBe(200);
      expect(res.headers.get('vary')).toBe('Accept');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      return (await jsonOf<{ format: string }>(res)).format;
    };
    expect(await formatFor('image/avif,image/webp,*/*')).toBe('image/avif');
    expect(await formatFor('image/webp,*/*')).toBe('image/webp');
    expect(await formatFor('*/*')).toBe('image/jpeg');
    // Without fm=auto the step keeps the source's format, whatever the reader accepts.
    const plain = await SELF.fetch(urlOf(u, { kind: 'width', width: 640 }), {
      headers: { accept: 'image/avif' },
    });
    expect((await jsonOf<{ format: string }>(plain)).format).toBe('image/jpeg');
    expect(plain.headers.get('vary')).toBeNull();
  });

  it('serves a rendition with the focal point as gravity on a crop', async () => {
    const u = await published();
    await setAssetMetadata(u.ctx, u.scope, u.asset.id, { focalPoint: { x: 0.25, y: 0.75 } });
    await publishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await createAssetRendition(u.ctx, u.scope, {
      name: 'square',
      width: 400,
      height: 400,
      fit: 'crop',
      format: 'webp',
    });
    const res = await SELF.fetch(urlOf(u, { kind: 'rendition', name: 'square' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toContain(`cwr:${u.scope.spaceId}:square`);
    const body = await jsonOf<{ format: string; transforms: Record<string, unknown>[] }>(res);
    expect(body.format).toBe('image/webp');
    expect(body.transforms[0]).toMatchObject({
      width: 400,
      height: 400,
      fit: 'cover',
      gravity: { x: 0.25, y: 0.75, mode: 'box-center' },
    });
  });

  it('serves a signed draft read until it expires, and never an upload', async () => {
    const u = await uploaded({ bytes: 'DRAFT' });
    const signer = createMediaUrlSigner(env.MEDIA_SIGNING_SECRET);
    const key = u.asset.r2Key as string;
    const now = Math.floor(Date.now() / 1000);
    const fresh = await signedMediaUrl(
      signer,
      ORIGIN,
      'GET',
      key,
      new URLSearchParams({ exp: String(now + 600) }),
    );
    const ok = await SELF.fetch(fresh);
    expect(ok.status).toBe(200);
    expect(await textOf(ok)).toBe('DRAFT');
    expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);

    const expired = await signedMediaUrl(
      signer,
      ORIGIN,
      'GET',
      key,
      new URLSearchParams({ exp: String(now - 1) }),
    );
    expect((await SELF.fetch(expired)).status).toBe(403);
    // The stored, non-expiring kind is the api's alone.
    expect((await SELF.fetch(await signedMediaUrl(signer, ORIGIN, 'GET', key))).status).toBe(403);
    // Moving the expiry breaks the signature.
    expect((await SELF.fetch(expired.replace(/exp=\d+/, `exp=${now + 600}`))).status).toBe(403);
    const put = await signedMediaUrl(
      signer,
      ORIGIN,
      'PUT',
      key,
      new URLSearchParams({ ct: 'image/jpeg', exp: String(now + 600) }),
    );
    expect((await SELF.fetch(put, { method: 'PUT', body: 'x' })).status).toBe(405);
  });

  it('caps a 200 at the time its rights have left, then answers 410', async () => {
    const u = await uploaded();
    const now = Date.now();
    await u.ctx.store.assets.save(u.scope, {
      ...u.asset,
      rights: { expiresAt: new Date(now + 60_000).toISOString() },
    });
    await publishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    const deps = {
      bucket: env.MEDIA_BUCKET,
      paths,
      gate,
      store: createD1Store(env.DB),
    };
    const req = () => new Request(urlOf(u, { kind: 'original' }));

    const fresh = await serveMedia(req(), { ...deps, now: () => now });
    expect(fresh.status).toBe(200);
    const cc = fresh.headers.get('cache-control') as string;
    expect(cc).not.toContain('immutable');
    expect(Number(/max-age=(\d+)/.exec(cc)?.[1])).toBeLessThanOrEqual(60);
    expect(Number(/max-age=(\d+)/.exec(cc)?.[1])).toBeGreaterThan(0);

    const later = await serveMedia(req(), { ...deps, now: () => now + 61_000 });
    expect(later.status).toBe(410);
    expect(later.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the path token', () => {
  /** A gate and a store that count their reads. */
  function counted() {
    const reads = { gate: 0, store: 0 };
    const store = createD1Store(env.DB);
    const countingGate: AssetGate = {
      ...gate,
      get: async (s, id) => {
        reads.gate += 1;
        return gate.get(s, id);
      },
    };
    const countingStore = {
      assets: {
        ...store.assets,
        getPublished: async (
          s: Parameters<ContentStore['assets']['getPublished']>[0],
          id: string,
        ) => {
          reads.store += 1;
          return store.assets.getPublished(s, id);
        },
      },
      assetRenditions: store.assetRenditions,
    } as unknown as Pick<ContentStore, 'assets' | 'assetRenditions'>;
    return {
      reads,
      deps: { bucket: env.MEDIA_BUCKET, paths, gate: countingGate, store: countingStore },
    };
  }

  it('refuses a bad token before reading the gate or a replica', async () => {
    const u = await published();
    const { reads, deps } = counted();
    const forged = urlOf(u, { kind: 'original' }, 1, 'A'.repeat(22));
    const other = urlOf(u, { kind: 'original' }, 1, paths.token(u.scope, 'another-asset', 1));
    for (const bad of [forged, other]) {
      expect((await serveMedia(new Request(bad), deps)).status).toBe(404);
      // The gateway answers it too, without asking the cached entrypoint.
      const res = await SELF.fetch(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(reads).toEqual({ gate: 0, store: 0 });
    // The right token does read.
    expect((await serveMedia(new Request(urlOf(u, { kind: 'original' })), deps)).status).toBe(200);
    expect(reads.gate).toBe(1);
  });

  it('keeps an environment’s URL from reaching another environment’s copy of the asset', async () => {
    const u = await published();
    const staging = { spaceId: u.scope.spaceId, environmentId: 'staging' };
    await createEnvironment(u.ctx, u.scope.spaceId, 'staging');
    await cloneEnvironment(u.ctx, u.scope, staging);
    expect(await syncAssetGate(u.ctx, gate, staging, u.asset.id)).toBe('written');
    const inStaging = { scope: staging, asset: u.asset };
    expect((await SELF.fetch(urlOf(inStaging, { kind: 'original' }))).status).toBe(200);

    // Taken down in main; staging still publishes its copy.
    await unpublishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await purgeMedia([`cwa:${u.scope.spaceId}:main:${u.asset.id}`]);
    const mainUrl = urlOf(u, { kind: 'original' });
    expect((await SELF.fetch(mainUrl)).status).toBe(404);
    // Swapping the environment in main's URL keeps main's token, which staging's path refuses.
    const swapped = mainUrl.replace(`/${u.scope.spaceId}/main/`, `/${u.scope.spaceId}/staging/`);
    expect(swapped).not.toBe(mainUrl);
    expect((await SELF.fetch(swapped)).status).toBe(404);
  });

  it('serves nothing of a deleted environment, nor of one re-created with its id', async () => {
    const u = await published();
    const spaceId = u.scope.spaceId;
    const clone = { spaceId, environmentId: 'feature' };
    await createEnvironment(u.ctx, spaceId, 'feature');
    await cloneEnvironment(u.ctx, u.scope, clone);
    await syncAssetGate(u.ctx, gate, clone, u.asset.id);
    const url = urlOf({ scope: clone, asset: u.asset }, { kind: 'original' });
    expect((await SELF.fetch(url)).status).toBe(200);

    const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
    await deleteEnvironment(u.ctx, spaceId, 'feature', { confirm: 'feature', principal: admin });
    const deps = { sender: new RecordingWebhookSender(), assetGate: gate as AssetGate };
    const at = new Date().toISOString();
    await dispatchEvent(u.ctx, deps, {
      id: crypto.randomUUID(),
      type: 'environment.deleted',
      scope: clone,
      occurredAt: at,
      entryIds: [],
    });
    // A late event for the asset, handled while its rows are still there, writes nothing back.
    expect(await syncAssetGate(u.ctx, gate, clone, u.asset.id)).toBe('removed');
    let outcome = 'continued';
    while (outcome === 'continued') {
      outcome = await runEnvironmentPurge(
        u.ctx,
        { assetGate: gate },
        { id: crypto.randomUUID(), type: 'environment.purge_due', scope: clone, occurredAt: at },
      );
    }
    await purgeMedia([`cwe:${spaceId}:feature`]);
    expect(await gate.get(clone, u.asset.id)).toBeNull();
    expect((await SELF.fetch(url)).status).toBe(404);

    // The same id again, the asset back as a draft: still nothing to serve.
    await createEnvironment(u.ctx, spaceId, 'feature');
    await cloneEnvironment(u.ctx, u.scope, clone, { publish: false });
    expect(await u.ctx.store.assets.get(clone, u.asset.id)).toMatchObject({ status: 'draft' });
    expect((await SELF.fetch(url)).status).toBe(404);
  });
});

describe('byte ranges', () => {
  // 'JPEG-BYTES': ten bytes.
  const get = (u: Awaited<ReturnType<typeof published>>, headers: Record<string, string>) =>
    SELF.fetch(urlOf(u, { kind: 'original' }), { headers });

  it('serves one range of an original as a 206 read from R2 by range', async () => {
    const u = await published();
    const full = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const etag = full.headers.get('etag') as string;
    await full.body?.cancel();

    for (const [range, body, contentRange] of [
      ['bytes=2-5', 'EG-B', 'bytes 2-5/10'],
      ['bytes=7-', 'TES', 'bytes 7-9/10'],
      ['bytes=-5', 'BYTES', 'bytes 5-9/10'],
      ['bytes=8-100', 'ES', 'bytes 8-9/10'], // an end past the file is clipped
      ['bytes=-100', 'JPEG-BYTES', 'bytes 0-9/10'], // a suffix longer than it is all of it
    ] as const) {
      const res = await get(u, { range });
      expect(res.status, range).toBe(206);
      expect(await textOf(res)).toBe(body);
      expect(res.headers.get('content-range')).toBe(contentRange);
      expect(res.headers.get('content-length')).toBe(String(body.length));
      expect(res.headers.get('etag')).toBe(etag);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('access-control-expose-headers')).toContain('content-range');
    }
    // A HEAD says the same, without the bytes.
    const head = await SELF.fetch(urlOf(u, { kind: 'original' }), {
      method: 'HEAD',
      headers: { range: 'bytes=0-3' },
    });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe('bytes 0-3/10');
  });

  it('answers 416 for a range past the end, and the whole file for anything it does not slice', async () => {
    const u = await published();
    for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0']) {
      const res = await get(u, { range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */10');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    for (const range of ['bytes=0-1,4-5', 'items=0-3', 'bytes=abc', 'bytes=-']) {
      const res = await get(u, { range });
      expect(res.status, range).toBe(200);
      expect(await textOf(res)).toBe('JPEG-BYTES');
      expect(res.headers.get('content-range')).toBeNull();
    }
  });

  it('honours If-Range only while it names the file', async () => {
    const u = await published();
    const etag = (await SELF.fetch(urlOf(u, { kind: 'original' }))).headers.get('etag') as string;
    const same = await get(u, { range: 'bytes=0-3', 'if-range': etag });
    expect(same.status).toBe(206);
    expect(await textOf(same)).toBe('JPEG');
    for (const ifRange of ['"stale"', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const stale = await get(u, { range: 'bytes=0-3', 'if-range': ifRange });
      expect(stale.status, ifRange).toBe(200);
      expect(await textOf(stale)).toBe('JPEG-BYTES');
    }
  });

  it('serves a variant whole, and gates a range like any read', async () => {
    const u = await published();
    const step = await SELF.fetch(urlOf(u, { kind: 'width', width: 640 }), {
      headers: { range: 'bytes=0-3' },
    });
    expect(step.status).toBe(200);
    expect(step.headers.get('content-range')).toBeNull();
    await step.body?.cancel();

    await unpublishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await purgeMedia([`cwa:${u.scope.spaceId}:main:${u.asset.id}`]);
    expect((await get(u, { range: 'bytes=0-3' })).status).toBe(404);
    // The range read checks the gate itself, whoever calls it.
    const deps = { bucket: env.MEDIA_BUCKET, paths, gate, store: createD1Store(env.DB) };
    const direct = await serveMediaRange(
      new Request(urlOf(u, { kind: 'original' })),
      deps,
      'bytes=0-3',
      null,
    );
    expect(direct.status).toBe(404);
  });

  it('never answers the cached entrypoint with a partial: the cache slices the whole file', async () => {
    const u = await published();
    const deps = { bucket: env.MEDIA_BUCKET, paths, gate, store: createD1Store(env.DB) };
    const res = await serveMedia(
      new Request(urlOf(u, { kind: 'original' }), { headers: { range: 'bytes=0-3' } }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await textOf(res)).toBe('JPEG-BYTES');
  });

  it('reads a range as RFC 9110 does', () => {
    expect(byteRange('bytes=0-0', 10)).toEqual({ offset: 0, length: 1 });
    expect(byteRange(' bytes = 3 - 4 ', 10)).toBeNull(); // not the shape we pass on
    expect(byteRange('bytes=3-4', 10)).toEqual({ offset: 3, length: 2 });
    expect(byteRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(byteRange('bytes=-1', 0)).toBe('unsatisfiable');
    expect(byteRange(null, 10)).toBeNull();
    expect(byteRange('bytes= 2 - 3 ', 10)).toEqual({ offset: 2, length: 2 });
    for (const bad of [
      'bytes=',
      'bytes=-',
      'bytes=1-2-3',
      'bytes=a-2',
      'bytes=1,2-3',
      'items=1-2',
    ]) {
      expect(byteRange(bad, 10), bad).toBeNull();
    }
  });

  it('reads a hostile Range header in linear time', () => {
    const start = performance.now();
    expect(byteRange(`bytes=${' '.repeat(100_000)}x`, 10)).toBeNull();
    expect(byteRange(`bytes=${' '.repeat(100_000)}-${' '.repeat(100_000)}x`, 10)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('downloads', () => {
  it('serves inline by default and as an attachment with ?download, from one cache entry', async () => {
    const u = await published();
    const inline = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(inline.headers.get('content-disposition')).toBe(
      `inline; filename="hero shot.jpg"; filename*=UTF-8''hero%20shot.jpg`,
    );
    await inline.body?.cancel();
    const download = await SELF.fetch(`${urlOf(u, { kind: 'original' })}?download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="hero shot.jpg"; filename*=UTF-8''hero%20shot.jpg`,
    );
    expect(await textOf(download)).toBe('JPEG-BYTES');
    // A range of a download is still a download.
    const part = await SELF.fetch(`${urlOf(u, { kind: 'original' })}?download=1`, {
      headers: { range: 'bytes=0-3' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-disposition')).toMatch(/^attachment; /);
    // `?download` never reaches the cache key.
    const plainUrl = new URL(urlOf(u, { kind: 'original' }));
    const downloadUrl = new URL(`${plainUrl}?download`);
    expect(canonicalMediaUrl(downloadUrl, null, paths)?.url).toBe(
      canonicalMediaUrl(plainUrl, null, paths)?.url,
    );
  });

  it('keeps a type that must never render here an attachment, ?download or not', async () => {
    const u = await published({ contentType: 'image/svg+xml', fileName: 'logo.svg' });
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.svg"/);
  });

  it('encodes any file name safely, with an ASCII stand-in', () => {
    expect(contentDisposition('attachment', 'café "menu"\r\nX-Evil: 1.pdf')).toBe(
      `attachment; filename="caf_ _menu___X-Evil: 1.pdf"; ` +
        `filename*=UTF-8''caf%C3%A9%20%22menu%22%0D%0AX-Evil%3A%201.pdf`,
    );
    expect(contentDisposition('inline', "it's (1)*.png")).toBe(
      `inline; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`,
    );
    expect(contentDisposition('inline', 'a\\b.png')).toMatch(/^inline; filename="a_b.png"/);
  });
});

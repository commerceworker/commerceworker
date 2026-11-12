import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createKvAssetGate } from '@commerceworker/adapters/asset-gate-kv';
import { createMediaPathSigner } from '@commerceworker/adapters/blob-r2';
import {
  type AppContext,
  commitAssetFile,
  createAsset,
  createSpace,
  publishAsset,
  replaceAssetFile,
  setAssetRights,
  syncAssetGate,
  unpublishAsset,
} from '@commerceworker/application';
import { assetMediaPath } from '@commerceworker/domain';
import { createD1Store } from '@commerceworker/store';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseAssetRefPath, serveAssetRef } from '../src/asset-ref';

const ORIGIN = 'https://media.example.test';
// The Worker resolves a reference in the platform's default space and environment.
const scope = { spaceId: 'space-1', environmentId: 'main' };

const ctx: AppContext = {
  store: createD1Store(env.DB),
  clock: { now: () => new Date() },
  ids: { newId: () => crypto.randomUUID() },
};
const gate = createKvAssetGate(env.KV_CACHE);
const paths = createMediaPathSigner(env.MEDIA_SIGNING_SECRET);

beforeAll(async () => {
  await createSpace(ctx, { spaceId: scope.spaceId, name: 'Media', defaultLocale: 'en-US' });
});

async function published(contentType = 'image/jpeg', fileName = 'hero shot.jpg') {
  const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, { fileName, contentType });
  await env.MEDIA_BUCKET.put(asset.r2Key as string, 'JPEG-BYTES', {
    httpMetadata: { contentType },
  });
  await publishAsset(ctx, scope, asset.id);
  expect(await syncAssetGate(ctx, gate, scope, asset.id)).toBe('written');
  return asset;
}

const textOf = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());
const ref = (path: string) => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

const vars = env as unknown as { ASSET_REF_SPACE?: string; ASSET_REF_ENV?: string };
afterEach(() => {
  delete vars.ASSET_REF_SPACE;
  delete vars.ASSET_REF_ENV;
});

describe('the asset reference route', () => {
  it('redirects to the signed published URL of the current version, cacheable for a minute', async () => {
    const asset = await published();
    const res = await ref(`/a/${asset.id}`);
    expect(res.status).toBe(302);
    const expected = `${ORIGIN}${assetMediaPath({
      scope,
      assetId: asset.id,
      version: 1,
      token: paths.token(scope, asset.id, 1),
      variant: { kind: 'original' },
      fileName: 'hero shot.jpg',
    })}`;
    expect(res.headers.get('location')).toBe(expected);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    // Nothing about the reader varies it, and it is readable cross-origin like the file.
    expect(res.headers.get('vary')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // The target is a real, served file.
    const file = await SELF.fetch(expected);
    expect(file.status).toBe(200);
    expect(await textOf(file)).toBe('JPEG-BYTES');
    // HEAD answers the same redirect.
    const head = await SELF.fetch(`${ORIGIN}/a/${asset.id}`, {
      method: 'HEAD',
      redirect: 'manual',
    });
    expect(head.status).toBe(302);
    expect(head.headers.get('location')).toBe(expected);
  });

  it('names a variant: a ladder width negotiates, a rendition is its own segment', async () => {
    const asset = await published();
    const width = await ref(`/a/${asset.id}/w640`);
    expect(width.status).toBe(302);
    const loc = new URL(width.headers.get('location') as string);
    expect(loc.pathname).toContain('/w640/hero%20shot.jpg');
    expect(loc.searchParams.get('fm')).toBe('auto');
    const rendition = await ref(`/a/${asset.id}/r-hero`);
    expect(rendition.status).toBe(302);
    expect(new URL(rendition.headers.get('location') as string).pathname).toContain('/r-hero/');
    const original = await ref(`/a/${asset.id}/o`);
    expect(new URL(original.headers.get('location') as string).pathname).toContain('/o/');
  });

  it('answers 400 for a variant that is none, and 404 for a variant of a file that has none', async () => {
    const asset = await published();
    for (const bad of ['w123', 'w4000', 'x', 'r-', 'r-Bad_Name']) {
      const res = await ref(`/a/${asset.id}/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    // A bad variant is 400 whether or not the asset exists: it says nothing of existence.
    expect((await ref('/a/no-such-asset/w123')).status).toBe(400);
    const pdf = await published('application/pdf', 'brief.pdf');
    expect((await ref(`/a/${pdf.id}/w640`)).status).toBe(404);
    expect((await ref(`/a/${pdf.id}`)).status).toBe(302);
  });

  it('answers the same 404 for an unknown, an unpublished and an expired asset', async () => {
    const unknown = await ref('/a/no-such-asset');
    expect(unknown.status).toBe(404);
    // Cached briefly, so probing unknown ids doesn't reach the replica every time.
    expect(unknown.headers.get('cache-control')).toBe('public, max-age=30');
    const body = await unknown.text();

    // Never published: a draft is private.
    const { asset: draft } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'draft.jpg',
      contentType: 'image/jpeg',
    });
    const res = await ref(`/a/${draft.id}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(body);

    // Unpublished after the fact: the gate follows the snapshot.
    const was = await published();
    expect((await ref(`/a/${was.id}`)).status).toBe(302);
    await unpublishAsset(ctx, scope, was.id);
    await syncAssetGate(ctx, gate, scope, was.id);
    expect((await ref(`/a/${was.id}`)).status).toBe(404);

    // Past its rights: 404, not the file's 410, so the id's existence stays private.
    const lapsed = await published();
    await setAssetRights(ctx, scope, lapsed.id, {
      license: 'editorial',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    await syncAssetGate(ctx, gate, scope, lapsed.id);
    expect((await ref(`/a/${lapsed.id}`)).status).toBe(404);

    // An id that isn't one never reaches a lookup.
    expect((await ref('/a/has.a.dot')).status).toBe(404);
    expect((await ref('/a/%E0%A4%A')).status).toBe(404);
  });

  it('never lives longer than the rights have left', async () => {
    const asset = await published();
    await setAssetRights(ctx, scope, asset.id, {
      license: 'editorial',
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });
    await syncAssetGate(ctx, gate, scope, asset.id);
    const res = await ref(`/a/${asset.id}`);
    expect(res.status).toBe(302);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(20);
  });

  it('follows a replaced file to its new version, and falls back to a replica without the gate', async () => {
    const asset = await published();
    const blob = new FakeBlobStore();
    const r = await replaceAssetFile(ctx, blob, scope, asset.id, {
      fileName: 'second take.jpg',
      contentType: 'image/jpeg',
    });
    const key = `${scope.spaceId}/main/${asset.id}/v2/file-${r.commit.attempt}/second take.jpg`;
    await blob.put(key, 'x', 'image/jpeg');
    await env.MEDIA_BUCKET.put(key, 'V2-BYTES', { httpMetadata: { contentType: 'image/jpeg' } });
    await commitAssetFile(ctx, blob, scope, asset.id, r.commit);
    // The draft has a new file; readers still get the published one.
    expect(
      new URL((await ref(`/a/${asset.id}`)).headers.get('location') as string).pathname,
    ).toContain('/v1/');
    await publishAsset(ctx, scope, asset.id);
    await syncAssetGate(ctx, gate, scope, asset.id);
    const res = await ref(`/a/${asset.id}`);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toContain('/v2/');
    expect(loc.pathname.endsWith('/second%20take.jpg')).toBe(true);
    expect(await textOf(await SELF.fetch(loc.href))).toBe('V2-BYTES');

    // No gate entry yet (the engine hasn't written it): a replica answers, and writes nothing.
    await gate.delete(scope, asset.id);
    const viaReplica = await serveAssetRef(
      new URL(`${ORIGIN}/a/${asset.id}`),
      { id: asset.id },
      {
        paths,
        scope,
        store: ctx.store,
      },
    );
    expect(viaReplica.status).toBe(302);
    expect(await gate.get(scope, asset.id)).toBeNull();
  });

  it('resolves in the configured media scope, and 404s for an asset in another one', async () => {
    const inDefault = await published();
    const other = { spaceId: 'media-scope-shop', environmentId: 'live' };
    await createSpace(ctx, { spaceId: other.spaceId, name: 'Shop', defaultLocale: 'en-US' });
    const { asset } = await createAsset(ctx, new FakeBlobStore(), other, {
      fileName: 'shop.jpg',
      contentType: 'image/jpeg',
    });
    await env.MEDIA_BUCKET.put(asset.r2Key as string, 'SHOP', {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await publishAsset(ctx, other, asset.id);
    await syncAssetGate(ctx, gate, other, asset.id);

    // Unset: the defaults, where only the first asset is.
    expect((await ref(`/a/${inDefault.id}`)).status).toBe(302);
    expect((await ref(`/a/${asset.id}`)).status).toBe(404);

    vars.ASSET_REF_SPACE = other.spaceId;
    vars.ASSET_REF_ENV = other.environmentId;
    const res = await ref(`/a/${asset.id}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(
      loc.pathname.startsWith(`/${other.spaceId}/${other.environmentId}/${asset.id}/v1/`),
    ).toBe(true);
    expect(await textOf(await SELF.fetch(loc.href))).toBe('SHOP');
    // The default scope's asset is no longer reachable by its reference.
    expect((await ref(`/a/${inDefault.id}`)).status).toBe(404);
  });

  it('is a route only of its own shape: a published URL of a space named a is not one', () => {
    expect(parseAssetRefPath('/a/abc')).toEqual({ id: 'abc' });
    expect(parseAssetRefPath('/a/abc/w640')).toEqual({ id: 'abc', variant: 'w640' });
    expect(parseAssetRefPath('/a')).toBeNull();
    expect(parseAssetRefPath('/a/')).toEqual({ id: '' });
    expect(parseAssetRefPath('/a/main/id/v1/tokentokentokentokentok/o/file.jpg')).toBeNull();
    expect(parseAssetRefPath('/b/abc')).toBeNull();
  });
});

/**
 * What the Management API sends for an asset: every route that answers with one (or a page, a
 * version list, a collection's members) goes through the one serializer, so the server's own
 * bookkeeping (`r2Key`, where the bytes live in the bucket) never reaches a client. And the
 * model-backed asset routes answer the in-memory wiring's stub provider (a string where each list
 * was asked for) without a 500.
 */
import type { ApiConfig } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { SERVER_ONLY_ASSET_FIELDS } from '../../src/api/asset-response';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});
const scope = { spaceId: 's1', environmentId: 'main' };
const M = '/spaces/s1/environments/main';
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };

function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers: cma,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  };
  return { wired, send };
}

describe('Management asset responses', () => {
  it('no asset route sends r2Key, the server’s storage key', async () => {
    const { wired, send } = makeApp();
    const sent: [string, string][] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}: ${res.text}`).toBeLessThan(300);
      sent.push([`${method} ${path}`, res.text]);
      return JSON.parse(res.text) as Record<string, unknown>;
    };

    const created = await call('POST', '/assets', {
      fileName: 'hero.png',
      contentType: 'image/png',
    });
    const id = (created.asset as { id: string }).id;
    await wired.blob.put(`s1/main/${id}/hero.png`, 'v1', 'image/png');
    await call('GET', `/assets/${id}`);
    await call('GET', '/assets');
    await call('GET', '/assets/search?q=hero');
    await call('PATCH', `/assets/${id}/metadata`, { altText: { 'en-US': 'A hero' } });
    await call('PUT', `/assets/${id}/rights`, { credit: 'Ana' });
    await call('POST', `/assets/${id}/published`);
    await call('DELETE', `/assets/${id}/published`);
    await call('POST', `/assets/${id}/archive`);
    await call('POST', `/assets/${id}/restore`);
    const replace = (await call('POST', `/assets/${id}/file`, {
      fileName: 'hero-2.png',
      contentType: 'image/png',
    })) as { commit: { version: number; fileName: string; attempt: string } };
    await wired.blob.put(
      `s1/main/${id}/v2/file-${replace.commit.attempt}/hero-2.png`,
      'v2',
      'image/png',
    );
    await call('POST', `/assets/${id}/file/commit`, replace.commit);
    await call('GET', `/assets/${id}/versions`);
    await call('POST', `/assets/${id}/versions/1/restore`);
    await call('POST', `/assets/${id}/file/uploads`, {
      fileName: 'hero-big.png',
      contentType: 'image/png',
      size: 200 * 1024 * 1024,
    });
    await call('POST', '/assets/uploads', {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
      size: 200 * 1024 * 1024,
    });
    const collection = (await call('POST', '/asset-collections', { name: 'Kit' })) as {
      id: string;
    };
    await call('POST', `/asset-collections/${collection.id}/assets`, { assetIds: [id] });
    await call('GET', `/asset-collections/${collection.id}/assets`);

    // There was a key to strip: the store keeps one for the asset and for each version.
    expect((await wired.ctx.store.assets.get(scope, id))?.r2Key).toBeTruthy();
    for (const [route, text] of sent) {
      for (const field of SERVER_ONLY_ASSET_FIELDS) expect(text, route).not.toContain(field);
    }
  });

  it('suggests tags and alt text from the stub provider’s malformed answers, never a 500', async () => {
    const { wired, send } = makeApp();
    const created = JSON.parse(
      (await send('POST', '/assets', { fileName: 'beach.png', contentType: 'image/png' })).text,
    ) as { asset: { id: string } };
    const id = created.asset.id;
    await send('POST', '/taxonomy/tags', { name: 'beach' });

    // The stub answers `"Sample existingTags"` for a list: no tags, nothing created or applied.
    const tagged = await send('POST', `/assets/${id}/auto-tag`, { apply: true });
    expect(tagged.status, tagged.text).toBe(200);
    expect(JSON.parse(tagged.text)).toMatchObject({ tagIds: [], newTags: [], applied: true });
    expect((await wired.ctx.store.assets.get(scope, id))?.metadata.tags).toEqual([]);

    const alt = await send('POST', `/assets/${id}/alt-text`, {});
    expect(alt.status, alt.text).toBe(200);
    expect(JSON.parse(alt.text)).toMatchObject({ altText: expect.any(String), applied: false });
  });
});

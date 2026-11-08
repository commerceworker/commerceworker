/**
 * sdk-management's asset surface driven against the real api, in process: every route the client
 * calls exists with the verb and body it sends, and the error guards narrow the bodies the api
 * actually writes (not a fake's idea of them).
 */
import type { ApiConfig } from '@commerceworker/platform/config';
import {
  createManagementClient,
  isAssetInUse,
  isAssetRightsError,
  isConflict,
  isNotFound,
  isValidationError,
  type ManagementClient,
} from '@commerceworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

function client(token = 'cma'): ManagementClient {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  return createManagementClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token,
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
}

const failure = (p: Promise<unknown>) => p.then(() => expect.fail('resolved')).catch((e) => e);

const image = async (cma: ManagementClient, fileName = 'hero.png') =>
  (await cma.assets.create({ fileName, contentType: 'image/png' })).asset;

describe('sdk-management assets against the api', () => {
  it('reads a typed asset: file and metadata', async () => {
    const cma = client();
    const created = await image(cma);
    await cma.assets.setMetadata(created.id, {
      altText: { 'en-US': 'A hero' },
      focalPoint: { x: 0.25, y: 0.75 },
    });
    const got = await cma.assets.get(created.id);
    expect(got.file.contentType).toBe('image/png');
    expect(got.file.fileName).toBe('hero.png');
    expect(got.metadata.altText['en-US']).toBe('A hero');
    expect(got.metadata.focalPoint).toEqual({ x: 0.25, y: 0.75 });
    expect(got.metadata.tags).toEqual([]);
  });

  it('refuses a mistyped metadata patch field by field', async () => {
    const cma = client();
    const created = await image(cma);
    const err = await failure(
      cma.assets.setMetadata(created.id, { tags: 'not-a-list' } as unknown as { tags: string[] }),
    );
    expect(isValidationError(err)).toBe(true);
    if (isValidationError(err)) expect(err.error.issues[0]?.field).toBe('tags');
    // The same patches MCP's asset_set_metadata refuses (test/mcp/asset-tools.test.ts).
    for (const patch of [{ altText: { 'en-US': 5 } }, { tags: ['x'.repeat(129)] }]) {
      const refused = await failure(
        cma.assets.setMetadata(created.id, patch as unknown as { tags: string[] }),
      );
      expect(isValidationError(refused), JSON.stringify(patch)).toBe(true);
    }
  });

  it('narrows an embargo and an expiry refused at publish', async () => {
    const cma = client();
    const embargoed = await image(cma, 'a.png');
    await cma.assets.setRights(embargoed.id, { embargoUntil: '2999-01-01T00:00:00Z' });
    const err = await failure(cma.assets.publish(embargoed.id));
    expect(err).toMatchObject({ status: 409, code: 'asset_embargoed' });
    expect(isAssetRightsError(err)).toBe(true);
    if (isAssetRightsError(err) && err.error.code === 'asset_embargoed') {
      expect(err.error.embargoUntil).toBe('2999-01-01T00:00:00.000Z');
    }

    const expired = await image(cma, 'b.png');
    await cma.assets.setRights(expired.id, { expiresAt: '2001-01-01T00:00:00Z' });
    const late = await failure(cma.assets.publish(expired.id));
    expect(isAssetRightsError(late)).toBe(true);
    if (isAssetRightsError(late) && late.error.code === 'asset_expired') {
      expect(late.error.expiresAt).toBe('2001-01-01T00:00:00.000Z');
    } else {
      expect.fail('not narrowed to asset_expired');
    }
  });

  it('narrows a delete refused while an entry links to the asset', async () => {
    const cma = client();
    const asset = await image(cma);
    await cma.contentTypes.create({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        { apiId: 'title', name: 'Title', type: 'Symbol', localized: false, required: true },
        { apiId: 'hero', name: 'Hero', type: 'Link', linkType: 'Asset' },
      ],
    });
    await cma.contentTypes.publish('article');
    const { entry } = await cma.entries.create({
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': 'Linking' },
        hero: { 'en-US': { id: asset.id, linkType: 'Asset' } },
      },
    });
    // Links are indexed when the entry is published.
    await cma.assets.publish(asset.id);
    await cma.entries.publish(entry.id);

    const links = await cma.assets.usage(asset.id);
    expect(links).toEqual([expect.objectContaining({ fromEntryId: entry.id, fromField: 'hero' })]);

    const err = await failure(cma.assets.delete(asset.id));
    expect(isAssetInUse(err)).toBe(true);
    if (!isAssetInUse(err)) return;
    expect(err.error.total).toBe(1);
    expect(err.error.usage[0]).toMatchObject({
      fromEntryId: entry.id,
      contentTypeApiId: 'article',
      entryTitle: 'Linking',
    });
  });

  it('manages rendition presets, with a conflict and a not-found the guards recognise', async () => {
    const cma = client();
    const made = await cma.assets.renditions.create({ name: 'thumb', width: 200, fit: 'crop' });
    expect(made).toMatchObject({ name: 'thumb', width: 200, fit: 'crop' });
    const taken = await failure(cma.assets.renditions.create({ name: 'thumb', width: 64 }));
    expect(isConflict(taken)).toBe(true);

    const replaced = await cma.assets.renditions.update('thumb', { width: 320, format: 'webp' });
    expect(replaced).toMatchObject({ name: 'thumb', width: 320, format: 'webp' });
    expect(replaced.fit).toBeUndefined();
    expect((await cma.assets.renditions.list()).map((r) => r.name)).toEqual(['thumb']);
    expect(await cma.assets.renditions.get('thumb')).toMatchObject({ width: 320 });

    await cma.assets.renditions.delete('thumb');
    expect(isNotFound(await failure(cma.assets.renditions.get('thumb')))).toBe(true);
  });

  it('resolves a transform URL for an image, and refuses one for a document', async () => {
    const cma = client();
    const img = await image(cma);
    const out = await cma.assets.transformUrl(img.id, { width: 400, fit: 'crop', format: 'webp' });
    expect(out.url).toContain('w=400');
    // From a fresh short-lived read URL, not the stored one.
    expect(out.url).toContain('ttl=900');
    expect(out.transform).toMatchObject({ width: 400, fit: 'crop', format: 'webp' });

    const pdf = (await cma.assets.create({ fileName: 'b.pdf', contentType: 'application/pdf' }))
      .asset;
    expect(isValidationError(await failure(cma.assets.transformUrl(pdf.id, { width: 10 })))).toBe(
      true,
    );
  });

  it('suggests alt text and applies it on request', async () => {
    const cma = client();
    const img = await image(cma);
    const suggested = await cma.assets.generateAltText(img.id, { apply: true });
    expect(suggested.applied).toBe(true);
    expect(suggested.locale).toBe('en-US');
    expect((await cma.assets.get(img.id)).metadata.altText['en-US']).toBe(suggested.altText);
  });

  it('suggests tags against the stub provider without a 500, and applies nothing it lacks', async () => {
    const cma = client();
    const img = await image(cma);
    // The in-memory wiring's stub answers a string where the tag lists were asked for: that is no
    // suggestion, not a TypeError.
    const tagged = await cma.assets.autoTag(img.id, { apply: true });
    expect(tagged).toMatchObject({ tagIds: [], newTags: [], applied: true });
    expect(tagged.usage).toEqual({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect((await cma.assets.get(img.id)).metadata.tags).toEqual([]);
  });

  it('never receives the server’s storage key', async () => {
    const cma = client();
    const img = await image(cma);
    expect(img).not.toHaveProperty('r2Key');
    expect(await cma.assets.get(img.id)).not.toHaveProperty('r2Key');
    expect(await cma.assets.publish(img.id)).not.toHaveProperty('r2Key');
  });

  it('answers a video create with not_configured when no video host is bound', async () => {
    const cma = client();
    const err = await failure(
      cma.assets.videos.create({ fileName: 'clip.mp4', contentType: 'video/mp4' }),
    );
    expect(err).toMatchObject({ status: 501, code: 'not_configured' });
  });

  it('iterates the library and a collection across pages', async () => {
    const cma = client();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await image(cma, `p${i}.png`)).id);
    const seen: string[] = [];
    for await (const a of cma.assets.iterate({ limit: 2 })) seen.push(a.id);
    expect(seen.sort()).toEqual([...ids].sort());

    const collection = await cma.assets.collections.create({ name: 'Campaign' });
    await cma.assets.collections.create({ name: 'Brand' });
    await cma.assets.collections.add(collection.id, ids);
    const members: string[] = [];
    for await (const a of cma.assets.collections.iterateAssets(collection.id, { limit: 2 })) {
      members.push(a.id);
    }
    expect(members).toEqual(ids);
    const names: string[] = [];
    for await (const c of cma.assets.collections.iterate({ limit: 1 })) names.push(c.name);
    expect(names).toEqual(['Brand', 'Campaign']);
  });

  it('a read-only key gets forbidden, not a guard match', async () => {
    const cpa = client('cpa');
    const err = await failure(cpa.assets.renditions.create({ name: 'og', width: 1200 }));
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
    expect(isConflict(err) || isNotFound(err) || isValidationError(err)).toBe(false);
  });
});

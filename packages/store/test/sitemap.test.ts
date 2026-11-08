import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deliveredSitemapFile,
  listDeliveredSitemap,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setEntrySeo,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The sitemap's read on D1: the slugs and Seo field picked out of each published body in SQL
 * (nothing else of the body comes back), pages by entry id, the page boundaries a sitemap index
 * lists, content types past the 100-parameter cap (one JSON parameter), and scope isolation. Each
 * test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

async function harness() {
  const ctx: AppContext = {
    store,
    clock: new FixedClock(new Date('2026-01-01T00:00:00.000Z')),
    ids: { newId: uid },
  };
  const spaceId = `sitemap-${uid()}`;
  await createSpace(ctx, {
    spaceId,
    name: 'Sitemap',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  const scope = { spaceId, environmentId: 'main' };
  const defineType = async (apiId: string, urlPattern: string, at = scope) => {
    await createContentType(ctx, SYSTEM_CALLER, at, {
      apiId,
      name: apiId,
      displayField: 'title',
      urlPattern,
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        field({ apiId: 'slug', type: 'Slug', position: 1, localized: true }),
        field({ apiId: 'seo', type: 'Seo', position: 2, localized: true }),
        field({ apiId: 'body', type: 'RichText', position: 3 }),
      ],
    });
    await publishContentType(ctx, at, apiId);
  };
  const page = async (
    type: string,
    fields: Record<string, Record<string, unknown>>,
    at = scope,
  ) => {
    const { entry } = await createEntry(ctx, at, { contentTypeApiId: type, fields });
    await publishEntry(ctx, at, entry.id);
    return entry.id;
  };
  return { ctx, scope, defineType, page };
}

describe('the sitemap on D1', () => {
  it('reads only the slugs and the Seo field of each published body, per locale', async () => {
    const { ctx, scope, defineType, page } = await harness();
    await defineType('article', '/{locale}/blog/{slug}');
    const id = await page('article', {
      title: { 'en-US': 'Hello' },
      slug: { 'en-US': 'hello', de: 'hallo' },
      seo: { 'en-US': { title: 'Hello | Blog' }, de: { noindex: true } },
      body: {
        'en-US': {
          nodeType: 'document',
          content: [
            { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'x', marks: [] }] },
          ],
        },
      },
    });
    const read = await store.delivery.read(scope, {
      sitemap: { contentTypes: ['article'], fields: ['slug', 'seo', 'missing'], limit: 10 },
    });
    expect(read.sitemap).toEqual({
      items: [
        {
          entryId: id,
          contentTypeApiId: 'article',
          fields: {
            slug: { 'en-US': 'hello', de: 'hallo' },
            seo: { 'en-US': { title: 'Hello | Blog' }, de: { noindex: true } },
          },
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    // German is noindex: only the English URL is listed.
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([
      expect.objectContaining({
        entryId: id,
        urls: [{ path: '/en-US/blog/hello', locale: 'en-US' }],
      }),
    ]);
  });

  it('pages by entry id and answers each page’s first id for the index', async () => {
    const { ctx, scope, defineType, page } = await harness();
    await defineType('article', '/blog/{slug}');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await page('article', { slug: { 'en-US': `p-${i}` } }));
    ids.sort();
    const read = await store.delivery.read(scope, {
      sitemap: {
        contentTypes: ['article'],
        fields: ['slug'],
        from: ids[2],
        limit: 3,
        pageStarts: 3,
      },
    });
    expect(read.sitemap?.items.map((r) => r.entryId)).toEqual(ids.slice(2, 5));
    expect(read.sitemap?.pageStarts).toEqual([ids[0], ids[3], ids[6]]);

    const bounded = await store.delivery.read(scope, {
      sitemap: {
        contentTypes: ['article'],
        fields: ['slug'],
        from: ids[2],
        before: ids[4],
        limit: 10,
      },
    });
    expect(bounded.sitemap?.items.map((r) => r.entryId)).toEqual(ids.slice(2, 4));

    const file = await deliveredSitemapFile(ctx, scope, undefined, { pageSize: 3 });
    expect(file).toEqual({
      kind: 'index',
      pages: [`,${ids[3]}`, `${ids[3]},${ids[6]}`, `${ids[6]},`],
    });
    const last = await deliveredSitemapFile(ctx, scope, `${ids[6]},`, { pageSize: 3 });
    expect(last.kind === 'urlset' && last.items.map((e) => e.entryId)).toEqual([ids[6]]);
  });

  it('lists entries of more content types than one statement could bind', async () => {
    const { ctx, scope, defineType, page } = await harness();
    const types = Array.from({ length: 105 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    for (const t of types) await defineType(t, `/${t}/{slug}`);
    await page('t000', { slug: { 'en-US': 'first' } });
    await page('t104', { slug: { 'en-US': 'last' } });
    const paths = (await listDeliveredSitemap(ctx, scope)).items.flatMap((e) =>
      e.urls.map((u) => u.path),
    );
    expect(paths.sort()).toEqual(['/t000/first', '/t104/last']);
  });

  it('answers each environment with its own published entries', async () => {
    const { ctx, scope, defineType, page } = await harness();
    const staging = { ...scope, environmentId: 'staging' };
    await createEnvironment(ctx, scope.spaceId, 'staging');
    await defineType('article', '/blog/{slug}');
    await defineType('article', '/blog/{slug}', staging);
    const live = await page('article', { slug: { 'en-US': 'live' } });
    await page('article', { slug: { 'en-US': 'staged' } }, staging);
    expect((await listDeliveredSitemap(ctx, scope)).items.map((e) => e.entryId)).toEqual([live]);
    const other = await harness();
    expect(await listDeliveredSitemap(other.ctx, other.scope)).toEqual({ items: [], next: null });
  });

  it('follows an SEO edit only once it is published', async () => {
    const { ctx, scope, defineType, page } = await harness();
    await defineType('article', '/blog/{slug}');
    const id = await page('article', { slug: { 'en-US': 'hello' } });
    await setEntrySeo(ctx, scope, id, { noindex: true });
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(1);
    await publishEntry(ctx, scope, id);
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(0);
  });
});

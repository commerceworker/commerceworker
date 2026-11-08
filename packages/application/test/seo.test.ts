import type { FieldDefinition, Principal } from '@commerceworker/domain';
import { ValidationError } from '@commerceworker/domain';
import type { DeliveryReadRequest } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deliveredSitemapFile,
  deliveryReads,
  getPublishedEntry,
  listDeliveredSitemap,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setEntrySeo,
  unpublishEntry,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

let store: InMemoryContentStore;
let clock: FixedClock;
let ctx: AppContext;
/** Every request the store's batched read received, in order. */
let sent: DeliveryReadRequest[];

const defineType = async (
  apiId: string,
  opts: { urlPattern?: string; seo?: Partial<FieldDefinition> | false; at?: typeof scope } = {},
) => {
  const at = opts.at ?? scope;
  await createContentType(ctx, SYSTEM_CALLER, at, {
    apiId,
    name: apiId,
    displayField: 'title',
    ...(opts.urlPattern !== undefined ? { urlPattern: opts.urlPattern } : {}),
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'slug', type: 'Slug', position: 1 }),
      ...(opts.seo === false
        ? []
        : [field({ apiId: 'seo', type: 'Seo', position: 2, ...(opts.seo ?? {}) })]),
    ],
  });
  await publishContentType(ctx, at, apiId);
};

/** A published entry of `type` with this slug; returns its id. */
const page = async (
  type: string,
  slug: string,
  extra: Record<string, Record<string, unknown>> = {},
  at = scope,
) => {
  const { entry } = await createEntry(ctx, at, {
    contentTypeApiId: type,
    fields: { title: { 'en-US': slug }, slug: { 'en-US': slug }, ...extra },
  });
  await publishEntry(ctx, at, entry.id);
  return entry.id;
};

beforeEach(async () => {
  store = new InMemoryContentStore();
  clock = new FixedClock();
  ctx = { store, clock, ids: new SequenceIdGenerator('t') };
  await createSpace(ctx, {
    spaceId: 'site',
    name: 'Site',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  sent = [];
  const inner = store.delivery.read;
  (store as { delivery: typeof store.delivery }).delivery = {
    read: async (s, request) => {
      sent.push(request);
      return inner(s, request);
    },
  };
});

describe('setEntrySeo', () => {
  it('saves the metadata as a new draft version, published with the entry', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const id = await page('article', 'hello');
    const saved = await setEntrySeo(ctx, scope, id, {
      title: 'Hello | Blog',
      ogImage: { id: 'img', linkType: 'Asset' },
    });
    expect(saved.entry.status).toBe('changed');
    expect(saved.fields.seo).toEqual({
      'en-US': { title: 'Hello | Blog', ogImage: { id: 'img', linkType: 'Asset' } },
    });
    expect(saved.fields.slug).toEqual({ 'en-US': 'hello' });
    // The social image is a reference like any link: a missing asset can't go live.
    await expect(publishEntry(ctx, scope, id)).rejects.toThrow();
    await setEntrySeo(ctx, scope, id, { ogImage: null });
    await publishEntry(ctx, scope, id);
    expect((await getPublishedEntry(ctx, scope, id, { locale: 'en-US' })).fields.seo).toEqual({
      title: 'Hello | Blog',
    });
  });

  it('keeps the parts left out, clears the ones set to null, and drops an emptied value', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const id = await page('article', 'hello');
    await setEntrySeo(ctx, scope, id, { title: 'T', description: 'D' });
    expect(
      (await setEntrySeo(ctx, scope, id, { description: null, noindex: true })).fields.seo,
    ).toEqual({ 'en-US': { title: 'T', noindex: true } });
    const cleared = await setEntrySeo(ctx, scope, id, { title: null, noindex: null });
    expect(cleared.fields).not.toHaveProperty('seo');
  });

  it('writes one locale of a localized Seo field and refuses another on an unlocalized one', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}', seo: { localized: true } });
    const id = await page('article', 'hello', { seo: { 'en-US': { title: 'Hello' } } });
    expect(
      (await setEntrySeo(ctx, scope, id, { title: 'Hallo' }, { locale: 'de' })).fields.seo,
    ).toEqual({ 'en-US': { title: 'Hello' }, de: { title: 'Hallo' } });
    await expect(
      setEntrySeo(ctx, scope, id, { title: 'Bonjour' }, { locale: 'fr' }),
    ).rejects.toBeInstanceOf(ValidationError);

    await defineType('page', { urlPattern: '/{slug}' });
    const other = await page('page', 'about');
    await expect(
      setEntrySeo(ctx, scope, other, { title: 'Über' }, { locale: 'de' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('validates what it writes like any edit', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const id = await page('article', 'hello');
    await expect(
      setEntrySeo(ctx, scope, id, { canonicalUrl: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: 'seo.canonicalUrl' })] });
  });

  it('is refused for a content type without a Seo field', async () => {
    await defineType('author', { urlPattern: '/people/{slug}', seo: false });
    const id = await page('author', 'ada');
    await expect(setEntrySeo(ctx, scope, id, { title: 'Ada' })).rejects.toMatchObject({
      issues: [{ field: 'seo', message: expect.stringMatching(/no Seo field/) }],
    });
  });
});

describe('listDeliveredSitemap', () => {
  it('lists published entries of routable types with their path and lastmod', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await defineType('author', { seo: false });
    const id = await page('article', 'hello');
    await page('author', 'ada');
    const { entry: draft } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { slug: { 'en-US': 'draft' } },
    });
    expect(await listDeliveredSitemap(ctx, scope)).toEqual({
      items: [
        {
          entryId: id,
          contentType: 'article',
          lastmod: '2026-01-01T00:00:00.000Z',
          urls: [{ path: '/blog/hello', locale: 'en-US' }],
        },
      ],
      next: null,
    });
    expect((await listDeliveredSitemap(ctx, scope)).items.map((e) => e.entryId)).not.toContain(
      draft.id,
    );
  });

  it('leaves out noindex entries and follows publishes and unpublishes', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const hidden = await page('article', 'secret', { seo: { 'en-US': { noindex: true } } });
    const shown = await page('article', 'hello');
    expect((await listDeliveredSitemap(ctx, scope)).items.map((e) => e.entryId)).toEqual([shown]);

    // A draft noindex isn't live until published.
    await setEntrySeo(ctx, scope, shown, { noindex: true });
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(1);
    clock.advance(60_000);
    await publishEntry(ctx, scope, shown);
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([]);

    await setEntrySeo(ctx, scope, hidden, { noindex: null });
    await publishEntry(ctx, scope, hidden);
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([
      expect.objectContaining({ entryId: hidden, lastmod: '2026-01-01T00:01:00.000Z' }),
    ]);
    await unpublishEntry(ctx, scope, hidden);
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([]);
  });

  it('serves a type once its URL pattern is published', async () => {
    await defineType('article');
    await page('article', 'hello');
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([]);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'article', { urlPattern: '/blog/{slug}' });
    expect((await listDeliveredSitemap(ctx, scope)).items).toEqual([]);
    await publishContentType(ctx, scope, 'article');
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(1);
  });

  it('pages by entry id, each page’s next naming the first entry of the following one', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await page('article', `post-${i}`));
    ids.sort();
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const res = await listDeliveredSitemap(ctx, scope, { ...(from ? { from } : {}), limit: 3 });
      seen.push(...res.items.map((e) => e.entryId));
      from = res.next ?? undefined;
      pages++;
    } while (from);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
  });

  it('lists a type for a reader that may read it, and never one whose path reveals a hidden field', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await defineType('page', { urlPattern: '/{slug}' });
    await page('article', 'hello');
    await page('page', 'about');
    const reader = (grants: Principal['contentGrants']): Principal => ({
      spaceId: 'site',
      kind: 'cda',
      scopes: ['delivery:read'],
      contentGrants: grants,
    });
    const types = async (principal: Principal) =>
      (await listDeliveredSitemap(ctx, scope, {}, { principal })).items.map((e) => e.contentType);
    expect(await types(reader([{ contentTypeApiId: 'page', actions: ['read'] }]))).toEqual([
      'page',
    ]);
    expect(
      await types(
        reader([
          { contentTypeApiId: 'page', actions: ['read'], deniedFields: ['slug'] },
          { contentTypeApiId: 'article', actions: ['read'], deniedFields: ['seo'] },
        ]),
      ),
    ).toEqual(['article']);
  });

  it('lists a type whose Seo field the reader may not read as if it had none', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const hidden = await page('article', 'hidden', { seo: { 'en-US': { noindex: true } } });
    const shown = await page('article', 'shown');
    const reader: Principal = {
      spaceId: 'site',
      kind: 'cda',
      scopes: ['delivery:read'],
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read'], deniedFields: ['seo'] }],
    };
    // Which entries noindex drops would tell the reader what the field holds: none are dropped.
    const listed = await listDeliveredSitemap(ctx, scope, {}, { principal: reader });
    expect(listed.items.map((e) => e.entryId).sort()).toEqual([hidden, shown].sort());
    expect(sent.at(-1)?.sitemap?.fields).toEqual(['slug']);
    // A reader that may read it gets the exclusions.
    expect((await listDeliveredSitemap(ctx, scope)).items.map((e) => e.entryId)).toEqual([shown]);
  });

  it('answers each environment with its own entries', async () => {
    await createEnvironment(ctx, 'site', 'staging');
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await defineType('article', { urlPattern: '/blog/{slug}', at: staging });
    await page('article', 'hello');
    await page('article', 'staged', {}, staging);
    const paths = async (at: typeof scope) =>
      (await listDeliveredSitemap(ctx, at)).items.flatMap((e) => e.urls.map((u) => u.path));
    expect(await paths(scope)).toEqual(['/blog/hello']);
    expect(await paths(staging)).toContain('/blog/staged');
    expect(await paths(staging)).not.toContain('/blog/hello');
  });

  it('reads in two round trips, the second only for the routable types and their fields', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await defineType('author', { seo: false });
    await page('article', 'hello');
    const reads = deliveryReads(ctx);
    await listDeliveredSitemap(ctx, scope, { limit: 10 }, { reads });
    expect(sent).toEqual([
      { config: true, contentTypes: true },
      { sitemap: { contentTypes: ['article'], fields: ['slug', 'seo'], limit: 11 } },
    ]);
  });

  it('costs one round trip when no type has a URL pattern', async () => {
    await defineType('author', { seo: false });
    expect(await listDeliveredSitemap(ctx, scope)).toEqual({ items: [], next: null });
    expect(sent).toHaveLength(1);
  });
});

describe('deliveredSitemapFile', () => {
  it('is one urlset while every entry fits one file', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await page('article', 'hello');
    const file = await deliveredSitemapFile(ctx, scope, undefined);
    expect(file).toMatchObject({ kind: 'urlset', items: [{ urls: [{ path: '/blog/hello' }] }] });
  });

  it('is an index of pages past one file, each page a range of entry ids', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await page('article', `post-${i}`));
    ids.sort();
    const file = await deliveredSitemapFile(ctx, scope, undefined, { pageSize: 2 });
    expect(file).toEqual({
      kind: 'index',
      pages: [`,${ids[2]}`, `${ids[2]},${ids[4]}`, `${ids[4]},`],
    });
    const entriesOf = async (token: string) => {
      const f = await deliveredSitemapFile(ctx, scope, token, { pageSize: 2 });
      return f.kind === 'urlset' ? f.items.map((e) => e.entryId) : [];
    };
    expect(await entriesOf(`${ids[2]},${ids[4]}`)).toEqual([ids[2], ids[3]]);
    expect(await entriesOf(`${ids[4]},`)).toEqual([ids[4]]);
  });

  it('still lists an older draft published after the index was read', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    const draft = async (slug: string) =>
      (
        await createEntry(ctx, scope, {
          contentTypeApiId: 'article',
          fields: { slug: { 'en-US': slug } },
        })
      ).entry.id;
    const first = await draft('first'); // older than every page's start
    const ids = [await page('article', 'a'), await page('article', 'b')];
    const middle = await draft('middle'); // between the first page's entries and the next page's
    ids.push(await page('article', 'c'), await page('article', 'd'), await page('article', 'e'));
    const index = await deliveredSitemapFile(ctx, scope, undefined, { pageSize: 2 });
    if (index.kind !== 'index') throw new Error('expected an index');
    await publishEntry(ctx, scope, first);
    await publishEntry(ctx, scope, middle);
    const listed: string[] = [];
    for (const token of index.pages) {
      const f = await deliveredSitemapFile(ctx, scope, token, { pageSize: 2 });
      if (f.kind === 'urlset') listed.push(...f.items.map((e) => e.entryId));
    }
    expect(listed.sort()).toEqual([...ids, first, middle].sort());
  });

  it('leaves out a page whose canonical copy is on another site, given the site', async () => {
    await defineType('article', { urlPattern: '/blog/{slug}' });
    await page('article', 'syndicated', {
      seo: { 'en-US': { canonicalUrl: 'https://partner.example/blog/syndicated' } },
    });
    await page('article', 'own', {
      seo: { 'en-US': { canonicalUrl: 'https://example.com/blog/own' } },
    });
    const file = await deliveredSitemapFile(ctx, scope, undefined, {
      site: { origin: 'https://example.com' },
    });
    expect(file.kind === 'urlset' && file.items.map((e) => e.urls[0]?.path)).toEqual(['/blog/own']);
  });
});

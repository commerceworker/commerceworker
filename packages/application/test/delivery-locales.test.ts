import {
  type FieldDefinition,
  ForbiddenError,
  NotFoundError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  InMemoryEventBus,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addToAssetCollection,
  assetTextKey,
  consumeEvent,
  createAsset,
  createAssetCollection,
  createContentType,
  createEntry,
  createSpace,
  createTag,
  deliveredSearch,
  deliveryGraphResolvers,
  epochTag,
  getDeliveredAsset,
  getDeliveredCollection,
  getLocaleSettings,
  getPreviewAsset,
  getPreviewEntry,
  getPublishedEntry,
  indexAssetForSearch,
  indexEntryEmbeddings,
  listDeliveredAssets,
  listDeliveredSitemap,
  listDeliveredTags,
  listPublishedEntries,
  publishAsset,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  searchDeliveredAssets,
  setAssetMetadata,
  setLocaleSettings,
} from '../src/index';

/**
 * Delivery locales: a locale an editor turns off stays editable and previewable, and Delivery
 * stops serving it (404 when named, skipped by fallbacks, left out of all-locale responses and
 * the sitemap's alternates), in every environment of the space.
 */
const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };
const other = { spaceId: 'other', environmentId: 'main' };
const admin: Principal = { spaceId: 'site', kind: 'cma', scopes: Object.values(SCOPES) };
const editor: Principal = { spaceId: 'site', kind: 'cma', scopes: [SCOPES.contentWrite] };

let store: InMemoryContentStore;
let ctx: AppContext;

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({ name: over.apiId, localized: true, required: false, position: 0, ...over }) as FieldDefinition;

async function seed(at = scope) {
  await createContentType(ctx, SYSTEM_CALLER, at, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    urlPattern: '/{locale}/{slug}',
    fields: [field({ apiId: 'title', type: 'Symbol' }), field({ apiId: 'slug', type: 'Slug' })],
  });
  await publishContentType(ctx, at, 'page');
  const { entry } = await createEntry(ctx, at, {
    contentTypeApiId: 'page',
    fields: {
      title: { en: 'Hello', fr: 'Bonjour', 'fr-CA': 'Allô' },
      slug: { en: 'hello', fr: 'bonjour' },
    },
  });
  await publishEntry(ctx, at, entry.id);
  return entry.id;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('l') };
  for (const spaceId of ['site', 'other']) {
    await createSpace(ctx, {
      spaceId,
      name: spaceId,
      defaultLocale: 'en',
      locales: ['en', 'fr', 'fr-CA', 'ar'],
      fallbacks: { 'fr-CA': 'fr', fr: 'en' },
      environments: ['main', 'staging'],
    });
  }
});

describe('locale settings', () => {
  it('resolves every locale: delivered unless turned off, direction from the language', async () => {
    const view = await getLocaleSettings(ctx, scope);
    expect(view.localeSettings).toEqual({
      en: { delivered: true, direction: 'ltr' },
      fr: { delivered: true, direction: 'ltr' },
      'fr-CA': { delivered: true, direction: 'ltr' },
      ar: { delivered: true, direction: 'rtl' },
    });
  });

  it('changes the named locales only, with one event for the purge, and for space admins', async () => {
    await setLocaleSettings(ctx, admin, scope, { ar: { direction: 'ltr' } });
    const view = await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    expect(view.localeSettings.fr).toEqual({ delivered: false, direction: 'ltr' });
    expect(view.localeSettings.ar).toEqual({ delivered: true, direction: 'ltr' });
    const events = store.allEvents().filter((e) => e.type === 'space_locales.changed');
    expect(events.map((e) => ('undelivered' in e ? e.undelivered : null))).toEqual([[], ['fr']]);

    await expect(setLocaleSettings(ctx, editor, scope, { fr: {} })).rejects.toThrow(ForbiddenError);
    await expect(
      setLocaleSettings(ctx, admin, scope, { en: { delivered: false } }),
    ).rejects.toThrow(ValidationError);
    // Another space is untouched.
    expect((await getLocaleSettings(ctx, other)).localeSettings.fr?.delivered).toBe(true);
  });
});

describe('two locale settings changes at once', () => {
  it('lands both: the one that loses the race re-reads and applies on top', async () => {
    const read = store.spaces.getConfig.bind(store.spaces);
    let raced = false;
    // Between the first change's read and its write, another admin's change commits.
    store.spaces.getConfig = async (at) => {
      const config = await read(at);
      if (!raced) {
        raced = true;
        await setLocaleSettings(ctx, admin, scope, { ar: { direction: 'ltr' } });
      }
      return config;
    };
    const view = await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    expect(view.localeSettings.fr?.delivered).toBe(false);
    expect(view.localeSettings.ar?.direction).toBe('ltr');
    expect((await read(scope))?.localeSettings).toEqual({
      fr: { delivered: false },
      ar: { direction: 'ltr' },
    });
    // One event per change that committed, none for the attempt that lost.
    const events = store.allEvents().filter((e) => e.type === 'space_locales.changed');
    expect(events).toHaveLength(2);
  });

  it('gives up with the conflict when every attempt loses', async () => {
    const read = store.spaces.getConfig.bind(store.spaces);
    let n = 0;
    // Someone else changes the settings after every read, each time to something new.
    store.spaces.getConfig = async (at) => {
      const config = await read(at);
      await store.spaces.setLocaleSettings(
        at.spaceId,
        { ar: { direction: n++ % 2 === 0 ? 'ltr' : 'rtl' } },
        config?.localeSettings,
      );
      return config;
    };
    await expect(
      setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } }),
    ).rejects.toThrow(TransactionConflictError);
  });
});

describe('a locale settings change', () => {
  it('evicts what every environment of the space cached, once, even when delivered again', async () => {
    const cache = new InMemoryCache();
    for (const environmentId of ['main', 'staging']) {
      await cache.set(`render:${environmentId}`, 'cached', {
        tags: [epochTag({ spaceId: 'site', environmentId })],
      });
    }
    await cache.set('render:other', 'cached', { tags: [epochTag(other)] });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const event = store.allEvents().find((e) => e.type === 'space_locales.changed');
    const deps = { sender: new RecordingWebhookSender(), cache };
    await consumeEvent(ctx, deps, event as never);
    expect(await cache.get('render:main')).toBeNull();
    expect(await cache.get('render:staging')).toBeNull();
    expect(await cache.get('render:other')).toBe('cached');
    // Redelivered: nothing more to evict, and nothing fails.
    await consumeEvent(ctx, deps, event as never);
  });
});

describe('Delivery with a locale turned off', () => {
  it('refuses the locale by name, skips it in fallbacks and leaves it out of every map', async () => {
    const id = await seed();
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });

    await expect(getPublishedEntry(ctx, scope, id, { locale: 'fr' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      listPublishedEntries(ctx, scope, { contentTypeApiId: 'page' }, { locale: 'fr' }),
    ).rejects.toThrow(NotFoundError);
    // fr-CA falls back past fr to en: the fr values are never reached.
    const canadian = await getPublishedEntry(ctx, scope, id, { locale: 'fr-CA' });
    expect(canadian.fields).toEqual({ title: 'Allô', slug: 'hello' });
    // All locales: fr is not among them.
    const all = await getPublishedEntry(ctx, scope, id);
    expect(all.fields.title).toEqual({ en: 'Hello', 'fr-CA': 'Allô' });
    // A locale the space doesn't have resolves as it always has.
    expect((await getPublishedEntry(ctx, scope, id, { locale: 'de' })).fields.title).toBe('Hello');

    // Editors still write and preview it.
    expect((await getPreviewEntry(ctx, scope, id, { locale: 'fr' })).fields.title).toBe('Bonjour');
  });

  it('applies in every environment of the space, and to the sitemap’s alternates', async () => {
    await seed();
    const elsewhere = await seed(staging);
    const before = await listDeliveredSitemap(ctx, staging);
    expect(before.items[0]?.urls).toContainEqual({ path: '/fr/bonjour', locale: 'fr' });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const after = await listDeliveredSitemap(ctx, staging);
    expect(after.items.map((e) => e.entryId)).toEqual([elsewhere]);
    // fr-CA's slug no longer falls back to fr's: its path is en's slug under its own locale.
    expect(after.items[0]?.urls).toEqual([
      { path: '/en/hello', locale: 'en' },
      { path: '/fr-CA/hello', locale: 'fr-CA' },
      { path: '/ar/hello', locale: 'ar' },
    ]);
  });

  it('leaves the locale out of taxonomy labels and refuses it by name there too', async () => {
    await createTag(ctx, scope, { name: 'News', labels: { fr: 'Actualités', ar: 'أخبار' } });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const [tag] = await listDeliveredTags(ctx, scope);
    expect(tag?.labels).toEqual({ en: 'News', ar: 'أخبار' });
    await expect(listDeliveredTags(ctx, scope, { locale: 'fr' })).rejects.toThrow(NotFoundError);
  });
});

describe('every Delivery output with a locale turned off', () => {
  /** A published image titled and described in en, fr and ar. */
  async function frenchAsset() {
    const blob = new FakeBlobStore();
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'hero.jpg',
      contentType: 'image/jpeg',
      title: { en: 'Hero', fr: 'Héros', ar: 'بطل' },
    });
    await store.assets.save(scope, { ...asset, file: { ...asset.file, size: 10, width: 10 } });
    await setAssetMetadata(ctx, scope, asset.id, { altText: { en: 'A hero', fr: 'Un héros' } });
    await publishAsset(ctx, scope, asset.id);
    return { id: asset.id, blob };
  }

  it('leaves the locale out of asset text: one, a page, a collection and an include', async () => {
    const { id, blob } = await frenchAsset();
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'card',
      name: 'Card',
      displayField: 'heading',
      fields: [
        field({ apiId: 'heading', type: 'Symbol' }),
        field({ apiId: 'image', type: 'Link', linkType: 'Asset', localized: false }),
      ],
    });
    await publishContentType(ctx, scope, 'card');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'card',
      fields: { heading: { en: 'Card' }, image: { en: { id, linkType: 'Asset' } } },
    });
    await publishEntry(ctx, scope, entry.id);
    const collection = await createAssetCollection(ctx, scope, { name: 'Heroes' });
    await addToAssetCollection(ctx, scope, collection.id, [id]);
    // Delivered before: fr is there.
    expect((await getDeliveredAsset(ctx, scope, id)).title).toHaveProperty('fr');

    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const one = await getDeliveredAsset(ctx, scope, id);
    expect(one.title).toEqual({ en: 'Hero', ar: 'بطل' });
    expect(one.altText).toEqual({ en: 'A hero' });
    const [listed] = (await listDeliveredAssets(ctx, scope)).items;
    expect(listed?.title).toEqual({ en: 'Hero', ar: 'بطل' });
    const [member] = (await getDeliveredCollection(ctx, scope, collection.id)).items;
    expect(member?.title).toEqual({ en: 'Hero', ar: 'بطل' });
    const card = await getPublishedEntry(ctx, scope, entry.id, { include: 1 });
    const embedded = (card.fields.image as Record<string, unknown>).en as { title: unknown };
    expect(embedded.title).toEqual({ en: 'Hero', ar: 'بطل' });
    // Named, it is refused; Preview still shows editors every locale.
    await expect(getDeliveredAsset(ctx, scope, id, { locale: 'fr' })).rejects.toThrow(
      NotFoundError,
    );
    expect((await getPreviewAsset(ctx, blob, scope, id)).title).toHaveProperty('fr', 'Héros');
  });

  it('finds no asset by the locale’s text: the scan, the lexical index or the vectors', async () => {
    const { id, blob } = await frenchAsset();
    // Text read out of the file belongs to no locale: a hit on it stands.
    await blob.put(assetTextKey(scope, id, 1) as string, 'fromage', 'text/plain');
    const indexed = {
      embeddings: new LocalEmbeddingsProvider(4096),
      vectors: new InMemoryVectorStore(),
      publishedIndex: new InMemorySearchIndex(),
    };
    await indexAssetForSearch(ctx, indexed, blob, scope, id);
    const found = async (q: string, deps = {}) =>
      (await searchDeliveredAssets(ctx, deps, scope, { q })).items.map((a) => a.id);
    expect(await found('héros')).toEqual([id]);
    expect(await found('héros', indexed)).toEqual([id]);

    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    // French title and alt text: the scan, the index and the vector leg all leave it out.
    expect(await found('héros')).toEqual([]);
    expect(await found('héros', indexed)).toEqual([]);
    expect(await found('un héros', indexed)).toEqual([]);
    expect(
      await found('héros', { embeddings: indexed.embeddings, vectors: indexed.vectors }),
    ).toEqual([]);
    // What it delivers still finds it, and so does its file's own text.
    expect(await found('hero')).toEqual([id]);
    expect(await found('hero', indexed)).toEqual([id]);
    expect(await found('بطل', indexed)).toEqual([id]);
    expect(await found('fromage', indexed)).toEqual([id]);
    // Flattened to a delivered locale, the same rule holds.
    const en = (q: string) => searchDeliveredAssets(ctx, indexed, scope, { q }, { locale: 'en' });
    expect((await en('hero')).items.map((a) => a.id)).toEqual([id]);
    expect((await en('héros')).items).toEqual([]);
  });

  it('gives GraphQL nothing for the locale: no asset text, no fallback under its name', async () => {
    const { id } = await frenchAsset();
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const reader: Principal = { spaceId: 'site', kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const resolvers = deliveryGraphResolvers(ctx, scope, reader, { rag: undefined });
    const found = await resolvers.asset(id);
    expect(found?.asset.title).toEqual({ en: 'Hero', ar: 'بطل' });
    // The raw map, as a field resolver would hand it over: fr is never read, nor fallen back from.
    const title = { en: 'Hero', fr: 'Héros' };
    expect(await resolvers.localize(title, 'fr')).toBeNull();
    expect(await resolvers.localize(title, 'en')).toBe('Hero');
    expect(await resolvers.localize(title)).toBe('Hero');
  });

  it('strips the locale from an entry.published fact before a live subscriber sees it', async () => {
    await seed();
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const event = store.allEvents().find((e) => e.type === 'entry.published');
    const bus = new InMemoryEventBus();
    const seen: unknown[] = [];
    bus.subscribe('entry.published', async (e) => {
      seen.push('fields' in e ? e.fields : null);
    });
    const deps = { sender: new RecordingWebhookSender(), bus };
    await consumeEvent(ctx, deps, event as never);
    expect(seen).toEqual([{ title: { en: 'Hello', 'fr-CA': 'Allô' }, slug: { en: 'hello' } }]);
    // The stored fact itself is untouched: webhooks and the outbox keep what was published.
    expect(event && 'fields' in event ? event.fields.title : null).toHaveProperty('fr');
  });

  it('neither matches nor quotes the locale in search: lexical, semantic and GraphQL', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'body',
      fields: [field({ apiId: 'body', type: 'Text' })],
    });
    await publishContentType(ctx, scope, 'note');
    const rag = { embeddings: new LocalEmbeddingsProvider(16), vectors: new InMemoryVectorStore() };
    const note = async (body: Record<string, string>) => {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { body },
      });
      await publishEntry(ctx, scope, entry.id);
      await indexEntryEmbeddings(rag, scope, {
        entryId: entry.id,
        fields: { body },
        entryVersion: 1,
      });
      return entry.id;
    };
    const onlyFrench = await note({ en: 'Weather report', fr: 'fromage fromage fromage' });
    const both = await note({ en: 'fromage on toast', fr: 'fromage fromage fromage fromage' });
    const before = await deliveredSearch(undefined, ctx, scope, 'fromage', { mode: 'lexical' });
    expect(before.map((h) => h.entryId).sort()).toEqual([onlyFrench, both].sort());

    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const lexical = await deliveredSearch(undefined, ctx, scope, 'fromage', { mode: 'lexical' });
    expect(lexical.map((h) => h.entryId)).toEqual([both]);
    expect(lexical[0]?.snippet).toBe('fromage on toast');
    // The vector leg: a French chunk is no hit, an English one still is.
    const semantic = await deliveredSearch(rag, ctx, scope, 'fromage fromage fromage', {
      mode: 'semantic',
      topK: 10,
    });
    expect(semantic.map((h) => h.snippet)).not.toContain('fromage fromage fromage');
    expect(semantic.every((h) => !h.snippet.startsWith('fromage fromage'))).toBe(true);
    const hybrid = await deliveredSearch(rag, ctx, scope, 'fromage');
    expect(hybrid.every((h) => !h.snippet.includes('fromage fromage'))).toBe(true);
    expect(hybrid.map((h) => h.entryId)).toContain(both);
    const reader: Principal = { spaceId: 'site', kind: 'cda', scopes: Object.values(SCOPES) };
    const graph = deliveryGraphResolvers(ctx, scope, reader, { rag: undefined });
    expect((await graph.search('fromage')).map((h) => h.entryId)).toEqual([both]);
  });

  it('never filters (in `filters` or `where`), orders or matches `query=` on the locale’s values', async () => {
    const hello = await seed();
    const zed = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: { title: { en: 'Zed' }, slug: { en: 'zed' } },
      })
    ).entry.id;
    await publishEntry(ctx, scope, zed);
    // Only French has a title: the any-locale fallback used to compare it.
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { fr: 'Seulement' }, slug: { en: 'only' } },
    });
    await publishEntry(ctx, scope, entry.id);
    const filtered = (where: Record<string, unknown>) =>
      listPublishedEntries(ctx, scope, { contentTypeApiId: 'page', ...where });
    const byTitle = { filters: [{ field: 'title', op: 'eq' as const, value: 'Seulement' }] };
    expect((await filtered(byTitle)).map((e) => e.id)).toEqual([entry.id]);
    // The same predicate inside a `where` group, beside one that matches nothing.
    const inWhere = {
      where: {
        or: [
          { field: 'title', op: 'eq' as const, value: 'Nowhere' },
          { and: [{ field: 'title', op: 'startsWith' as const, value: 'Seul' }] },
        ],
      },
    };
    expect((await filtered(inWhere)).map((e) => e.id)).toEqual([entry.id]);
    const ascending = { order: [{ field: 'title', direction: 'asc' as const }] };
    expect((await filtered(ascending)).map((e) => e.id)).toEqual([hello, entry.id, zed]);

    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    expect(await filtered(byTitle)).toEqual([]);
    expect(await filtered(inWhere)).toEqual([]);
    expect(await filtered({ search: 'seulement' })).toEqual([]);
    const exists = { filters: [{ field: 'title', op: 'exists' as const, value: false }] };
    expect((await filtered(exists)).map((e) => e.id)).toEqual([entry.id]);
    // Ordered by title, the French-only entry has none: it sorts last, not as "Seulement".
    expect((await filtered(ascending)).map((e) => e.id)).toEqual([hello, zed, entry.id]);
  });
});

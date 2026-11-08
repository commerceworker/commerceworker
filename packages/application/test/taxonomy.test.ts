import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createConcept,
  createContentType,
  createEntry,
  createScheme,
  createTag,
  deleteTag,
  entryQueryFrom,
  getDeliveredConcept,
  getDeliveredTag,
  listConceptsWithUsage,
  listDeliveredConcepts,
  listDeliveredTags,
  listPublishedEntries,
  listTagsWithUsage,
  publishContentType,
  publishEntry,
  repairTaxonomy,
  SYSTEM_CALLER,
  setConceptBroader,
  setEntryMetadata,
  trashEntry,
  unpublishEntry,
  updateConcept,
  updateTag,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

const other = { spaceId: 'space-1', environmentId: 'staging' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: 'space-1',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de', 'de-AT'],
    fallbacks: { 'de-AT': 'de', de: null },
  });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

const pending = async (ctx: AppContext) => ctx.store.outbox.readPending(1000);

async function seedArticle(ctx: AppContext, title: string) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  }).catch(() => {}); // idempotent across calls
  await publishContentType(ctx, scope, 'article').catch(() => {});
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
}

describe('taxonomy vocabulary', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('builds a hierarchy and rejects cycles', async () => {
    const scheme = await createScheme(ctx, scope, { name: 'Topics' });
    const animals = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Animals' });
    const cats = await createConcept(ctx, scope, {
      schemeId: scheme.id,
      prefLabel: 'Cats',
      broaderId: animals.id,
    });
    expect(cats.broaderId).toBe(animals.id);

    // Making the parent point under its own child would cycle.
    await expect(setConceptBroader(ctx, scope, animals.id, cats.id)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('rejects associating an entry with an unknown tag', async () => {
    const entry = await seedArticle(ctx, 'A');
    await expect(
      setEntryMetadata(ctx, scope, entry.entry.id, { tags: ['ghost'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('entry taxonomy associations', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('captures metadata in the published snapshot and filters by tag', async () => {
    const tagNews = await createTag(ctx, scope, { name: 'news' });
    const tagOpinion = await createTag(ctx, scope, { name: 'opinion' });

    const a = await seedArticle(ctx, 'A');
    const b = await seedArticle(ctx, 'B');
    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [tagNews.id] });
    await setEntryMetadata(ctx, scope, b.entry.id, { tags: [tagOpinion.id] });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    // Delivered entries carry their metadata.
    const all = await listPublishedEntries(ctx, scope, {});
    const delivered = all.find((e) => e.id === a.entry.id);
    expect(delivered?.metadata?.tags).toEqual([tagNews.id]);

    // Filterable: metadata.tags membership.
    const newsOnly = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'metadata.tags', op: 'in', value: [tagNews.id] }],
    });
    expect(newsOnly.map((e) => e.id)).toEqual([a.entry.id]);
  });
});

describe('term slugs, descriptions and localized labels', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('makes slugs from labels, numbers collisions, and refuses a taken slug asked for', async () => {
    const a = await createTag(ctx, scope, { name: 'Breaking News' });
    const b = await createTag(ctx, scope, { name: 'Breaking news' });
    expect([a.slug, b.slug]).toEqual(['breaking-news', 'breaking-news-2']);
    await expect(
      createTag(ctx, scope, { name: 'Other', slug: 'breaking-news' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(createTag(ctx, scope, { name: 'Bad', slug: '!!!' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // Another environment is another namespace.
    expect((await createTag(ctx, other, { name: 'Breaking News' })).slug).toBe('breaking-news');
  });

  it('chooses again when a concurrent write takes the generated slug first', async () => {
    const real = ctx.store.taxonomy.createTag.bind(ctx.store.taxonomy);
    let lost = 0;
    ctx.store.withTransaction = (async (fn) =>
      fn({
        ...(ctx.store as unknown as Record<string, unknown>),
        taxonomy: {
          ...ctx.store.taxonomy,
          createTag: async (s: typeof scope, tag: Parameters<typeof real>[1]) => {
            // The first write loses its slug to someone else's commit.
            if (lost++ === 0) {
              await real(s, { ...tag, id: 'winner' });
              throw new ConflictError('A unique value is already taken');
            }
            await real(s, tag);
          },
        },
      } as never)) as typeof ctx.store.withTransaction;
    const tag = await createTag(ctx, scope, { name: 'Race' });
    expect(tag.slug).toBe('race-2');
  });

  it('keeps the slug when the label changes, and validates localized labels', async () => {
    const tag = await createTag(ctx, scope, {
      name: 'Travel',
      description: '  Trips  ',
      labels: { de: 'Reisen' },
    });
    expect(tag).toMatchObject({ slug: 'travel', description: 'Trips', labels: { de: 'Reisen' } });

    const renamed = await updateTag(ctx, scope, tag.id, { name: 'Journeys' });
    expect(renamed).toMatchObject({ name: 'Journeys', slug: 'travel', labels: { de: 'Reisen' } });

    // The default locale's label is the term's own; an empty label drops that locale.
    const relabeled = await updateTag(ctx, scope, tag.id, {
      labels: { 'en-US': 'Travel', de: '' },
      description: null,
    });
    expect(relabeled).toMatchObject({ name: 'Travel', labels: {}, description: null });

    await expect(
      updateTag(ctx, scope, tag.id, { labels: { fr: 'Voyage' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateTag(ctx, scope, 'ghost', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('scopes concept slugs to their scheme and updates concepts the same way', async () => {
    const topics = await createScheme(ctx, scope, { name: 'Topics' });
    const places = await createScheme(ctx, scope, { name: 'Places' });
    const a = await createConcept(ctx, scope, { schemeId: topics.id, prefLabel: 'Paris' });
    const b = await createConcept(ctx, scope, { schemeId: places.id, prefLabel: 'Paris' });
    expect([a.slug, b.slug]).toEqual(['paris', 'paris']);
    await expect(updateConcept(ctx, scope, b.id, { slug: 'paris' })).resolves.toMatchObject({
      slug: 'paris',
    });
    const c = await createConcept(ctx, scope, { schemeId: places.id, prefLabel: 'Lyon' });
    await expect(updateConcept(ctx, scope, c.id, { slug: 'paris' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('announces every vocabulary change, so Delivery’s cached taxonomy is purged', async () => {
    const tag = await createTag(ctx, scope, { name: 'Announced' });
    await updateTag(ctx, scope, tag.id, { description: 'Now described' });
    await deleteTag(ctx, scope, tag.id);
    const events = (await pending(ctx)).filter((e) => e.type === 'taxonomy.changed');
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ scope, termKind: 'tag', termId: tag.id });
  });
});

describe('published usage and Delivery', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('counts only published entries, following retag, unpublish and trash', async () => {
    const news = await createTag(ctx, scope, { name: 'News' });
    const a = await seedArticle(ctx, 'A');
    const b = await seedArticle(ctx, 'B');
    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [news.id] });
    await setEntryMetadata(ctx, scope, b.entry.id, { tags: [news.id] });
    const usage = async () =>
      (await listTagsWithUsage(ctx, scope)).find((t) => t.id === news.id)?.usage;
    expect(await usage()).toEqual({ count: 0, byContentType: {} });

    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);
    expect(await usage()).toEqual({ count: 2, byContentType: { article: 2 } });

    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [] });
    await publishEntry(ctx, scope, a.entry.id);
    expect((await usage())?.count).toBe(1);

    await unpublishEntry(ctx, scope, b.entry.id);
    expect((await usage())?.count).toBe(0);
    await publishEntry(ctx, scope, b.entry.id);
    await trashEntry(ctx, scope, b.entry.id);
    expect((await usage())?.count).toBe(0);
    expect(await repairTaxonomy(ctx, scope)).toEqual({ slugsAssigned: 0 });
  });

  it('serves tags by slug with resolved labels, counts limited to readable types', async () => {
    const tag = await createTag(ctx, scope, {
      name: 'Travel',
      labels: { de: 'Reisen' },
      description: 'Trips',
    });
    const a = await seedArticle(ctx, 'A');
    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [tag.id] });
    await publishEntry(ctx, scope, a.entry.id);

    const [listed] = await listDeliveredTags(ctx, scope);
    expect(listed).toEqual({
      id: tag.id,
      slug: 'travel',
      label: 'Travel',
      labels: { 'en-US': 'Travel', de: 'Reisen' },
      description: 'Trips',
      count: 1,
      countsByContentType: { article: 1 },
    });
    // de-AT has no label of its own: it falls back to de.
    const de = await getDeliveredTag(ctx, scope, 'travel', { locale: 'de-AT' });
    expect(de.label).toBe('Reisen');
    expect(de.labels).toBeUndefined();
    // A key that can't read articles doesn't learn how many carry the tag.
    expect(
      (await getDeliveredTag(ctx, scope, 'travel', { readable: (t) => t !== 'article' })).count,
    ).toBe(0);
    expect((await getDeliveredTag(ctx, scope, 'travel', { contentType: 'page' })).count).toBe(0);
    await expect(getDeliveredTag(ctx, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    // Another environment has no such tag.
    await expect(getDeliveredTag(ctx, other, 'travel')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('serves concepts by slug, asking for the scheme when two share it', async () => {
    const topics = await createScheme(ctx, scope, { name: 'Topics' });
    const places = await createScheme(ctx, scope, { name: 'Places' });
    const a = await createConcept(ctx, scope, { schemeId: topics.id, prefLabel: 'Paris' });
    await createConcept(ctx, scope, { schemeId: places.id, prefLabel: 'Paris' });
    await expect(getDeliveredConcept(ctx, scope, 'paris')).rejects.toBeInstanceOf(ConflictError);
    expect(await getDeliveredConcept(ctx, scope, 'paris', { schemeId: topics.id })).toMatchObject({
      id: a.id,
      schemeId: topics.id,
      broaderId: null,
      count: 0,
    });
    expect(await listDeliveredConcepts(ctx, scope, { schemeId: topics.id })).toHaveLength(1);
    expect((await listConceptsWithUsage(ctx, scope)).map((c) => c.usage.count)).toEqual([0, 0]);
  });

  it('filters entries by tag or concept slug, from the query string too', async () => {
    const news = await createTag(ctx, scope, { name: 'News' });
    const scheme = await createScheme(ctx, scope, { name: 'Topics' });
    const cats = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Cats' });
    const a = await seedArticle(ctx, 'A');
    const b = await seedArticle(ctx, 'B');
    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [news.id] });
    await setEntryMetadata(ctx, scope, b.entry.id, { concepts: [cats.id] });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    const query = (qs: string) => entryQueryFrom(new URLSearchParams(qs).entries());
    const ids = async (qs: string) =>
      (await listPublishedEntries(ctx, scope, query(qs))).map((e) => e.id).sort();
    expect(await ids('metadata.tags.slug=news')).toEqual([a.entry.id]);
    expect(await ids('metadata.tags.slug[ne]=news')).toEqual([b.entry.id]);
    expect(await ids('metadata.concepts.slug[in]=cats,dogs')).toEqual([b.entry.id]);
    expect(await ids(`metadata.tags=${news.id}`)).toEqual([a.entry.id]);
    expect(await ids('metadata.tags.slug=unknown')).toEqual([]);
    await expect(
      listPublishedEntries(ctx, scope, query('metadata.tags.slug[gt]=a')),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

import { env } from 'cloudflare:workers';
import type { AppContext } from '@commerceworker/application';
import {
  createConcept,
  createContentType,
  createEntry,
  createScheme,
  createSpace,
  createTag,
  deleteTag,
  getDeliveredConcept,
  getDeliveredTag,
  listDeliveredTags,
  listPublishedEntries,
  listTagsWithUsage,
  publishContentType,
  publishEntry,
  repairTaxonomy,
  SYSTEM_CALLER,
  setEntryMetadata,
  trashEntry,
  unpublishEntry,
  updateTag,
} from '@commerceworker/application';
import { ConflictError, type FieldDefinition, type Scope } from '@commerceworker/domain';
import type { Clock, IdGenerator, PublishedEntry } from '@commerceworker/ports';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Taxonomy on D1: slugs (generated, numbered, unique per namespace), localized labels, and the
 * published usage counts the store keeps in the same batch as the published snapshots, checked
 * across publish, republish with other tags, unpublish, trash, a batch past the parameter cap,
 * a lost count repaired, and the migration's backfill.
 */

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const uid = () => crypto.randomUUID();
const ids: IdGenerator = { newId: uid };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `tax-${uid()}`;
const scope: Scope = { spaceId, environmentId: 'main' };
const other: Scope = { spaceId, environmentId: 'staging' };

const title = (): FieldDefinition => ({
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  localized: false,
  required: true,
  position: 0,
});

async function model(s: Scope) {
  for (const apiId of ['article', 'page']) {
    await createContentType(ctx, SYSTEM_CALLER, s, {
      apiId,
      name: apiId,
      displayField: 'title',
      fields: [title()],
    });
    await publishContentType(ctx, s, apiId);
  }
}

async function entry(s: Scope, type: string, text: string): Promise<string> {
  const { entry } = await createEntry(ctx, s, {
    contentTypeApiId: type,
    fields: { title: { 'en-US': text } },
  });
  return entry.id;
}

/** The D1 store's maintained counts, as a plain map: termId → contentType → count. */
async function counts(s: Scope, kind: 'tag' | 'concept' = 'tag') {
  const out: Record<string, Record<string, number>> = {};
  for (const u of await store.taxonomy.listUsage(s, { kind })) {
    out[u.termId] = { ...out[u.termId], [u.contentTypeApiId]: u.count };
  }
  return out;
}

beforeAll(async () => {
  await createSpace(ctx, {
    spaceId,
    name: 'Taxonomy',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de', 'de-AT'],
    fallbacks: { 'de-AT': 'de', de: null },
    environments: ['main', 'staging'],
  });
  await model(scope);
  await model(other);
});

describe('term slugs', () => {
  it('makes a slug from the label and numbers it past taken ones', async () => {
    const a = await createTag(ctx, scope, { name: 'Breaking News' });
    const b = await createTag(ctx, scope, { name: 'breaking news!' });
    const c = await createTag(ctx, scope, { name: 'Breaking  News' });
    expect([a.slug, b.slug, c.slug]).toEqual([
      'breaking-news',
      'breaking-news-2',
      'breaking-news-3',
    ]);
    // A label with nothing slug-worthy falls back to the kind.
    expect((await createTag(ctx, scope, { name: '日本' })).slug).toBe('tag');
  });

  it('refuses a slug asked for that another tag has, and keeps it on rename', async () => {
    const tag = await createTag(ctx, scope, { name: 'Sport', slug: 'Sport ' });
    expect(tag.slug).toBe('sport');
    await expect(createTag(ctx, scope, { name: 'Sports', slug: 'sport' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const renamed = await updateTag(ctx, scope, tag.id, { name: 'Sports' });
    expect(renamed).toMatchObject({ name: 'Sports', slug: 'sport' });
  });

  it('enforces uniqueness in the store, not only in the use-case', async () => {
    const tag = await createTag(ctx, scope, { name: 'Unique' });
    await expect(store.taxonomy.createTag(scope, { ...tag, id: uid() })).rejects.toBeInstanceOf(
      ConflictError,
    );
    // In a unit of work the refusal comes at commit.
    await expect(
      store.withTransaction((tx) => tx.taxonomy.createTag(scope, { ...tag, id: uid() })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('scopes concept slugs to their scheme and tag slugs to their environment', async () => {
    const topics = await createScheme(ctx, scope, { name: 'Topics' });
    const places = await createScheme(ctx, scope, { name: 'Places' });
    const a = await createConcept(ctx, scope, { schemeId: topics.id, prefLabel: 'Paris' });
    const b = await createConcept(ctx, scope, { schemeId: places.id, prefLabel: 'Paris' });
    expect([a.slug, b.slug]).toEqual(['paris', 'paris']);
    await expect(getDeliveredConcept(ctx, scope, 'paris')).rejects.toBeInstanceOf(ConflictError);
    expect((await getDeliveredConcept(ctx, scope, 'paris', { schemeId: places.id })).id).toBe(b.id);

    expect((await createTag(ctx, other, { name: 'Breaking News' })).slug).toBe('breaking-news');
  });

  it('finds terms by more slugs than D1 binds parameters', async () => {
    const s: Scope = { spaceId, environmentId: 'main' };
    const made = [];
    for (let i = 0; i < 110; i++) made.push(await createTag(ctx, s, { name: `Bulk ${i}` }));
    const found = await store.taxonomy.findTagsBySlug(
      s,
      made.map((t) => t.slug),
    );
    expect(found).toHaveLength(110);
  });
});

describe('published usage counts', () => {
  it('follow publish, republish with other tags, unpublish and trash', async () => {
    const news = await createTag(ctx, scope, { name: 'Counted news' });
    const opinion = await createTag(ctx, scope, { name: 'Counted opinion' });
    const [a1, a2, p1] = [
      await entry(scope, 'article', 'A1'),
      await entry(scope, 'article', 'A2'),
      await entry(scope, 'page', 'P1'),
    ];
    // A draft's tags don't count.
    await setEntryMetadata(ctx, scope, a1, { tags: [news.id, news.id] });
    expect((await counts(scope))[news.id]).toBeUndefined();

    await publishEntry(ctx, scope, a1);
    await setEntryMetadata(ctx, scope, a2, { tags: [news.id] });
    await publishEntry(ctx, scope, a2);
    await setEntryMetadata(ctx, scope, p1, { tags: [news.id, opinion.id] });
    await publishEntry(ctx, scope, p1);
    expect((await counts(scope))[news.id]).toEqual({ article: 2, page: 1 });
    expect((await counts(scope))[opinion.id]).toEqual({ page: 1 });

    // Republished with other tags: off the old, onto the new.
    await setEntryMetadata(ctx, scope, a1, { tags: [opinion.id] });
    await publishEntry(ctx, scope, a1);
    expect((await counts(scope))[news.id]).toEqual({ article: 1, page: 1 });
    expect((await counts(scope))[opinion.id]).toEqual({ article: 1, page: 1 });

    // Republished unchanged: no double count.
    await publishEntry(ctx, scope, a1);
    expect((await counts(scope))[opinion.id]).toEqual({ article: 1, page: 1 });

    await unpublishEntry(ctx, scope, a2);
    expect((await counts(scope))[news.id]).toEqual({ page: 1 });

    await trashEntry(ctx, scope, p1);
    expect((await counts(scope))[news.id]).toBeUndefined();
    expect((await counts(scope))[opinion.id]).toEqual({ article: 1 });

    // A recount from the snapshots agrees with what the store kept.
    const kept = await counts(scope);
    await repairTaxonomy(ctx, scope);
    expect(await counts(scope)).toEqual(kept);
  });

  it('counts concepts the same way', async () => {
    const scheme = await createScheme(ctx, scope, { name: 'Counted' });
    const concept = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Counted' });
    const id = await entry(scope, 'article', 'Conceptual');
    await setEntryMetadata(ctx, scope, id, { concepts: [concept.id] });
    await publishEntry(ctx, scope, id);
    expect((await counts(scope, 'concept'))[concept.id]).toEqual({ article: 1 });
    await unpublishEntry(ctx, scope, id);
    expect((await counts(scope, 'concept'))[concept.id]).toBeUndefined();
  });

  it('counts a batch of snapshots past the parameter cap in one write', async () => {
    const tag = await createTag(ctx, scope, { name: 'Batch' });
    const snapshots: PublishedEntry[] = Array.from({ length: 130 }, (_, i) => ({
      entryId: `batch-${i}-${uid()}`,
      contentTypeApiId: i % 2 ? 'article' : 'page',
      version: 1,
      fields: {},
      publishedAt: '2026-01-01T00:00:00.000Z',
      metadata: { tags: [tag.id], concepts: [] },
    }));
    await store.entries.putPublishedMany(scope, snapshots);
    expect((await counts(scope))[tag.id]).toEqual({ article: 65, page: 65 });
    // Written again (a redelivered batch): still counted once.
    await store.entries.putPublishedMany(scope, snapshots);
    expect((await counts(scope))[tag.id]).toEqual({ article: 65, page: 65 });
    await store.entries.removePublishedMany(
      scope,
      snapshots.map((s) => s.entryId),
    );
    expect((await counts(scope))[tag.id]).toBeUndefined();
  });

  it('keeps each environment’s counts to itself', async () => {
    const tag = await createTag(ctx, other, { name: 'Isolated' });
    const id = await entry(other, 'article', 'Elsewhere');
    await setEntryMetadata(ctx, other, id, { tags: [tag.id] });
    await publishEntry(ctx, other, id);
    expect((await counts(other))[tag.id]).toEqual({ article: 1 });
    expect((await counts(scope))[tag.id]).toBeUndefined();
  });

  it('repairs counts and slugs that something wrote without them', async () => {
    const tag = await createTag(ctx, scope, { name: 'Repaired' });
    const id = await entry(scope, 'article', 'Repairable');
    await setEntryMetadata(ctx, scope, id, { tags: [tag.id] });
    await publishEntry(ctx, scope, id);
    // As code older than the counts would leave it: a lost count and a term with no slug.
    await testDb
      .prepare(
        'DELETE FROM taxonomy_usage WHERE space_id = ? AND environment_id = ? AND term_id = ?',
      )
      .bind(spaceId, 'main', tag.id)
      .run();
    const legacy = uid();
    await testDb
      .prepare('INSERT INTO tags (space_id, environment_id, id, name) VALUES (?, ?, ?, ?)')
      .bind(spaceId, 'main', legacy, 'Legacy Tag')
      .run();
    expect((await store.taxonomy.getTag(scope, legacy))?.slug).toBe('');

    expect(await repairTaxonomy(ctx, scope)).toEqual({ slugsAssigned: 1 });
    expect((await counts(scope))[tag.id]).toEqual({ article: 1 });
    expect((await store.taxonomy.getTag(scope, legacy))?.slug).toBe('legacy-tag');
    // A second run changes nothing.
    expect(await repairTaxonomy(ctx, scope)).toEqual({ slugsAssigned: 0 });
  });

  it('drops a deleted tag’s counts with it', async () => {
    const tag = await createTag(ctx, scope, { name: 'Doomed tag' });
    const id = await entry(scope, 'article', 'Doomed');
    await setEntryMetadata(ctx, scope, id, { tags: [tag.id] });
    await publishEntry(ctx, scope, id);
    await deleteTag(ctx, scope, tag.id);
    expect(await store.taxonomy.listUsage(scope, { kind: 'tag', termIds: [tag.id] })).toEqual([]);
  });
});

describe('taxonomy on Delivery', () => {
  it('serves labels in the requested locale with fallbacks, counts and lookups by slug', async () => {
    const tag = await createTag(ctx, scope, {
      name: 'Travel',
      slug: 'travel',
      description: 'Trips and places',
      labels: { de: 'Reisen' },
    });
    const a = await entry(scope, 'article', 'Trip');
    const p = await entry(scope, 'page', 'Guide');
    for (const id of [a, p]) {
      await setEntryMetadata(ctx, scope, id, { tags: [tag.id] });
      await publishEntry(ctx, scope, id);
    }
    const listed = (await listDeliveredTags(ctx, scope)).find((t) => t.slug === 'travel');
    expect(listed).toMatchObject({
      id: tag.id,
      label: 'Travel',
      labels: { 'en-US': 'Travel', de: 'Reisen' },
      description: 'Trips and places',
      count: 2,
      countsByContentType: { article: 1, page: 1 },
    });
    // de-AT falls back to de.
    expect(await getDeliveredTag(ctx, scope, 'travel', { locale: 'de-AT' })).toMatchObject({
      label: 'Reisen',
      count: 2,
    });
    expect(
      await getDeliveredTag(ctx, scope, 'travel', {
        contentType: 'article',
        readable: (t) => t !== 'page',
      }),
    ).toMatchObject({ count: 1, countsByContentType: { article: 1 } });

    // Entries by tag slug, and by id.
    const bySlug = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'metadata.tags.slug', op: 'eq', value: 'travel' }],
    });
    expect(bySlug.map((e) => e.id).sort()).toEqual([a, p].sort());
    const byId = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'article',
      filters: [{ field: 'metadata.tags', op: 'in', value: [tag.id] }],
    });
    expect(byId.map((e) => e.id)).toEqual([a]);
    const unknown = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'metadata.tags.slug', op: 'eq', value: 'no-such-tag' }],
    });
    expect(unknown).toEqual([]);
  });

  it('lists tags with usage for the admin', async () => {
    const tag = await createTag(ctx, scope, { name: 'Admin listed' });
    const listed = (await listTagsWithUsage(ctx, scope)).find((t) => t.id === tag.id);
    expect(listed?.usage).toEqual({ count: 0, byContentType: {} });
  });
});

describe('migration 0018 backfill', () => {
  it('gives existing terms slugs from their labels, unique per namespace, and counts usage', async () => {
    const migration = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS.find((m) => m.name.startsWith('0018_'));
    expect(migration).toBeDefined();
    const s = `mig-${uid()}`;
    // Rows as the code before the migration wrote them. The unique indexes come after the
    // backfill in the migration, so they are dropped here to replay it in order.
    await testDb.batch([
      testDb.prepare('DROP INDEX tags_by_slug'),
      testDb.prepare('DROP INDEX concepts_by_slug'),
      testDb.prepare('DROP TABLE taxonomy_usage'),
      ...[
        ['t1', 'Breaking News!'],
        ['t2', 'breaking   news'],
        ['t3', 'Café Society'],
        ['t4', '日本'],
      ].map(([id, name]) =>
        testDb
          .prepare('INSERT INTO tags (space_id, environment_id, id, name) VALUES (?, ?, ?, ?)')
          .bind(s, 'main', id, name),
      ),
      testDb
        .prepare(
          'INSERT INTO concepts (space_id, environment_id, id, scheme_id, pref_label) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(s, 'main', 'c1', 'sch', 'Paris'),
      testDb
        .prepare(
          'INSERT INTO entry_published (space_id, environment_id, entry_id, content_type_api_id, version, fields, metadata, published_at) VALUES (?, ?, ?, ?, 1, ?, ?, 0)',
        )
        .bind(
          s,
          'main',
          'e1',
          'article',
          '{}',
          JSON.stringify({ tags: ['t1', 't3'], concepts: ['c1'] }),
        ),
    ]);
    const replay = (migration?.queries ?? []).filter(
      (q) => !/^\s*(--[^\n]*\n\s*)*ALTER TABLE/i.test(q),
    );
    for (const q of replay) await testDb.prepare(q).run();

    const tags = await store.taxonomy.listTags({ spaceId: s, environmentId: 'main' });
    const slug = (id: string) => tags.find((t) => t.id === id)?.slug;
    expect(slug('t1')).toBe('breaking-news');
    expect(slug('t2')).toMatch(/^breaking-news-t2$/);
    expect(slug('t3')).toBe('caf-society');
    expect(slug('t4')).toBe('tag');
    expect(
      (await store.taxonomy.listConcepts({ spaceId: s, environmentId: 'main' }))[0]?.slug,
    ).toBe('paris');
    const usage = await store.taxonomy.listUsage(
      { spaceId: s, environmentId: 'main' },
      { kind: 'tag' },
    );
    expect(usage.map((u) => [u.termId, u.count]).sort()).toEqual([
      ['t1', 1],
      ['t3', 1],
    ]);
  });
});

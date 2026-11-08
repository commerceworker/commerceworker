import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  listPreviewEntryPage,
  listPublishedEntries,
  publishContentType,
  publishEntriesTx,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
  withActor,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import migration from '../migrations/0024_entry_authorship.sql?raw';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Entry authorship on D1 (0024_entry_authorship): who created an entry and changed it last, when
 * it was created and first published, as the store writes and reads them. Each test makes its own
 * space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const HOUR = 60 * 60 * 1000;

async function harness() {
  const clock = new FixedClock(new Date('2026-05-01T09:00:00.000Z'));
  const base: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `authors-${uid()}`;
  await createSpace(base, { spaceId, name: 'Authors', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(base, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
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
    ] as FieldDefinition[],
  });
  await publishContentType(base, scope, 'note');
  const as = (actor: string) => withActor(base, actor);
  const note = async (actor: string, title: string) =>
    (
      await createEntry(as(actor), scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': title } },
      })
    ).entry.id;
  return { base, clock, scope, as, note };
}

const row = (scope: { spaceId: string; environmentId: string }, id: string) =>
  testDb
    .prepare(
      'SELECT created_at, created_by, modified_by, first_published_at FROM entries WHERE space_id = ? AND environment_id = ? AND id = ?',
    )
    .bind(scope.spaceId, scope.environmentId, id)
    .first<{
      created_at: number | null;
      created_by: string | null;
      modified_by: string | null;
      first_published_at: number | null;
    }>();

describe('entry authorship on D1', () => {
  it('records the creator once and every later change by whoever made it', async () => {
    const h = await harness();
    const id = await h.note('ada', 'First');
    h.clock.advance(HOUR);
    await updateEntry(h.as('grace'), h.scope, id, { title: { 'en-US': 'Second' } });

    const found = await store.entries.get(h.scope, id);
    expect(found?.entry).toMatchObject({
      createdAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'grace',
      firstPublishedAt: null,
    });
    const versions = await store.entries.listVersions(h.scope, id);
    expect(versions.map((v) => [v.version, v.createdBy])).toEqual([
      [2, 'grace'],
      [1, 'ada'],
    ]);
  });

  it('keeps the first publish through an unpublish and a republish', async () => {
    const h = await harness();
    const id = await h.note('ada', 'Live');
    h.clock.advance(HOUR);
    await publishEntry(h.as('grace'), h.scope, id);
    const first = '2026-05-01T10:00:00.000Z';
    h.clock.advance(HOUR);
    await unpublishEntry(h.as('ada'), h.scope, id);
    h.clock.advance(HOUR);
    await publishEntry(h.as('ada'), h.scope, id);

    expect((await store.entries.get(h.scope, id))?.entry).toMatchObject({
      createdBy: 'ada',
      updatedBy: 'ada',
      firstPublishedAt: first,
    });
    // Copied into the read model, so Delivery sorts by it without reading `entries`.
    const published = await store.entries.getPublished(h.scope, id);
    expect(published?.firstPublishedAt).toBe(first);
    expect(published?.publishedAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('never rewrites creation, and a stale aggregate cannot move the first publish', async () => {
    const h = await harness();
    const id = await h.note('ada', 'Kept');
    await publishEntry(h.as('ada'), h.scope, id);
    const before = await row(h.scope, id);
    const found = await store.entries.get(h.scope, id);
    if (!found) throw new Error('entry missing');
    // An aggregate that claims a different creation and first publish, as a lost race might.
    await store.entries.saveAggregate(h.scope, {
      ...found.entry,
      createdAt: '2030-01-01T00:00:00.000Z',
      createdBy: 'mallory',
      updatedBy: 'grace',
      firstPublishedAt: '2030-01-01T00:00:00.000Z',
    });
    const after = await row(h.scope, id);
    expect(after).toEqual({ ...before, modified_by: 'grace' });
  });

  it('copies the first publish from entries, not from a snapshot that lost the race', async () => {
    const h = await harness();
    const id = await h.note('ada', 'Raced');
    await publishEntry(h.as('ada'), h.scope, id);
    const kept = (await row(h.scope, id))?.first_published_at;
    const live = await store.entries.getPublished(h.scope, id);
    if (!live) throw new Error('not published');
    // A second publisher that read the entry before the first committed carries its own instant;
    // the aggregate's COALESCE keeps the first, and the read model must say the same.
    const stale = { ...live, firstPublishedAt: '2030-01-01T00:00:00.000Z' };
    await store.withTransaction(async (tx) => {
      const found = await store.entries.get(h.scope, id);
      if (!found) throw new Error('entry missing');
      await tx.entries.saveAggregate(h.scope, {
        ...found.entry,
        firstPublishedAt: stale.firstPublishedAt,
      });
      await tx.entries.putPublished(h.scope, stale);
    });
    expect((await row(h.scope, id))?.first_published_at).toBe(kept);
    expect((await store.entries.getPublished(h.scope, id))?.firstPublishedAt).toBe(
      new Date(kept as number).toISOString(),
    );
  });

  it('stamps a batch publish past the parameter cap, one first publish per entry', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(await h.note('ada', `Batch ${i}`));
    h.clock.advance(HOUR);
    // One of them was published before: its first publish stays the earlier one.
    await publishEntry(h.as('ada'), h.scope, ids[0] as string);
    h.clock.advance(HOUR);
    const result = await store.withTransaction((tx) =>
      publishEntriesTx(h.as('grace'), tx, h.scope, ids),
    );
    expect(result.failures).toEqual([]);

    const rows = await testDb
      .prepare(
        'SELECT e.id, e.modified_by, e.first_published_at AS e_first, p.first_published_at AS p_first FROM entries e JOIN entry_published p ON p.space_id = e.space_id AND p.environment_id = e.environment_id AND p.entry_id = e.id WHERE e.space_id = ?',
      )
      .bind(h.scope.spaceId)
      .all<{ id: string; modified_by: string; e_first: number; p_first: number }>();
    expect(rows.results).toHaveLength(120);
    const earlier = Date.parse('2026-05-01T10:00:00.000Z');
    const batch = Date.parse('2026-05-01T11:00:00.000Z');
    for (const r of rows.results) {
      expect(r.modified_by).toBe('grace');
      expect(r.e_first).toBe(r.id === ids[0] ? earlier : batch);
      expect(r.p_first).toBe(r.e_first);
    }
  });

  it('lists the caller’s own entries with sys.createdBy=me, across pages and nobody else’s', async () => {
    const h = await harness();
    const mine = new Set<string>();
    for (let i = 0; i < 110; i++) mine.add(await h.note('ada', `Mine ${i}`));
    await h.note('grace', 'Not mine');
    // The same author in another environment of the space is out of scope.
    await store.spaces.createEnvironment(h.scope.spaceId, 'staging', 'Staging');
    const staging = { ...h.scope, environmentId: 'staging' };
    const type = await store.contentTypes.get(h.scope, 'note');
    if (type) await store.contentTypes.save(staging, type);
    await createEntry(
      h.as('ada'),
      { ...h.scope, environmentId: 'staging' },
      {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': 'Elsewhere' } },
      },
    );

    const query = { filters: [{ field: 'sys.createdBy', op: 'eq' as const, value: 'me' }] };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPreviewEntryPage(h.as('ada'), h.scope, {
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        expect(item.createdBy).toBe('ada');
        seen.push(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen)).toEqual(mine);

    // No caller to name: `me` matches nothing, not an actor called "me".
    expect((await listPreviewEntryPage(h.base, h.scope, query)).items).toEqual([]);
    // `in` takes a list of actors (one JSON parameter, whatever its length).
    const both = await listPreviewEntryPage(h.as('grace'), h.scope, {
      filters: [
        {
          field: 'sys.createdBy',
          op: 'in',
          value: ['me', ...Array.from({ length: 150 }, (_, i) => `nobody-${i}`)],
        },
      ],
    });
    expect(both.items.map((e) => e.createdBy)).toEqual(['grace']);
  });

  it('sorts Delivery by sys.firstPublishedAt and serves no person ids', async () => {
    const h = await harness();
    const order: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      const id = await h.note('ada', title);
      h.clock.advance(HOUR);
      await publishEntry(h.as('ada'), h.scope, id);
      order.push(id);
    }
    // A republish of the first moves its publishedAt, not its first publish.
    h.clock.advance(HOUR);
    await updateEntry(h.as('grace'), h.scope, order[0] as string, { title: { 'en-US': 'One!' } });
    await publishEntry(h.as('grace'), h.scope, order[0] as string);

    const newest = await listPublishedEntries(h.base, h.scope, {
      contentTypeApiId: 'note',
      order: [{ field: 'sys.firstPublishedAt', direction: 'desc' }],
    });
    expect(newest.map((e) => e.id)).toEqual([...order].reverse());
    for (const e of newest) {
      expect(e.firstPublishedAt).toMatch(/^2026-05-01T/);
      expect(e).not.toHaveProperty('createdBy');
      expect(e).not.toHaveProperty('updatedBy');
    }
  });
});

describe('the 0024 backfill', () => {
  it('dates an existing entry from its first version, once', async () => {
    const h = await harness();
    const id = await h.note('ada', 'Old');
    h.clock.advance(HOUR);
    await updateEntry(h.as('ada'), h.scope, id, { title: { 'en-US': 'Older' } });
    // As the row was before the migration: nothing recorded.
    await testDb
      .prepare(
        'UPDATE entries SET created_at = NULL, created_by = NULL, modified_by = NULL WHERE space_id = ? AND id = ?',
      )
      .bind(h.scope.spaceId, id)
      .run();
    const backfill = migration.slice(migration.indexOf('UPDATE `entries`'));
    await testDb.prepare(backfill).run();
    const once = await row(h.scope, id);
    expect(once).toEqual({
      created_at: Date.parse('2026-05-01T09:00:00.000Z'),
      created_by: null,
      modified_by: null,
      first_published_at: null,
    });
    // Run again: nothing changes.
    await testDb.prepare(backfill).run();
    expect(await row(h.scope, id)).toEqual(once);
    expect((await store.entries.get(h.scope, id))?.entry.createdAt).toBe(
      '2026-05-01T09:00:00.000Z',
    );
  });
});

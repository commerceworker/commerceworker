import {
  type AppContext,
  archiveSupersededVersions,
  createContentType,
  createEntry,
  createSpace,
  diffVersions,
  getVersion,
  listVersions,
  publishContentType,
  publishEntry,
  restoreVersion,
  SYSTEM_CALLER,
  updateEntry,
  versionBodyKey,
} from '@commerceworker/application';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import migration from '../migrations/0004_version_bodies.sql?raw';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Superseded version bodies on D1: versions are queued as they are superseded, due a day later;
 * the sweep moves due bodies to object storage, D1 keeps the row without the body, and every
 * read of the version still returns it.
 */
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const blob = new FakeBlobStore();
const store = createD1Store(testDb, { versionBodies: blob });
const now: Clock = { now: () => new Date() };
const ctx: AppContext = { store, clock: now, ids };
/** The sweep's view, two days on: everything queued so far is due. */
const later: AppContext = { ...ctx, clock: { now: () => new Date(Date.now() + 2 * 86_400_000) } };
const spaceId = `vb-${crypto.randomUUID().slice(0, 8)}`;
const scope = { spaceId, environmentId: 'main' };
const title = (t: string) => ({ title: { 'en-US': t } });

async function seedModel() {
  await createSpace(ctx, { spaceId, name: 'VB', defaultLocale: 'en-US', locales: ['en-US'] });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
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
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'note');
}

async function noteWithHistory() {
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'note',
    fields: title('v1'),
  });
  await updateEntry(ctx, scope, entry.id, title('v2'));
  await publishEntry(ctx, scope, entry.id);
  await updateEntry(ctx, scope, entry.id, title('latest'));
  const live = (await store.entries.get(scope, entry.id))?.entry;
  if (!live) throw new Error('fixture');
  return live;
}

const rowsOf = async (entryId: string) =>
  (
    await testDb
      .prepare(
        'SELECT version, fields, body_key FROM entry_versions WHERE space_id = ? AND entry_id = ? ORDER BY version',
      )
      .bind(spaceId, entryId)
      .all<{ version: number; fields: string; body_key: string | null }>()
  ).results;

describe('superseded version bodies in object storage', () => {
  it('moves only superseded, unpublished versions once due, and every read still returns them', async () => {
    await seedModel();
    const live = await noteWithHistory();

    // Queued as they were superseded, but not due for a day.
    expect(await archiveSupersededVersions(ctx, blob)).toBe(0);
    expect(await archiveSupersededVersions(later, blob)).toBeGreaterThan(0);
    // Done: a second sweep finds nothing for this entry.
    expect(
      (await store.entries.claimArchivableVersions(1000, later.clock.now())).filter(
        (c) => c.entryId === live.id,
      ),
    ).toEqual([]);

    // In D1 the archived rows keep no body, only the key; current and published keep theirs.
    for (const row of await rowsOf(live.id)) {
      if (row.version === live.currentVersion || row.version === live.publishedVersion) {
        expect(row.body_key).toBeNull();
      } else {
        expect(row).toMatchObject({
          fields: '{}',
          body_key: versionBodyKey(scope, live.id, row.version),
        });
      }
    }

    // Reads: the version, the history, a diff, the current entry, and a restore.
    expect((await getVersion(ctx, scope, live.id, 1)).fields).toEqual(title('v1'));
    const history = await listVersions(ctx, scope, live.id);
    expect(history.find((v) => v.version === 1)?.fields).toEqual(title('v1'));
    const diff = await diffVersions(ctx, scope, live.id, 1, live.currentVersion);
    expect(diff.changes.find((c) => c.field === 'title')).toMatchObject({
      kind: 'changed',
      before: { 'en-US': 'v1' },
      after: { 'en-US': 'latest' },
    });
    expect((await store.entries.get(scope, live.id))?.fields).toEqual(title('latest'));
    await restoreVersion(ctx, scope, live.id, 1);
    expect((await store.entries.get(scope, live.id))?.fields).toEqual(title('v1'));
  });

  it('keeps the body of a version that became current again before it was marked', async () => {
    const live = await noteWithHistory();
    const [candidate] = (
      await store.entries.claimArchivableVersions(1000, later.clock.now())
    ).filter((c) => c.entryId === live.id && c.version === 1);
    if (!candidate) throw new Error('fixture');
    // A lost update moves the entry back onto version 1 between the claim and the mark.
    await testDb
      .prepare('UPDATE entries SET current_version = 1 WHERE space_id = ? AND id = ?')
      .bind(spaceId, live.id)
      .run();
    const bodyKey = versionBodyKey(scope, live.id, 1);
    expect(await store.entries.markVersionsArchived([{ ...candidate, bodyKey }])).toBe(0);
    expect((await rowsOf(live.id)).find((r) => r.version === 1)?.body_key).toBeNull();
    expect((await store.entries.get(scope, live.id))?.fields).toEqual(title('v1'));
  });

  it('reads an entry whose current version was archived from object storage, never as empty', async () => {
    const live = await noteWithHistory();
    await archiveSupersededVersions(later, blob);
    // A lost update lands after the mark and moves the entry back onto an archived version.
    await testDb
      .prepare('UPDATE entries SET current_version = 1 WHERE space_id = ? AND id = ?')
      .bind(spaceId, live.id)
      .run();
    expect((await store.entries.get(scope, live.id))?.fields).toEqual(title('v1'));
    const listed = await store.entries.getMany(scope, [live.id]);
    expect(listed[0]?.fields).toEqual(title('v1'));
  });

  it('shows a version whose archived body is missing as unavailable, without failing the history', async () => {
    const live = await noteWithHistory();
    await archiveSupersededVersions(later, blob);
    await blob.delete(versionBodyKey(scope, live.id, 1));
    const history = await listVersions(ctx, scope, live.id);
    expect(history.find((v) => v.version === 1)).toMatchObject({
      bodyUnavailable: true,
      fields: {},
    });
    expect(history.find((v) => v.version === live.currentVersion)?.fields).toEqual(title('latest'));
    // Reading that one version on its own is an error, not an empty body.
    await expect(getVersion(ctx, scope, live.id, 1)).rejects.toThrow(/missing/);
  });

  it('refuses, rather than inventing an empty body, when it has no object storage to read from', async () => {
    const archived = await testDb
      .prepare(
        'SELECT entry_id, version FROM entry_versions WHERE space_id = ? AND body_key IS NOT NULL LIMIT 1',
      )
      .bind(spaceId)
      .first<{ entry_id: string; version: number }>();
    if (!archived) throw new Error('needs the earlier tests');
    const bare = createD1Store(testDb);
    await expect(
      bare.entries.getVersion(scope, archived.entry_id, archived.version),
    ).rejects.toThrow(/archived/);
  });
});

describe('the 0004 backfill', () => {
  it('queues every version already superseded, due a day from now', async () => {
    const live = await noteWithHistory();
    // The migration runs once, against an empty queue.
    await testDb.prepare('DELETE FROM version_archive_queue').run();
    // The migration's own statement, run against rows that existed before it.
    const backfill = migration.slice(migration.indexOf('INSERT INTO `version_archive_queue`'));
    await testDb.prepare(backfill).run();
    const queued = await testDb
      .prepare(
        'SELECT version, due_at FROM version_archive_queue WHERE space_id = ? AND entry_id = ? ORDER BY version',
      )
      .bind(spaceId, live.id)
      .all<{ version: number; due_at: number }>();
    expect(queued.results.map((r) => r.version)).toEqual(
      Array.from({ length: live.currentVersion - 1 }, (_, i) => i + 1),
    );
    for (const r of queued.results) expect(r.due_at).toBeGreaterThan(Date.now() + 86_000_000);
  });
});

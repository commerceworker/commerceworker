import {
  type AppContext,
  BULK_JOB_MAX_ITEMS,
  createContentType,
  createEntry,
  createSpace,
  ENTRY_TRASH_CHUNK_SIZE,
  ENTRY_TRASH_MAX_ITEMS,
  entryTrashChunkRunner,
  getTrashSettings,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setTrashRetention,
  startBulkJob,
  sweepExpiredTrash,
  trashEntry,
} from '@commerceworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { countingD1 } from '@commerceworker/test-kit/d1';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Trash retention on D1 (0023_trash_retention): the space's setting, and the sweep's read of
 * expired trash, oldest first, past published links, on the partial `entries_trashed` index. An
 * archived entry's `updated_at` is when it was trashed; the store stamps it with database time, so
 * the tests move it back by hand. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

async function harness() {
  // A month and a bit after now, so anything trashed during the test is inside a 30-day window
  // until it is moved back.
  const clock = new FixedClock(new Date(Date.now() + 31 * DAY));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `trash-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Trash', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
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
      {
        apiId: 'see',
        name: 'See',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
    ] as FieldDefinition[],
  });
  await publishContentType(ctx, scope, 'note');
  return { ctx, clock, spaceId, scope };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function note(h: Harness, title: string, fields: Record<string, unknown> = {}) {
  return (
    await createEntry(h.ctx, h.scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title }, ...fields },
    })
  ).entry.id;
}

/** Sets when an entry last changed, as if it had been trashed `daysAgo` days before now. */
async function trashedAgo(h: Harness, id: string, daysAgo: number) {
  await testDb
    .prepare(
      'UPDATE entries SET updated_at = ? WHERE space_id = ? AND environment_id = ? AND id = ?',
    )
    .bind(Date.now() - daysAgo * DAY, h.scope.spaceId, h.scope.environmentId, id)
    .run();
}

describe('trash retention on D1', () => {
  it('stores the setting per space, off by default', async () => {
    const h = await harness();
    expect(await getTrashSettings(h.ctx, h.scope)).toEqual({ retentionDays: null });
    await setTrashRetention(h.ctx, admin, h.scope, 30);
    expect((await store.spaces.getConfig(h.scope))?.trashRetentionDays).toBe(30);
    expect((await store.spaces.list()).find((s) => s.spaceId === h.spaceId)).toMatchObject({
      trashRetentionDays: 30,
    });
    await setTrashRetention(h.ctx, admin, h.scope, null);
    expect((await store.spaces.getConfig(h.scope))?.trashRetentionDays).toBeUndefined();

    // The sweep's resume point, per environment.
    expect(await store.spaces.getTrashSweepCursor(h.scope)).toBeNull();
    const cursor = { trashedAt: '2026-01-01T00:00:00.000Z', id: uid() };
    await store.spaces.setTrashSweepCursor(h.scope, cursor);
    expect(await store.spaces.getTrashSweepCursor(h.scope)).toEqual(cursor);
    expect(
      await store.spaces.getTrashSweepCursor({ ...h.scope, environmentId: 'staging' }),
    ).toBeNull();
    await store.spaces.setTrashSweepCursor(h.scope, null);
    expect(await store.spaces.getTrashSweepCursor(h.scope)).toBeNull();
  });

  it('lists expired trash oldest first, past the parameter cap, leaving out linked entries', async () => {
    const h = await harness();
    const expired: string[] = [];
    for (let i = 0; i < 105; i++) {
      const id = await note(h, `n${i}`);
      await trashEntry(h.ctx, h.scope, id);
      await trashedAgo(h, id, 200 - i);
      expired.push(id);
    }
    const recent = await note(h, 'recent');
    await trashEntry(h.ctx, h.scope, recent);
    const untrashed = await note(h, 'kept');
    await trashedAgo(h, untrashed, 300);
    const linked = await note(h, 'linked');
    const linker = await note(h, 'linker', { see: { 'en-US': { id: linked, linkType: 'Entry' } } });
    await publishEntry(h.ctx, h.scope, linked);
    await publishEntry(h.ctx, h.scope, linker);
    await trashEntry(h.ctx, h.scope, linked);
    await trashedAgo(h, linked, 400);

    const before = new Date(Date.now() - 30 * DAY);
    const ids = async (limit: number, after?: { id: string; trashedAt: string }) =>
      (await store.entries.listExpiredTrash(h.scope, before, limit, after)).map((e) => e.id);
    expect(await ids(200)).toEqual(expired);
    const page = await store.entries.listExpiredTrash(h.scope, before, 3);
    expect(page.map((e) => e.id)).toEqual(expired.slice(0, 3));
    // The keyset cursor reads on after the last row of a page.
    const last = page.at(-1);
    expect(await ids(200, last)).toEqual(expired.slice(3));
    // Scoped: another environment of the space sees none of it.
    expect(
      await store.entries.listExpiredTrash({ ...h.scope, environmentId: 'staging' }, before, 200),
    ).toEqual([]);
  });

  it('sweeps what is past the window through purgeEntry, and nothing on a second run', async () => {
    const h = await harness();
    await setTrashRetention(h.ctx, admin, h.scope, 30);
    const old = await note(h, 'old');
    const young = await note(h, 'young');
    await trashEntry(h.ctx, h.scope, old);
    await trashEntry(h.ctx, h.scope, young);
    // The clock is 31 days ahead: `old` was trashed 31 + 10 days before it, `young` 31 - 20.
    await trashedAgo(h, old, 10);
    await trashedAgo(h, young, -20);

    const first = await sweepExpiredTrash(h.ctx, { limit: 1000 });
    expect(first.purged).toBeGreaterThanOrEqual(1);
    expect(await store.entries.get(h.scope, old)).toBeNull();
    expect(await store.entries.get(h.scope, young)).not.toBeNull();
    expect((await store.entries.listVersions(h.scope, old)).length).toBe(0);

    const second = await sweepExpiredTrash(h.ctx, { limit: 1000 });
    expect(await store.entries.get(h.scope, young)).not.toBeNull();
    // Other tests' spaces share the database; none of this space's entries go twice.
    expect(second.refused).toBe(0);
  });
});

describe('what an entry trash chunk costs on D1', () => {
  it('stays inside one invocation’s query budget at its chunk size', async () => {
    const h = await harness();
    const counter = countingD1(testDb);
    const counted: AppContext = { ...h.ctx, store: createD1Store(counter.d1) };
    const ids: string[] = [];
    for (let i = 0; i < ENTRY_TRASH_CHUNK_SIZE; i++) ids.push(await note(h, `c${i}`));

    const one = await counter.measure(() => trashEntry(counted, h.scope, ids[0] ?? ''));
    const trashRest = await counter.measure(() =>
      entryTrashChunkRunner(counted)(h.scope, job('trash'), chunk(ids)),
    );
    const purgeOne = await counter.measure(async () => {
      const { purgeEntry } = await import('@commerceworker/application');
      await purgeEntry(counted, h.scope, ids[0] ?? '');
    });
    const purgeAll = await counter.measure(() =>
      entryTrashChunkRunner(counted)(h.scope, job('purge'), chunk(ids)),
    );
    console.log(
      JSON.stringify({
        chunk: ENTRY_TRASH_CHUNK_SIZE,
        trashOne: { statements: one.statements, roundTrips: one.roundTrips },
        trashChunk: { statements: trashRest.statements, roundTrips: trashRest.roundTrips },
        purgeOne: { statements: purgeOne.statements, roundTrips: purgeOne.roundTrips },
        purgeChunk: { statements: purgeAll.statements, roundTrips: purgeAll.roundTrips },
      }),
    );
    // A Worker invocation may send D1 at most 1,000 queries; leave room for the claim, the
    // completion and the finalize around the chunk.
    expect(trashRest.statements).toBeLessThan(800);
    expect(purgeAll.statements).toBeLessThan(800);
  });
});

const chunk = (entryIds: string[]) => ({
  jobId: 'j',
  chunkId: 'c00000',
  entryIds,
  status: 'running' as const,
  attempts: 1,
  failures: [],
});
const job = (action: 'trash' | 'purge') => ({
  id: 'j',
  action,
  status: 'running' as const,
  totalItems: 1,
  totalChunks: 1,
  completedChunks: 0,
  succeeded: 0,
  failed: 0,
  createdAt: new Date().toISOString(),
});

describe('starting the largest bulk jobs on D1', () => {
  it('writes a trash job at its cap, and a publish job at its cap, in under 1,000 statements', async () => {
    const h = await harness();
    const counter = countingD1(testDb);
    const counted: AppContext = { ...h.ctx, store: createD1Store(counter.d1) };
    const ids = (n: number) => Array.from({ length: n }, () => uid());

    const purge = await counter.measure(() =>
      startBulkJob(counted, h.scope, { action: 'purge', entryIds: ids(ENTRY_TRASH_MAX_ITEMS) }),
    );
    const publish = await counter.measure(() =>
      startBulkJob(counted, h.scope, { action: 'publish', entryIds: ids(BULK_JOB_MAX_ITEMS) }),
    );
    console.log(
      JSON.stringify({
        purgeAtCap: { statements: purge.statements, roundTrips: purge.roundTrips },
        publishAtCap: { statements: publish.statements, roundTrips: publish.roundTrips },
      }),
    );
    expect(purge.statements).toBeLessThan(1000);
    expect(publish.statements).toBeLessThan(1000);
    await expect(
      startBulkJob(counted, h.scope, { action: 'trash', entryIds: ids(ENTRY_TRASH_MAX_ITEMS + 1) }),
    ).rejects.toMatchObject({
      issues: [{ field: 'entryIds', message: `Job exceeds ${ENTRY_TRASH_MAX_ITEMS} items` }],
    });
  }, 120_000);
});

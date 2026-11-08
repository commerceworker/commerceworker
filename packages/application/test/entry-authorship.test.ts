import {
  type BulkChunkDueEvent,
  type Entry,
  type FieldDefinition,
  MAX_ENTRY_ACTOR_LENGTH,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  actingAs,
  cloneEnvironment,
  createContentType,
  createEntry,
  createSnapshotEntry,
  createSpace,
  duplicateEntry,
  exportSnapshot,
  getPreviewEntry,
  getPublishedEntry,
  importSnapshot,
  listPreviewEntryPage,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  restoreEntry,
  runBulkChunk,
  runDueScheduledActions,
  SYSTEM_CALLER,
  scheduleAction,
  stagedEntry,
  startBulkJob,
  trashEntry,
  unpublishEntry,
  updateEntry,
  withActor,
} from '../src/index';

const main = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };
const HOUR = 60 * 60 * 1000;

let base: AppContext;
let store: InMemoryContentStore;
let clock: FixedClock;
const as = (actor: string) => withActor(base, actor);

async function note(ctx: AppContext, title: string, scope = main): Promise<string> {
  return (
    await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title } },
    })
  ).entry.id;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  clock = new FixedClock(new Date('2026-05-01T09:00:00.000Z'));
  store.nowMs = () => clock.now().getTime();
  base = { store, clock, ids: new SequenceIdGenerator('e') };
  await createSpace(base, {
    spaceId: 's1',
    name: 'S1',
    defaultLocale: 'en-US',
    environments: ['main', 'staging', 'copy', 'upload'],
  });
  for (const scope of [main, staging]) {
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
  }
});

describe('entry authorship', () => {
  it('credits the creator, then whoever changes it, with each version saved by its author', async () => {
    const id = await note(as('ada'), 'Draft');
    expect((await store.entries.get(main, id))?.entry).toMatchObject({
      createdAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'ada',
      firstPublishedAt: null,
    });

    clock.advance(HOUR);
    await updateEntry(as('grace'), main, id, { title: { 'en-US': 'Edited' } });
    await trashEntry(as('linus'), main, id);
    expect((await store.entries.get(main, id))?.entry).toMatchObject({
      createdBy: 'ada',
      updatedBy: 'linus',
    });
    await restoreEntry(as('grace'), main, id);
    const preview = await getPreviewEntry(base, main, id);
    expect(preview).toMatchObject({
      createdAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'grace',
      firstPublishedAt: null,
    });
    const versions = await store.entries.listVersions(main, id);
    expect(versions.map((v) => v.createdBy)).toEqual(['grace', 'ada']);
  });

  it('records the first publish once, kept through unpublish and republish', async () => {
    const id = await note(as('ada'), 'Live');
    clock.advance(HOUR);
    await publishEntry(as('grace'), main, id);
    clock.advance(HOUR);
    await unpublishEntry(as('ada'), main, id);
    clock.advance(HOUR);
    await publishEntry(as('ada'), main, id);

    const entry = (await store.entries.get(main, id))?.entry;
    expect(entry?.firstPublishedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(entry?.updatedBy).toBe('ada');
    // Delivery serves the first publish, and none of the people.
    const delivered = await getPublishedEntry(base, main, id);
    expect(delivered.firstPublishedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(delivered.publishedAt).toBe('2026-05-01T12:00:00.000Z');
    expect(JSON.stringify(delivered)).not.toMatch(/ada|grace/);
  });

  it('leaves the first publish unknown for an entry live before it was recorded', async () => {
    const id = await note(as('ada'), 'Legacy');
    await publishEntry(as('ada'), main, id);
    // As an entry published before 0024: live, with no first publish on record.
    const found = await store.entries.get(main, id);
    // The store's row, reached past its API: nothing it offers can clear a first publish.
    const rows = (store as unknown as { entryData: Map<string, Entry> }).entryData;
    rows.set(`s1::main::${id}`, {
      ...(found?.entry as NonNullable<typeof found>['entry']),
      firstPublishedAt: null,
    });
    clock.advance(HOUR);
    await publishEntry(as('ada'), main, id);
    expect((await store.entries.get(main, id))?.entry.firstPublishedAt).toBeNull();
  });

  it('credits whoever duplicates an entry with the copy', async () => {
    const id = await note(as('ada'), 'Original');
    const copy = await duplicateEntry(as('grace'), main, id);
    expect(copy.entry).toMatchObject({ createdBy: 'grace', updatedBy: 'grace' });
  });

  it('writes a person’s audit identity when acting for a request', async () => {
    const id = await note(
      actingAs(base, { spaceId: 's1', kind: 'user', subject: 'user-7', scopes: [] }),
      'Signed in',
    );
    const key = await note(actingAs(base, { spaceId: 's1', kind: 'cma', scopes: [] }), 'Key');
    expect((await store.entries.get(main, id))?.entry.createdBy).toBe('user-7');
    expect((await store.entries.get(main, key))?.entry.createdBy).toBe('cma');
    // Nobody named: unattributed, never a guess.
    const anonymous = await note(base, 'Nobody');
    expect((await store.entries.get(main, anonymous))?.entry.createdBy).toBeNull();
  });

  it('publishes on schedule as the system', async () => {
    const id = await note(as('ada'), 'Scheduled');
    await scheduleAction(as('ada'), main, {
      entityType: 'Entry',
      entityId: id,
      action: 'publish',
      scheduledFor: '2026-05-01T10:00:00.000Z',
    });
    clock.advance(2 * HOUR);
    expect(await runDueScheduledActions(base)).toMatchObject({ executed: 1 });
    expect((await store.entries.get(main, id))?.entry).toMatchObject({
      createdBy: 'ada',
      updatedBy: 'system',
      firstPublishedAt: '2026-05-01T11:00:00.000Z',
    });
  });

  it('writes a bulk job’s chunks as whoever started it, the same on a redelivered chunk', async () => {
    const ids = [await note(as('ada'), 'One'), await note(as('ada'), 'Two')];
    const job = await startBulkJob(as('grace'), main, { action: 'publish', entryIds: ids });
    expect(job.config?.actor).toBe('grace');
    const [due] = store
      .allEvents()
      .filter((e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due');
    // The consumer has no principal of its own.
    await runBulkChunk(base, due as BulkChunkDueEvent);
    clock.advance(HOUR);
    await runBulkChunk(base, due as BulkChunkDueEvent);
    for (const id of ids) {
      expect((await store.entries.get(main, id))?.entry).toMatchObject({
        createdBy: 'ada',
        updatedBy: 'grace',
        firstPublishedAt: '2026-05-01T09:00:00.000Z',
      });
    }
  });

  it('keeps an entry’s authorship when an environment copy brings it over', async () => {
    const id = await note(as('ada'), 'Cloned');
    await publishEntry(as('ada'), main, id);
    const found = await store.entries.get(main, id);
    clock.advance(HOUR);
    const staged = stagedEntry(
      {
        id,
        contentTypeApiId: 'note',
        status: 'published',
        fields: found?.fields ?? {},
        createdAt: found?.entry.createdAt ?? undefined,
        createdBy: found?.entry.createdBy ?? undefined,
        firstPublishedAt: found?.entry.firstPublishedAt ?? undefined,
      },
      new Map(),
      true,
      true,
    );
    await createSnapshotEntry(as('grace'), staging, staged);
    expect((await store.entries.get(staging, id))?.entry).toMatchObject({
      createdAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'grace',
      firstPublishedAt: '2026-05-01T09:00:00.000Z',
    });
  });

  it('keeps the creator through a clone, and credits the importer of an uploaded snapshot', async () => {
    const id = await note(as('ada'), 'Travels');
    await publishEntry(as('ada'), main, id);
    clock.advance(HOUR);
    await cloneEnvironment(as('grace'), main, { spaceId: 's1', environmentId: 'copy' });
    expect(
      (await store.entries.get({ spaceId: 's1', environmentId: 'copy' }, id))?.entry,
    ).toMatchObject({
      createdBy: 'ada',
      createdAt: '2026-05-01T09:00:00.000Z',
      firstPublishedAt: '2026-05-01T09:00:00.000Z',
    });

    // An uploaded file names whoever it likes: the importer is credited, the instants are kept.
    const snapshot = await exportSnapshot(base, main);
    const forged = {
      ...snapshot,
      entries: snapshot.entries.map((e) => ({ ...e, createdBy: 'someone-else' })),
    };
    const upload = { spaceId: 's1', environmentId: 'upload' };
    await importSnapshot(as('grace'), upload, forged);
    expect((await store.entries.get(upload, id))?.entry).toMatchObject({
      createdBy: 'grace',
      createdAt: '2026-05-01T09:00:00.000Z',
      firstPublishedAt: '2026-05-01T09:00:00.000Z',
    });
  });

  it('keeps the source’s authorship when a merge brings a new entry over', async () => {
    const id = await note(as('ada'), 'Merged');
    await publishEntry(as('ada'), main, id);
    clock.advance(HOUR);
    await mergeEnvironments(as('grace'), 's1', 'main', 'staging', { entries: [id] });
    expect((await store.entries.get(staging, id))?.entry).toMatchObject({
      createdAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'grace',
      firstPublishedAt: '2026-05-01T09:00:00.000Z',
    });
    // Merged again onto the copy it made: the target's own authorship stays, grace changed it.
    await updateEntry(as('ada'), main, id, { title: { 'en-US': 'Merged again' } });
    await mergeEnvironments(as('grace'), 's1', 'main', 'staging', { entries: [id] });
    expect((await store.entries.get(staging, id))?.entry).toMatchObject({
      createdBy: 'ada',
      updatedBy: 'grace',
      currentVersion: 2,
    });
  });

  it('refuses a snapshot whose authorship is malformed, before writing anything', async () => {
    await note(as('ada'), 'Dated');
    const snapshot = await exportSnapshot(base, main);
    const upload = { spaceId: 's1', environmentId: 'upload' };
    for (const bad of [
      { createdAt: 'yesterday' },
      { firstPublishedAt: '2026-13-45T99:00:00Z' },
      { createdBy: 'x'.repeat(MAX_ENTRY_ACTOR_LENGTH + 1) },
      { createdAt: 12 },
    ]) {
      const broken = { ...snapshot, entries: snapshot.entries.map((e) => ({ ...e, ...bad })) };
      await expect(importSnapshot(as('grace'), upload, broken as never)).rejects.toThrow(
        ValidationError,
      );
    }
    expect(await store.contentTypes.list(upload)).toEqual([]);
  });

  it('lists my entries with sys.createdBy=me, and only in the scope asked', async () => {
    const mine = await note(as('ada'), 'Mine');
    await note(as('grace'), 'Theirs');
    await note(as('ada'), 'Elsewhere', staging);
    const me = { filters: [{ field: 'sys.createdBy', op: 'eq' as const, value: 'me' }] };
    expect((await listPreviewEntryPage(as('ada'), main, me)).items.map((e) => e.id)).toEqual([
      mine,
    ]);
    const notMine = await listPreviewEntryPage(as('ada'), main, {
      filters: [{ field: 'sys.createdBy', op: 'ne', value: 'me' }],
    });
    expect(notMine.items.map((e) => e.createdBy)).toEqual(['grace']);
    // Sorted by who changed it last, then by when it was created.
    const sorted = await listPreviewEntryPage(base, main, {
      order: [{ field: 'sys.updatedBy', direction: 'desc' }],
    });
    expect(sorted.items.map((e) => e.updatedBy)).toEqual(['grace', 'ada']);
  });
});

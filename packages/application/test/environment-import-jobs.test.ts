import {
  type BulkChunkDueEvent,
  type DomainEvent,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each test seeds and copies a 150-entry environment through the use-cases: seconds on a CI runner.
vi.setConfig({ testTimeout: 30_000 });

import {
  type AppContext,
  cancelBulkJob,
  createContentType,
  createEntry,
  createEnvironment,
  createSnapshotAsset,
  createSnapshotEntry,
  createTag,
  dispatchEvent,
  exportSnapshot,
  getBulkJob,
  getBulkJobReport,
  importChunkRunner,
  publishAsset,
  publishContentType,
  publishEntry,
  publishSnapshotEntry,
  runBulkChunk,
  SNAPSHOT_JOB_CHUNK_SIZE,
  SYSTEM_CALLER,
  setEntryMetadata,
  stagedEntry,
  stagedPublication,
  startEnvironmentClone,
  startSnapshotImport,
  updateEntry,
} from '../src/index';

const source = { spaceId: 's1', environmentId: 'main' };
const target = { spaceId: 's1', environmentId: 'copy' };
const COUNT = 150; // two create chunks, so links cross a chunk boundary

let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;
const ran = new Set<string>();

/** Runs every `bulk.chunk_due` not yet run, as the engine's bulk consumer would, until none are left. */
async function drain(opts: { only?: (e: BulkChunkDueEvent) => boolean } = {}) {
  for (let round = 0; round < 20; round++) {
    const due = (await store.outbox.readPending(10_000)).filter(
      (e: DomainEvent): e is BulkChunkDueEvent =>
        e.type === 'bulk.chunk_due' && !ran.has(e.id) && (opts.only?.(e) ?? true),
    );
    if (due.length === 0) return;
    for (const event of due) {
      ran.add(event.id);
      await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob) });
    }
  }
}

async function seedSource() {
  await createContentType(ctx, SYSTEM_CALLER, source, {
    apiId: 'category',
    name: 'Category',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'next',
        name: 'Next',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'image',
        name: 'Image',
        type: 'Link',
        linkType: 'Asset',
        localized: false,
        required: false,
        position: 2,
      },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, source, 'category');
  const asset = await store.assets.create(source, {
    id: 'asset-1',
    status: 'draft',
    file: { url: '/media/s1/main/asset-1/a.png', fileName: 'a.png', contentType: 'image/png' },
    title: {},
    description: {},
    metadata: { altText: {}, tags: [] },
  } as never);
  void asset;
  await publishAsset(ctx, source, 'asset-1');
  const tag = await createTag(ctx, source, { name: 'news' });

  const ids: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const { entry } = await createEntry(ctx, source, {
      contentTypeApiId: 'category',
      fields: { name: { 'en-US': `Category ${i}` } },
    });
    ids.push(entry.id);
  }
  // Each links the NEXT one, which a later chunk creates: publishing must wait for all of them.
  for (let i = 0; i < COUNT; i++) {
    await updateEntry(ctx, source, ids[i] as string, {
      name: { 'en-US': `Category ${i}` },
      ...(i + 1 < COUNT ? { next: { 'en-US': { id: ids[i + 1], linkType: 'Entry' } } } : {}),
      image: { 'en-US': { id: 'asset-1', linkType: 'Asset' } },
    });
  }
  for (const id of ids) await publishEntry(ctx, source, id);
  await setEntryMetadata(ctx, source, ids[0] as string, { tags: [tag.id], concepts: [] });
  // One changed entry: live version published, newer draft on top.
  await updateEntry(ctx, source, ids[1] as string, {
    name: { 'en-US': 'Category 1 (draft edit)' },
    next: { 'en-US': { id: ids[2], linkType: 'Entry' } },
    image: { 'en-US': { id: 'asset-1', linkType: 'Asset' } },
  });
  return ids;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  blob = new FakeBlobStore();
  ran.clear();
  await createEnvironment(ctx, 's1', 'copy');
});

describe('importing an environment as a job', () => {
  it('writes the model at once, then creates everything, then publishes as the source had it', async () => {
    const ids = await seedSource();
    const started = await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source));

    expect(started.report).toMatchObject({ entries: COUNT, published: COUNT, contentTypes: 1 });
    const job = started.job;
    if (!job) throw new Error('expected a job');
    expect(job).toMatchObject({ action: 'import', status: 'running', totalItems: COUNT + 1 });
    expect(job.totalChunks).toBe(Math.ceil((COUNT + 1) / SNAPSHOT_JOB_CHUNK_SIZE));
    expect(started.publishJobId).toBeTruthy();
    // The model is there before any chunk runs; no entry is yet.
    expect((await store.contentTypes.list(target)).map((t) => t.apiId)).toEqual(['category']);
    expect(await store.entries.list(target, {})).toEqual([]);

    // Run only the create job's chunks: nothing is published, and the publishing job starts
    // only once the last of them completes.
    await drain({ only: (e) => e.jobId === job.id });
    expect((await getBulkJob(ctx, target, job.id)).status).toBe('completed');
    const publishing = await getBulkJob(ctx, target, started.publishJobId as string);
    expect(publishing).toMatchObject({ status: 'running', totalItems: COUNT + 1 });
    expect(await store.entries.getPublished(target, ids[0] as string)).toBeNull();

    await drain();
    expect(await getBulkJob(ctx, target, started.publishJobId as string)).toMatchObject({
      status: 'completed',
      succeeded: COUNT + 1,
      failed: 0,
    });
    // Every entry, under its own id, published with its forward link resolved in the target.
    const first = await store.entries.getPublished(target, ids[0] as string);
    expect(first?.fields.next).toEqual({ 'en-US': { id: ids[1], linkType: 'Entry' } });
    expect((await store.assets.get(target, 'asset-1'))?.status).toBe('published');
    // The changed entry: its live version published, its draft on top.
    const changed = await store.entries.get(target, ids[1] as string);
    expect(changed?.entry.status).toBe('changed');
    expect(changed?.fields.name).toEqual({ 'en-US': 'Category 1 (draft edit)' });
    expect((await store.entries.getPublished(target, ids[1] as string))?.fields.name).toEqual({
      'en-US': 'Category 1',
    });
    // Taxonomy remapped onto the target's own tag.
    const [targetTag] = await store.taxonomy.listTags(target);
    const meta = await store.taxonomy.getEntryMetadataMany(target, [ids[0] as string]);
    expect(meta[0]?.metadata.tags).toEqual([targetTag?.id]);
    // Staged work is cleaned up as chunks finish.
    expect(blob.keys().filter((k) => k.startsWith('imports/'))).toEqual([]);
  });

  it('refuses a bad snapshot before writing anything, as the synchronous import does', async () => {
    await seedSource();
    const snapshot = await exportSnapshot(ctx, source);
    const broken = { ...snapshot, contentTypes: [] };
    await expect(startSnapshotImport(ctx, blob, target, broken)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.contentTypes.list(target)).toEqual([]);
    expect(blob.keys()).toEqual([]);
  });

  it('leaves everything as drafts, with no publishing job, when publishing is off', async () => {
    const ids = await seedSource();
    const started = await startSnapshotImport(
      ctx,
      blob,
      target,
      await exportSnapshot(ctx, source),
      { publish: false },
    );
    expect(started.publishJobId).toBeNull();
    await drain();
    expect(await store.entries.list(target, { limit: 1000 })).toHaveLength(COUNT);
    expect(await store.entries.getPublished(target, ids[0] as string)).toBeNull();
  });

  it('never starts publishing when the create job is cancelled', async () => {
    await seedSource();
    const started = await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source));
    const job = started.job;
    if (!job) throw new Error('expected a job');
    await cancelBulkJob(ctx, target, job.id);
    await drain();
    await expect(getBulkJob(ctx, target, started.publishJobId as string)).rejects.toThrow();
  });

  it('answers at once with no job for a snapshot with no entries or assets', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    const started = await startSnapshotImport(ctx, blob, target, snapshot);
    expect(started).toMatchObject({ job: null, publishJobId: null });
  });
});

describe('a snapshot chunk run again after it committed', () => {
  it('neither duplicates entries nor makes a changed entry’s draft live', async () => {
    const ids = await seedSource();
    const snapshot = await exportSnapshot(ctx, source);
    const changed = snapshot.entries.find((e) => e.id === ids[1]);
    if (!changed) throw new Error('fixture');
    await startSnapshotImport(ctx, blob, target, { ...snapshot, entries: [] });
    const staged = stagedEntry(changed, new Map(), true);
    // Its link targets, so publishing can resolve them.
    for (const e of snapshot.entries) {
      await createSnapshotEntry(
        ctx,
        target,
        stagedEntry({ ...e, metadata: undefined }, new Map(), true),
      );
    }
    await createSnapshotAsset(ctx, target, snapshot.assets[0] as never);
    for (let run = 0; run < 2; run++) {
      await createSnapshotEntry(ctx, target, staged);
      await publishSnapshotEntry(ctx, target, stagedPublication(changed));
    }
    const live = await store.entries.getPublished(target, changed.id);
    expect(live?.fields.name).toEqual({ 'en-US': 'Category 1' });
    expect((await store.entries.get(target, changed.id))?.fields.name).toEqual({
      'en-US': 'Category 1 (draft edit)',
    });
  });
});

describe('when the create job does not finish cleanly', () => {
  it('counts a chunk that fails for good as failures, and never starts publishing', async () => {
    await seedSource();
    const started = await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source));
    const job = started.job;
    if (!job) throw new Error('expected a job');
    const first = (await store.outbox.readPending(10_000)).find(
      (e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due' && e.jobId === job.id,
    ) as BulkChunkDueEvent;
    // Its staged work is gone, so every attempt throws until the chunk is failed for good.
    await blob.delete(`imports/s1/copy/${job.id}/${first.chunkId}.json`);
    for (let attempt = 0; attempt < 7; attempt++) {
      await runBulkChunk(ctx, first, { importChunk: importChunkRunner(ctx, blob) }).catch(() => {});
    }
    ran.add(first.id);
    await drain();

    const finished = await getBulkJob(ctx, target, job.id);
    expect(finished).toMatchObject({ status: 'completed', failed: SNAPSHOT_JOB_CHUNK_SIZE });
    expect(finished.succeeded + finished.failed).toBe(finished.totalItems);
    await expect(getBulkJob(ctx, target, started.publishJobId as string)).rejects.toThrow();

    // Its completion discards what is still staged, the unstarted publishing job's included.
    const completed = (await store.outbox.readPending(10_000)).filter(
      (e) => e.type === 'bulk.job_completed',
    );
    for (const event of completed) {
      await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, event);
    }
    expect(blob.keys().filter((k) => k.startsWith('imports/'))).toEqual([]);
  });

  it('discards everything staged when the create job is cancelled', async () => {
    await seedSource();
    const started = await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source));
    expect(blob.keys().filter((k) => k.startsWith('imports/')).length).toBeGreaterThan(0);
    await cancelBulkJob(ctx, target, started.job?.id as string, { blob });
    expect(blob.keys().filter((k) => k.startsWith('imports/'))).toEqual([]);
  });

  it('leaves the target untouched when staging fails, so a retry works', async () => {
    await seedSource();
    const failing = Object.assign(Object.create(blob), {
      put: async () => {
        throw new Error('R2 unavailable');
      },
    }) as FakeBlobStore;
    await expect(
      startSnapshotImport(ctx, failing, target, await exportSnapshot(ctx, source)),
    ).rejects.toThrow(/R2/);
    expect(await store.contentTypes.list(target)).toEqual([]);
    const retried = await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source));
    expect(retried.job?.status).toBe('running');
  });
});

describe('cloning an environment', () => {
  it('runs the export and every check in a job, then the create and publish jobs', async () => {
    const ids = await seedSource();
    const started = await startEnvironmentClone(ctx, source, target);
    expect(started.job).toMatchObject({ action: 'import', status: 'running', totalItems: 1 });
    // Nothing is exported, checked or written in the request.
    expect(await store.contentTypes.list(target)).toEqual([]);
    expect(blob.keys()).toEqual([]);

    await drain();
    expect(await getBulkJob(ctx, target, started.job.id)).toMatchObject({
      status: 'completed',
      succeeded: 1,
    });
    expect(await getBulkJob(ctx, target, started.createJobId)).toMatchObject({
      status: 'completed',
      succeeded: COUNT + 1,
    });
    expect(await getBulkJob(ctx, target, started.publishJobId)).toMatchObject({
      status: 'completed',
      failed: 0,
    });
    expect(await store.entries.getPublished(target, ids[0] as string)).not.toBeNull();
  });

  it('fails its prepare job, naming the problem, when the checks refuse the source', async () => {
    await seedSource();
    // An entry the source's own model now refuses (its type removed from the snapshot's view).
    const list = store.contentTypes.list.bind(store.contentTypes);
    store.contentTypes.list = async (scope) => (scope.environmentId === 'main' ? [] : list(scope));
    const started = await startEnvironmentClone(ctx, source, target);
    await drain();
    const report = await getBulkJobReport(ctx, target, started.job.id);
    expect(report.job).toMatchObject({ status: 'completed', succeeded: 0, failed: 1 });
    expect(report.chunks[0]?.failures[0]?.error).toMatch(/content type "category"/);
    expect(await store.contentTypes.list(target)).toEqual([]);
    await expect(getBulkJob(ctx, target, started.createJobId)).rejects.toThrow();
  });

  it('does nothing when its prepare chunk runs again after starting the create job', async () => {
    await seedSource();
    const started = await startEnvironmentClone(ctx, source, target);
    const runner = importChunkRunner(ctx, blob);
    const job = await getBulkJob(ctx, target, started.job.id);
    const chunk = (await store.bulkJobs.listChunks(target, job.id))[0];
    if (!chunk) throw new Error('fixture');
    expect(await runner(target, job, chunk)).toEqual({ succeeded: 1, failures: [] });
    // As a redelivered prepare chunk would, after a crash before its outcome was recorded.
    expect(await runner(target, job, chunk)).toEqual({ succeeded: 1, failures: [] });
  });

  it('refuses at once a target that is missing or not empty', async () => {
    await seedSource();
    await expect(
      startEnvironmentClone(ctx, source, { spaceId: 's1', environmentId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(startEnvironmentClone(ctx, source, source)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

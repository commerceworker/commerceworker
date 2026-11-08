import type {
  BulkChunkDueEvent,
  DomainEvent,
  EntriesPublishedBulkEvent,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  InMemoryQueue,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  BULK_TOPIC,
  cancelBulkJob,
  createContentType,
  createEntry,
  createSpace,
  createWebhook,
  dispatchEvent,
  EVENTS_TOPIC,
  getBulkJob,
  getBulkJobReport,
  getPublishedEntry,
  relayOutbox,
  resumeStalledBulkJobs,
  runBulkChunk,
  SYSTEM_CALLER,
  startBulkJob,
  unpublishEntry,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const clock = new FixedClock();
  store.nowMs = () => clock.now().getTime();
  const cache = new InMemoryCache();
  const queue = new InMemoryQueue();
  const sender = new RecordingWebhookSender();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('e'), cache };
  // Both topics dispatch through the same body (mirrors both hosts).
  const handler = (payload: unknown) =>
    dispatchEvent(ctx, { sender, cache }, payload as DomainEvent);
  queue.process(EVENTS_TOPIC, handler);
  queue.process(BULK_TOPIC, handler);
  return { ctx, store, clock, cache, queue, sender };
}

async function seedEntries(ctx: AppContext, n: number): Promise<string[]> {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
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
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': `Page ${i}` } },
    });
    ids.push(entry.entry.id);
  }
  return ids;
}

const chunkDueEvents = (store: InMemoryContentStore): BulkChunkDueEvent[] =>
  store.allEvents().filter((e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due');

describe('bulk jobs', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('runs a job end-to-end: chunks, coalesced events, completion, report', async () => {
    const ids = await seedEntries(h.ctx, 5);
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    expect(job.status).toBe('running');
    expect(job.totalItems).toBe(5);
    expect(job.totalChunks).toBe(1);

    // Relay: chunk_due routes to the bulk topic by default.
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain(); // consume chunk_due → runBulkChunk publishes the chunk
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain(); // consume published_bulk + job_completed

    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.status).toBe('completed');
    expect(done.succeeded).toBe(5);
    expect(done.failed).toBe(0);
    expect(done.completedAt).toBeTruthy();

    // ONE coalesced fact instead of 5 per-entry events; a terminal summary.
    const events = h.store.allEvents();
    expect(events.filter((e) => e.type === 'entry.published')).toHaveLength(0);
    const bulk = events.filter(
      (e): e is EntriesPublishedBulkEvent => e.type === 'entries.published_bulk',
    );
    expect(bulk).toHaveLength(1);
    expect([...(bulk[0]?.entryIds ?? [])].sort()).toEqual([...ids].sort());
    expect(events.filter((e) => e.type === 'bulk.job_completed')).toHaveLength(1);

    // Entries actually published.
    for (const id of ids) {
      expect(await getPublishedEntry(h.ctx, scope, id)).toBeTruthy();
    }

    const report = await getBulkJobReport(h.ctx, scope, job.id);
    expect(report.chunks).toHaveLength(1);
    expect(report.chunks[0]).toMatchObject({ status: 'completed', itemCount: 5, failures: [] });
  });

  it('splits a job spanning multiple chunks and finalizes only after the last', async () => {
    const ids = await seedEntries(h.ctx, 201); // BULK_JOB_CHUNK_SIZE + 1 → 2 chunks
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    expect(job.totalChunks).toBe(2);

    const [first, second] = chunkDueEvents(h.store);
    await runBulkChunk(h.ctx, first as BulkChunkDueEvent);
    // One chunk in: job still running.
    expect((await getBulkJob(h.ctx, scope, job.id)).status).toBe('running');
    await runBulkChunk(h.ctx, second as BulkChunkDueEvent);
    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.status).toBe('completed');
    expect(done.succeeded).toBe(201);
    // One coalesced event per chunk, one terminal summary.
    const events = h.store.allEvents();
    expect(events.filter((e) => e.type === 'entries.published_bulk')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'bulk.job_completed')).toHaveLength(1);
  });

  it('partitions per-item failures into the report without failing the chunk', async () => {
    const ids = await seedEntries(h.ctx, 2);
    const job = await startBulkJob(h.ctx, scope, {
      action: 'publish',
      entryIds: [...ids, 'missing-entry'],
    });
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain();

    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.status).toBe('completed');
    expect(done.succeeded).toBe(2);
    expect(done.failed).toBe(1);
    const report = await getBulkJobReport(h.ctx, scope, job.id);
    expect(report.chunks[0]?.failures).toEqual([
      { id: 'missing-entry', error: expect.stringContaining('missing-entry') },
    ]);
  });

  it('a redelivered chunk_due event loses the CAS claim and no-ops', async () => {
    const ids = await seedEntries(h.ctx, 2);
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    const due = chunkDueEvents(h.store)[0];
    expect(due).toBeTruthy();
    const event = due as BulkChunkDueEvent;

    const first = await runBulkChunk(h.ctx, event);
    expect(first.outcome).toBe('processed');
    // Same event again (at-least-once redelivery): chunk is terminal → no-op.
    const second = await runBulkChunk(h.ctx, event);
    expect(second.outcome).toBe('skipped');
    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.succeeded).toBe(2); // counted once
  });

  it('cancel stops pending chunks and is idempotent', async () => {
    const ids = await seedEntries(h.ctx, 2);
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    const cancelled = await cancelBulkJob(h.ctx, scope, job.id);
    expect(cancelled.status).toBe('cancelled');

    // The pending chunk's event now no-ops (job not running).
    const due = chunkDueEvents(h.store)[0] as BulkChunkDueEvent;
    expect((await runBulkChunk(h.ctx, due)).outcome).toBe('skipped');
    expect((await cancelBulkJob(h.ctx, scope, job.id)).status).toBe('cancelled');
  });

  it('the stall sweep re-nudges stale chunks and the rerun completes the job', async () => {
    const ids = await seedEntries(h.ctx, 2);
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    const due = chunkDueEvents(h.store)[0] as BulkChunkDueEvent;

    // Simulate a crashed worker: claim the chunk, then never complete it.
    const now = h.clock.now();
    await h.ctx.store.bulkJobs.claimChunk(scope, due.jobId, due.chunkId, {
      now,
      staleBefore: new Date(now.getTime() - 1),
    });

    // Too soon: nothing is stale yet.
    expect(await resumeStalledBulkJobs(h.ctx)).toBe(0);

    // Past the stale window the sweep re-appends a chunk_due; the rerun
    // re-claims (stale claim) and completes.
    h.clock.advance(10 * 60_000);
    expect(await resumeStalledBulkJobs(h.ctx)).toBe(1);
    const renudged = chunkDueEvents(h.store).at(-1) as BulkChunkDueEvent;
    expect((await runBulkChunk(h.ctx, renudged)).outcome).toBe('processed');
    expect((await getBulkJob(h.ctx, scope, job.id)).status).toBe('completed');
  });

  it('dispatching published_bulk bumps the scope epoch (evicting cached renders) and synthesizes per-entry webhooks', async () => {
    const ids = await seedEntries(h.ctx, 2);
    await createWebhook(h.ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });

    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain(); // chunk runs

    // Cache a render, then dispatch the coalesced event: the epoch tag on the
    // envelope must evict it.
    const firstId = ids[0] as string;
    await getPublishedEntry(h.ctx, scope, firstId);
    expect(h.cache.size).toBeGreaterThan(0);

    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain(); // published_bulk + job_completed dispatch

    expect(h.cache.size).toBe(0); // epoch bump evicted the render

    // Webhook got per-entry synthesized events whose ids derive from stable
    // (jobId, chunkId, entryId) coordinates — a chunk re-run mints a fresh
    // event id but the receiver's dedupe key must not change.
    const sent = h.sender.sent.filter((s) => s.event.type === 'entry.published');
    expect(sent).toHaveLength(2);
    const bulkEvent = h.store
      .allEvents()
      .find((e): e is EntriesPublishedBulkEvent => e.type === 'entries.published_bulk');
    for (const s of sent) {
      const entryId = 'entryId' in s.event ? s.event.entryId : '';
      expect(s.event.id).toBe(`${bulkEvent?.jobId}:${bulkEvent?.chunkId}:${entryId}`);
      expect('fields' in s.event && s.event.fields).toBeTruthy();
    }
    expect((await getBulkJob(h.ctx, scope, job.id)).status).toBe('completed');
  });

  it('an unpublish chunk whose entries are already unpublished records no-op successes, not failures', async () => {
    const ids = await seedEntries(h.ctx, 2);
    await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain();

    // The at-least-once shape: by the time the chunk (re-)runs, its entries
    // are already in the target state (here: unpublished out-of-band, which
    // is state-identical to a committed first run whose completeChunk was
    // lost). The chunk must report successes, never corrupt the report.
    const job = await startBulkJob(h.ctx, scope, { action: 'unpublish', entryIds: ids });
    for (const id of ids) await unpublishEntry(h.ctx, scope, id);

    const due = chunkDueEvents(h.store).at(-1) as BulkChunkDueEvent;
    const run = await runBulkChunk(h.ctx, due);
    expect(run).toMatchObject({ outcome: 'processed', succeeded: 2, failed: 0 });
    const report = await getBulkJobReport(h.ctx, scope, job.id);
    expect(report.job.failed).toBe(0);
    expect(report.job.succeeded).toBe(2);
    expect(report.chunks[0]?.failures).toEqual([]);
  });

  it('the sweep finalizes a job stranded between last completeChunk and finalize', async () => {
    const ids = await seedEntries(h.ctx, 2);
    const job = await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    const due = chunkDueEvents(h.store)[0] as BulkChunkDueEvent;

    // Simulate the crash window: claim + run the transaction + completeChunk,
    // but never call finalize (drive the store directly).
    const now = h.clock.now();
    await h.ctx.store.bulkJobs.claimChunk(scope, due.jobId, due.chunkId, {
      now,
      staleBefore: new Date(now.getTime() - 1),
    });
    await h.ctx.store.bulkJobs.completeChunk(scope, due.jobId, due.chunkId, {
      status: 'completed',
      succeeded: 2,
      failed: 0,
      failures: [],
    });
    expect((await getBulkJob(h.ctx, scope, job.id)).status).toBe('running'); // stranded

    const resumed = await resumeStalledBulkJobs(h.ctx);
    expect(resumed).toBeGreaterThan(0);
    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.status).toBe('completed');
    expect(h.store.allEvents().filter((e) => e.type === 'bulk.job_completed')).toHaveLength(1);
  });

  it('unpublish jobs withdraw entries through the same pipeline', async () => {
    const ids = await seedEntries(h.ctx, 2);
    await startBulkJob(h.ctx, scope, { action: 'publish', entryIds: ids });
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain();
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain();

    const job = await startBulkJob(h.ctx, scope, { action: 'unpublish', entryIds: ids });
    await relayOutbox(h.ctx, h.queue);
    await h.queue.drain();

    const done = await getBulkJob(h.ctx, scope, job.id);
    expect(done.succeeded).toBe(2);
    await expect(getPublishedEntry(h.ctx, scope, ids[0] as string)).rejects.toThrow();
  });
});

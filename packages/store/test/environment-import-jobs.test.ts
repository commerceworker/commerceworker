import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  exportSnapshot,
  getBulkJob,
  importChunkRunner,
  publishContentType,
  publishEntry,
  runBulkChunk,
  SYSTEM_CALLER,
  startEnvironmentClone,
  updateEntry,
} from '@commerceworker/application';
import type { BulkChunkDueEvent } from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Environment clone as a job, on D1: the create job's chunks, then the publishing job, which the
 * last create chunk starts inside the unit of work that finalizes its job.
 */
const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `clone-${crypto.randomUUID().slice(0, 8)}`;
const source = { spaceId, environmentId: 'main' };
const target = { spaceId, environmentId: 'copy' };

describe('cloning an environment as a job on D1', () => {
  it('creates every entry, then publishes them with links into later chunks resolved', async () => {
    await createSpace(ctx, { spaceId, name: 'Clone', defaultLocale: 'en-US', locales: ['en-US'] });
    await createEnvironment(ctx, spaceId, 'copy');
    await createContentType(ctx, SYSTEM_CALLER, source, {
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
        {
          apiId: 'next',
          name: 'Next',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, source, 'page');
    const pageIds: string[] = [];
    for (let i = 0; i < 150; i++) {
      const { entry } = await createEntry(ctx, source, {
        contentTypeApiId: 'page',
        fields: { title: { 'en-US': `Page ${i}` } },
      });
      pageIds.push(entry.id);
    }
    for (let i = 0; i + 1 < pageIds.length; i++) {
      await updateEntry(ctx, source, pageIds[i] as string, {
        title: { 'en-US': `Page ${i}` },
        next: { 'en-US': { id: pageIds[i + 1], linkType: 'Entry' } },
      });
    }
    for (const id of pageIds) await publishEntry(ctx, source, id);
    expect((await exportSnapshot(ctx, source)).entries).toHaveLength(150);

    const blob = new FakeBlobStore();
    const started = await startEnvironmentClone(ctx, source, target);
    const ran = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const due = (await store.outbox.readPending(1000)).filter(
        (e): e is BulkChunkDueEvent => 'type' in e && e.type === 'bulk.chunk_due' && !ran.has(e.id),
      );
      if (due.length === 0) break;
      for (const event of due) {
        ran.add(event.id);
        await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob) });
      }
    }

    expect(await getBulkJob(ctx, target, started.job.id)).toMatchObject({
      status: 'completed',
      succeeded: 1,
    });
    expect(await getBulkJob(ctx, target, started.createJobId)).toMatchObject({
      status: 'completed',
      succeeded: 150,
    });
    expect(await getBulkJob(ctx, target, started.publishJobId)).toMatchObject({
      status: 'completed',
      succeeded: 150,
      failed: 0,
    });
    const first = await store.entries.getPublished(target, pageIds[0] as string);
    expect(first?.fields.next).toEqual({ 'en-US': { id: pageIds[1], linkType: 'Entry' } });
    const published = await store.entries.listPublished(target, { limit: 500 });
    expect(published).toHaveLength(150);
  });
});

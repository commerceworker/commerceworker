import {
  type DomainEvent,
  ForbiddenError,
  type Principal,
  rolePresetDefinition,
  SCOPES,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  authorizeBulkJob,
  createContentType,
  createEntry,
  createSpace,
  dispatchEvent,
  ENTRY_TRASH_CHUNK_SIZE,
  entryTrashChunkRunner,
  getBulkJob,
  getBulkJobReport,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  startBulkJob,
  trashEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does (chunks included). */
  const drain = async () => {
    while (store.allEvents().length > dispatched) {
      const events = store.allEvents();
      const batch = events.slice(dispatched);
      dispatched = events.length;
      for (const e of batch) {
        await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, e as DomainEvent);
      }
    }
  };
  return { ctx, store, blob, drain };
}

type Harness = ReturnType<typeof setup>;

async function model(h: Harness, s = scope) {
  await createContentType(h.ctx, SYSTEM_CALLER, s, {
    apiId: 'post',
    name: 'Post',
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
        apiId: 'slug',
        name: 'Slug',
        type: 'Slug',
        localized: false,
        required: false,
        unique: true,
        position: 1,
      },
      {
        apiId: 'related',
        name: 'Related',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 2,
      },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, s, 'post');
}

async function post(h: Harness, title: string, extra: Record<string, unknown> = {}, s = scope) {
  return (
    await createEntry(h.ctx, s, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': title }, ...extra },
    })
  ).entry;
}

const statusOf = async (h: Harness, id: string, s = scope) =>
  (await h.store.entries.get(s, id))?.entry.status;

describe('entry trash bulk jobs', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await model(h);
  });

  it('trashes a selection larger than one chunk, unpublishing what was live', async () => {
    const ids: string[] = [];
    for (let i = 0; i < ENTRY_TRASH_CHUNK_SIZE + 3; i++) ids.push((await post(h, `p${i}`)).id);
    const live = ids[0] ?? '';
    await publishEntry(h.ctx, scope, live);

    const job = await startBulkJob(h.ctx, scope, { action: 'trash', entryIds: ids });
    expect(job).toMatchObject({ action: 'trash', totalChunks: 2, status: 'running' });
    await h.drain();

    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: ids.length,
      failed: 0,
    });
    const after = await h.store.entries.getMany(scope, ids);
    expect(after.every((e) => e.entry.status === 'archived')).toBe(true);
    // As a single trash does: the live entry left Delivery, with its own unpublished event.
    expect(await h.store.entries.getPublished(scope, live)).toBeNull();
    expect(
      h.store.allEvents().some((e) => e.type === 'entry.unpublished' && e.entryId === live),
    ).toBe(true);
  });

  it('restores as drafts, refusing one whose unique value was taken meanwhile', async () => {
    const a = await post(h, 'A', { slug: { 'en-US': 'about' } });
    const b = await post(h, 'B');
    await trashEntry(h.ctx, scope, a.id);
    await trashEntry(h.ctx, scope, b.id);
    const taker = await post(h, 'Taker', { slug: { 'en-US': 'about' } });

    const job = await startBulkJob(h.ctx, scope, { action: 'restore', entryIds: [a.id, b.id] });
    await h.drain();

    expect(await statusOf(h, b.id)).toBe('draft');
    expect(await statusOf(h, a.id)).toBe('archived');
    const report = await getBulkJobReport(h.ctx, scope, job.id);
    expect(report.job).toMatchObject({ succeeded: 1, failed: 1 });
    expect(report.chunks[0]?.failures).toEqual([
      { id: a.id, error: expect.stringContaining(taker.id) },
    ]);
  });

  it('purges only from the trash, and never under a published link', async () => {
    const kept = await post(h, 'Not trashed');
    const linked = await post(h, 'Linked');
    const gone = await post(h, 'Gone');
    const linker = await post(h, 'Linker', {
      related: { 'en-US': { id: linked.id, linkType: 'Entry' } },
    });
    await publishEntry(h.ctx, scope, linked.id);
    await publishEntry(h.ctx, scope, linker.id);
    await trashEntry(h.ctx, scope, linked.id);
    await trashEntry(h.ctx, scope, gone.id);

    const job = await startBulkJob(h.ctx, scope, {
      action: 'purge',
      entryIds: [kept.id, linked.id, gone.id],
    });
    await h.drain();

    expect(await statusOf(h, gone.id)).toBeUndefined();
    expect(await statusOf(h, kept.id)).toBe('draft');
    expect(await statusOf(h, linked.id)).toBe('archived');
    const failures = (await getBulkJobReport(h.ctx, scope, job.id)).chunks[0]?.failures;
    expect(failures).toEqual([
      { id: kept.id, error: expect.stringContaining('trash') },
      { id: linked.id, error: expect.stringContaining('links to this one') },
    ]);
  });

  it('reports nothing new when a chunk runs again', async () => {
    const a = await post(h, 'A');
    const b = await post(h, 'B');
    await trashEntry(h.ctx, scope, b.id);
    const run = entryTrashChunkRunner(h.ctx, { blob: h.blob });
    const chunk = {
      jobId: 'j',
      chunkId: 'c00000',
      entryIds: [a.id, b.id],
      status: 'running' as const,
      attempts: 1,
      failures: [],
    };
    const job = (action: 'trash' | 'restore' | 'purge') => ({
      id: 'j',
      action,
      status: 'running' as const,
      totalItems: 2,
      totalChunks: 1,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // A redelivery after the first run committed: everything is already done, and says so.
    for (const action of ['trash', 'restore', 'trash', 'purge'] as const) {
      expect(await run(scope, job(action), chunk)).toEqual({ succeeded: 2, failures: [] });
      expect(await run(scope, job(action), chunk)).toEqual({ succeeded: 2, failures: [] });
    }
    expect(await statusOf(h, a.id)).toBeUndefined();
    expect(await statusOf(h, b.id)).toBeUndefined();
  });

  it('acts only on entries of its own environment', async () => {
    await h.ctx.store.spaces.createEnvironment('site', 'staging', 'staging');
    await model(h, staging);
    const elsewhere = await post(h, 'Staging', {}, staging);

    const job = await startBulkJob(h.ctx, scope, { action: 'trash', entryIds: [elsewhere.id] });
    await h.drain();

    expect(await statusOf(h, elsewhere.id, staging)).toBe('draft');
    expect((await getBulkJobReport(h.ctx, scope, job.id)).chunks[0]?.failures).toEqual([
      { id: elsewhere.id, error: 'Entry not found' },
    ]);
  });
});

describe('who may start a bulk job', () => {
  const asRole = (grants: Principal['contentGrants']): Principal => ({
    spaceId: 'site',
    kind: 'user',
    scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
    ...(grants ? { contentGrants: grants } : {}),
  });

  it('lets a member with the Administrator preset start every entry job', () => {
    const admin = asRole(rolePresetDefinition('admin').contentGrants);
    for (const action of ['trash', 'restore', 'purge', 'publish', 'unpublish'] as const) {
      expect(() => authorizeBulkJob(admin, action), action).not.toThrow();
    }
  });

  it('refuses a narrower role, and keeps import and asset jobs to roles with no grants', () => {
    const postsOnly = asRole([{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }]);
    for (const action of ['trash', 'restore', 'purge', 'publish'] as const) {
      expect(() => authorizeBulkJob(postsOnly, action), action).toThrow(ForbiddenError);
    }
    const admin = asRole(rolePresetDefinition('admin').contentGrants);
    expect(() => authorizeBulkJob(admin, 'import')).toThrow(ForbiddenError);
    expect(() => authorizeBulkJob(admin, 'asset_move')).toThrow(ForbiddenError);
    expect(() => authorizeBulkJob(asRole(undefined), 'import')).not.toThrow();
  });
});

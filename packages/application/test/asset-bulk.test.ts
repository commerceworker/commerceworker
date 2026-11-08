import { type DomainEvent, NotFoundError, ValidationError } from '@commerceworker/domain';
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
  archiveAsset,
  BULK_JOB_CHUNK_SIZE,
  createAsset,
  createAssetFolder,
  createSpace,
  deleteAssetFolder,
  dispatchEvent,
  getAsset,
  getBulkJob,
  getBulkJobReport,
  publishAsset,
  setAssetMetadata,
  setAssetRights,
  startAssetBulkJob,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
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

async function upload(h: Harness, fileName: string, s = scope) {
  return (await createAsset(h.ctx, h.blob, s, { fileName, contentType: 'image/png' })).asset;
}

describe('asset bulk jobs', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('moves a selection larger than one chunk into a folder', async () => {
    const folder = await createAssetFolder(h.ctx, scope, { name: 'Campaign' });
    const assets = [];
    for (let i = 0; i < BULK_JOB_CHUNK_SIZE + 5; i++) assets.push(await upload(h, `a${i}.png`));
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'move',
      ids: assets.map((a) => a.id),
      folderId: folder.id,
    });
    expect(job).toMatchObject({ action: 'asset_move', totalChunks: 2, status: 'running' });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: BULK_JOB_CHUNK_SIZE + 5,
      failed: 0,
    });
    const moved = await h.store.assets.getMany(
      scope,
      assets.map((a) => a.id),
    );
    expect(moved.every((a) => a.folderId === folder.id)).toBe(true);
  });

  it('refuses a move to a folder that does not exist, and a tag job with no tags', async () => {
    const a = await upload(h, 'a.png');
    await expect(
      startAssetBulkJob(h.ctx, scope, { action: 'move', ids: [a.id], folderId: 'nope' }),
    ).rejects.toThrow(NotFoundError);
    await expect(startAssetBulkJob(h.ctx, scope, { action: 'move', ids: [a.id] })).rejects.toThrow(
      ValidationError,
    );
    await expect(startAssetBulkJob(h.ctx, scope, { action: 'tag', ids: [a.id] })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      startAssetBulkJob(h.ctx, scope, {
        action: 'tag',
        ids: [a.id],
        addTags: ['t1'],
        removeTags: ['t1'],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('fails every asset by name when the folder is deleted before the chunk runs', async () => {
    const folder = await createAssetFolder(h.ctx, scope, { name: 'Gone' });
    const a = await upload(h, 'a.png');
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'move',
      ids: [a.id],
      folderId: folder.id,
    });
    await deleteAssetFolder(h.ctx, scope, folder.id);
    await h.drain();
    const report = await getBulkJobReport(h.ctx, scope, job.id);
    expect(report.chunks[0]?.failures).toEqual([
      { id: a.id, name: 'a.png', error: 'The folder was deleted' },
    ]);
  });

  it('adds and removes tags, keeping what else each asset had', async () => {
    const a = await upload(h, 'a.png');
    const b = await upload(h, 'b.png');
    await setAssetMetadata(h.ctx, scope, a.id, { tags: ['old', 'keep'] });
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'tag',
      ids: [a.id, b.id],
      addTags: ['new'],
      removeTags: ['old'],
    });
    await h.drain();
    expect((await getAsset(h.ctx, scope, a.id)).metadata.tags).toEqual(['keep', 'new']);
    expect((await getAsset(h.ctx, scope, b.id)).metadata.tags).toEqual(['new']);
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 2, failed: 0 });
  });

  it('publishes through the same checks as one at a time, reporting failures by name', async () => {
    const ok = await upload(h, 'ok.png');
    const archived = await upload(h, 'archived.png');
    await archiveAsset(h.ctx, scope, archived.id);
    const embargoed = await upload(h, 'embargoed.png');
    await setAssetRights(h.ctx, scope, embargoed.id, { embargoUntil: '2027-01-01T00:00:00Z' });
    await h.store.assets.save(scope, {
      ...(await getAsset(h.ctx, scope, embargoed.id)),
      title: { 'en-US': 'Launch teaser' },
    });
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'publish',
      ids: [ok.id, archived.id, embargoed.id, 'missing'],
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 1, failed: 3 });
    expect((await getAsset(h.ctx, scope, ok.id)).status).toBe('published');
    const failures = (await getBulkJobReport(h.ctx, scope, job.id)).chunks.flatMap(
      (c) => c.failures,
    );
    expect(failures).toEqual([
      { id: 'missing', error: 'Asset not found' },
      { id: archived.id, name: 'archived.png', error: 'Cannot publish an archived asset' },
      {
        id: embargoed.id,
        name: 'Launch teaser',
        error: expect.stringContaining('under embargo until 2027-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('unpublishes and archives idempotently, so a redelivered chunk changes nothing', async () => {
    const live = await upload(h, 'live.png');
    const draft = await upload(h, 'draft.png');
    await publishAsset(h.ctx, scope, live.id);
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'unpublish',
      ids: [live.id, draft.id],
    });
    const due = h.store.allEvents().filter((e) => e.type === 'bulk.chunk_due');
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 2, failed: 0 });
    expect((await getAsset(h.ctx, scope, live.id)).status).toBe('draft');
    // The chunk's event comes again: the chunk is done, so nothing runs twice.
    const before = h.store.allEvents().length;
    for (const e of due) {
      await dispatchEvent(h.ctx, { sender: new RecordingWebhookSender() }, e as DomainEvent);
    }
    expect(h.store.allEvents().length).toBe(before);

    const archive = await startAssetBulkJob(h.ctx, scope, {
      action: 'archive',
      ids: [live.id, draft.id],
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, archive.id)).toMatchObject({ succeeded: 2 });
    expect((await getAsset(h.ctx, scope, draft.id)).status).toBe('archived');
  });

  it('acts only on assets in its own environment', async () => {
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    await h.store.spaces.createEnvironment('shop', 'staging', 'Staging');
    const elsewhere = await upload(h, 'elsewhere.png', staging);
    const job = await startAssetBulkJob(h.ctx, scope, {
      action: 'archive',
      ids: [elsewhere.id],
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 0, failed: 1 });
    expect((await getAsset(h.ctx, staging, elsewhere.id)).status).toBe('draft');
  });
});

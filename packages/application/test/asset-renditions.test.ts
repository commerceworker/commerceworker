import {
  ConflictError,
  MAX_ASSET_RENDITIONS,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FakeVideoHost,
  FixedClock,
  InMemoryAssetGate,
  InMemoryCache,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveAsset,
  consumeEvent,
  createAsset,
  createAssetRendition,
  createEnvironment,
  createSpace,
  createVideoAsset,
  deleteAsset,
  deleteAssetRendition,
  epochTag,
  getAssetRendition,
  listAssetRenditions,
  publishAsset,
  setAssetMetadata,
  syncAssetGate,
  unpublishAsset,
  updateAssetRendition,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
  return { ctx, store, blob: new FakeBlobStore() };
}

describe('rendition presets', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('are created, read, replaced and deleted, each change with its event in the same unit', async () => {
    const created = await createAssetRendition(h.ctx, scope, {
      name: 'hero',
      width: 1600,
      height: 900,
      fit: 'crop',
      format: 'auto',
    });
    expect(created).toMatchObject({ name: 'hero', width: 1600, height: 900, fit: 'crop' });
    expect(await getAssetRendition(h.ctx, scope, 'hero')).toEqual(created);

    const updated = await updateAssetRendition(h.ctx, scope, 'hero', { width: 1200 });
    // A replacement, not a merge: what it no longer sets is gone.
    expect(updated).toMatchObject({ name: 'hero', width: 1200, createdAt: created.createdAt });
    expect(updated.height).toBeUndefined();

    await deleteAssetRendition(h.ctx, scope, 'hero');
    expect(await listAssetRenditions(h.ctx, scope)).toEqual([]);
    await expect(getAssetRendition(h.ctx, scope, 'hero')).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAssetRendition(h.ctx, scope, 'hero')).rejects.toBeInstanceOf(NotFoundError);

    const events = h.store.allEvents().filter((e) => e.type === 'asset_renditions.changed');
    expect(events.map((e) => (e as { name: string }).name)).toEqual(['hero', 'hero', 'hero']);
  });

  it('refuse a bad name, an empty or out-of-range spec, a taken name and a 21st preset', async () => {
    for (const name of ['Hero', '-x', 'a b', 'x'.repeat(41), '']) {
      await expect(createAssetRendition(h.ctx, scope, { name, width: 10 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    for (const spec of [
      {},
      { width: 0 },
      { width: 5000 },
      { quality: 101 },
      { fit: 'x' as never },
    ]) {
      await expect(
        createAssetRendition(h.ctx, scope, { name: 'bad', ...spec }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await createAssetRendition(h.ctx, scope, { name: 'r0', width: 10 });
    await expect(
      createAssetRendition(h.ctx, scope, { name: 'r0', width: 20 }),
    ).rejects.toBeInstanceOf(ConflictError);
    for (let i = 1; i < MAX_ASSET_RENDITIONS; i++) {
      await createAssetRendition(h.ctx, scope, { name: `r${i}`, width: 10 });
    }
    await expect(
      createAssetRendition(h.ctx, scope, { name: 'one-more', width: 10 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Nothing refused was written, and no event was left for it.
    expect(await listAssetRenditions(h.ctx, scope)).toHaveLength(MAX_ASSET_RENDITIONS);
    expect(h.store.allEvents().filter((e) => e.type === 'asset_renditions.changed')).toHaveLength(
      MAX_ASSET_RENDITIONS,
    );
  });

  it('belong to the space: every environment sees them, another space doesn’t', async () => {
    await createEnvironment(h.ctx, 'shop', 'staging', 'Staging');
    await createAssetRendition(h.ctx, scope, { name: 'thumb', width: 200 });
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    expect((await listAssetRenditions(h.ctx, staging)).map((r) => r.name)).toEqual(['thumb']);
    await createSpace(h.ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
    expect(await listAssetRenditions(h.ctx, { spaceId: 'other', environmentId: 'main' })).toEqual(
      [],
    );
  });

  it('bump every environment’s delivery epoch when one changes', async () => {
    await createEnvironment(h.ctx, 'shop', 'staging', 'Staging');
    const cache = new InMemoryCache();
    const deps = { sender: new RecordingWebhookSender(), cache };
    const key = 'render';
    for (const environmentId of ['main', 'staging']) {
      await cache.set(`${key}:${environmentId}`, 'cached', {
        tags: [epochTag({ spaceId: 'shop', environmentId })],
      });
    }
    await createAssetRendition(h.ctx, scope, { name: 'thumb', width: 200 });
    const event = h.store.allEvents().find((e) => e.type === 'asset_renditions.changed');
    await consumeEvent(h.ctx, deps, event as never);
    expect(await cache.get(`${key}:main`)).toBeNull();
    expect(await cache.get(`${key}:staging`)).toBeNull();
  });
});

describe('the media gate', () => {
  let h: ReturnType<typeof setup>;
  let gate: InMemoryAssetGate;
  beforeEach(async () => {
    h = setup();
    gate = new InMemoryAssetGate();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  /** Runs the outbox's events as the engine does, with the gate bound. */
  async function drain(from = 0) {
    for (const e of h.store.allEvents().slice(from)) {
      await consumeEvent(
        h.ctx,
        { sender: new RecordingWebhookSender(), assetGate: gate },
        e as never,
      );
    }
  }

  async function image() {
    const { asset } = await createAsset(h.ctx, h.blob, scope, {
      fileName: 'hero.jpg',
      contentType: 'image/jpeg',
    });
    await h.store.assets.save(scope, {
      ...asset,
      rights: { license: 'editorial', expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    await setAssetMetadata(h.ctx, scope, asset.id, { focalPoint: { x: 0.1, y: 0.9 } });
    return asset;
  }

  it('holds an entry while the asset is published, and none once it isn’t', async () => {
    const a = await image();
    await publishAsset(h.ctx, scope, a.id);
    await drain();
    expect(await gate.get(scope, a.id)).toEqual({
      v: 1,
      r2Key: a.r2Key,
      contentType: 'image/jpeg',
      fileName: 'hero.jpg',
      focal: { x: 0.1, y: 0.9 },
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    const mark = h.store.allEvents().length;
    await unpublishAsset(h.ctx, scope, a.id);
    await drain(mark);
    expect(await gate.get(scope, a.id)).toBeNull();

    // Archived and deleted assets leave it too.
    await publishAsset(h.ctx, scope, a.id);
    await drain();
    expect(await gate.get(scope, a.id)).not.toBeNull();
    const mark2 = h.store.allEvents().length;
    await archiveAsset(h.ctx, scope, a.id);
    await drain(mark2);
    expect(await gate.get(scope, a.id)).toBeNull();

    const b = await image();
    await publishAsset(h.ctx, scope, b.id);
    await drain();
    const mark3 = h.store.allEvents().length;
    await archiveAsset(h.ctx, scope, b.id);
    await deleteAsset(h.ctx, scope, b.id);
    await drain(mark3);
    expect(await gate.get(scope, b.id)).toBeNull();
  });

  it('follows what is published now, so a redelivered or late event converges', async () => {
    const a = await image();
    await publishAsset(h.ctx, scope, a.id);
    const published = h.store.allEvents().length;
    await unpublishAsset(h.ctx, scope, a.id);
    // Every event, the earlier publish included, arrives after the unpublish committed: the
    // publish event writes nothing it shouldn't, because the snapshot is gone.
    await drain();
    expect(await gate.get(scope, a.id)).toBeNull();
    await drain(published - 1);
    expect(await gate.get(scope, a.id)).toBeNull();
    expect(await syncAssetGate(h.ctx, gate, scope, a.id)).toBe('removed');
  });

  it('never gates a hosted video (it plays from its host), and keeps scopes apart', async () => {
    const video = setup();
    const ctx: AppContext = {
      ...video.ctx,
      video: new FakeVideoHost(),
    };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'c.mp4',
      contentType: 'video/mp4',
    });
    await publishAsset(ctx, scope, asset.id);
    expect(await syncAssetGate(ctx, gate, scope, asset.id)).toBe('removed');

    const a = await image();
    await publishAsset(h.ctx, scope, a.id);
    await drain();
    expect(await gate.get({ spaceId: 'shop', environmentId: 'staging' }, a.id)).toBeNull();
  });
});

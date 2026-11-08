import type { DomainEvent } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABANDONED_UPLOAD_TTL_MS,
  type AppContext,
  createAsset,
  createSpace,
  dispatchEvent,
  getAsset,
  publishAsset,
  sweepAbandonedUploads,
  UPLOAD_NEVER_COMPLETED,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const other = { spaceId: 'blog', environmentId: 'main' };
const HOUR = 60 * 60 * 1000;

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const clock = new FixedClock();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('a') };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does. */
  const drain = async () => {
    const events = store.allEvents();
    for (const e of events.slice(dispatched)) {
      await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, e as DomainEvent);
    }
    dispatched = events.length;
  };
  return { ctx, store, blob, clock, drain };
}

describe('the abandoned upload sweep', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createSpace(h.ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  });

  const create = async (s = scope, fileName = 'hero.png') =>
    (await createAsset(h.ctx, h.blob, s, { fileName, contentType: 'image/png' })).asset;

  it('deletes a draft whose upload never landed a day on, in every space, and nothing younger', async () => {
    const stale = await create();
    const elsewhere = await create(other);
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS - HOUR);
    const young = await create();
    h.clock.advance(2 * HOUR);

    const swept = await sweepAbandonedUploads(h.ctx, h.blob);
    expect(swept).toEqual({ removed: 2, landed: 0, linked: 0, failed: 0 });
    await expect(getAsset(h.ctx, scope, stale.id)).rejects.toThrow(/not found/i);
    await expect(getAsset(h.ctx, other, elsewhere.id)).rejects.toThrow(/not found/i);
    expect(await getAsset(h.ctx, scope, young.id)).toMatchObject({ id: young.id });
    // The bytes go the way every deleted asset's do: through `asset.deleted`, in the engine.
    const deleted = h.store.allEvents().filter((e) => e.type === 'asset.deleted');
    expect(deleted.map((e) => (e as { r2Key?: string }).r2Key).sort()).toEqual(
      [stale.r2Key, elsewhere.r2Key].sort(),
    );
  });

  it('removes whatever landed under the key once the event is handled', async () => {
    const stale = await create();
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);
    await sweepAbandonedUploads(h.ctx, h.blob);
    // A PUT that raced the sweep (the URL is long expired, but the sweep doesn't rely on it).
    await h.blob.put(stale.r2Key as string, 'late', 'image/png');
    await h.drain();
    expect(h.blob.keys()).not.toContain(stale.r2Key);
  });

  it('keeps a draft whose bytes did land, recording their size for ingest', async () => {
    const landed = await create();
    await h.blob.put(landed.r2Key as string, 'PNG-BYTES', 'image/png');
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);

    const swept = await sweepAbandonedUploads(h.ctx, h.blob);
    expect(swept).toEqual({ removed: 0, landed: 1, linked: 0, failed: 0 });
    const kept = await getAsset(h.ctx, scope, landed.id);
    expect(kept.file.size).toBe('PNG-BYTES'.length);
    expect(h.blob.keys()).toContain(landed.r2Key);
    // It left the candidate set: the next sweep doesn't look at it again.
    expect(await sweepAbandonedUploads(h.ctx, h.blob)).toEqual({
      removed: 0,
      landed: 0,
      linked: 0,
      failed: 0,
    });
  });

  it('marks a linked draft as a failed upload instead of breaking the link', async () => {
    const linked = await create();
    await h.store.references.replaceForEntry(scope, 'page-1', [
      { fromEntryId: 'page-1', fromField: 'hero', toId: linked.id, toType: 'Asset' },
    ]);
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);

    expect(await sweepAbandonedUploads(h.ctx, h.blob)).toMatchObject({ linked: 1, removed: 0 });
    const kept = await getAsset(h.ctx, scope, linked.id);
    expect(kept.ingestStatus).toBe('error');
    expect(kept.ingestError).toBe(UPLOAD_NEVER_COMPLETED);
    expect(await sweepAbandonedUploads(h.ctx, h.blob)).toMatchObject({ linked: 0 });
  });

  it('leaves published, ingested and measured assets alone', async () => {
    const ingested = await create();
    await h.store.assets.recordIngest(scope, ingested.id, 1, { status: 'ready' });
    const measured = await create();
    await h.store.assets.recordIngest(scope, measured.id, 1, { size: 10 });
    const published = await create();
    await publishAsset(h.ctx, scope, published.id);
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);
    expect(await sweepAbandonedUploads(h.ctx, h.blob)).toMatchObject({ removed: 0 });
    expect(await getAsset(h.ctx, scope, ingested.id)).toBeTruthy();
    expect(await getAsset(h.ctx, scope, measured.id)).toBeTruthy();
    expect(await getAsset(h.ctx, scope, published.id)).toBeTruthy();
  });

  it('is a no-op twice over, and bounded per sweep', async () => {
    for (let i = 0; i < 5; i++) await create(scope, `f${i}.png`);
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);
    expect((await sweepAbandonedUploads(h.ctx, h.blob, { limit: 3 })).removed).toBe(3);
    expect((await sweepAbandonedUploads(h.ctx, h.blob, { limit: 3 })).removed).toBe(2);
    expect((await sweepAbandonedUploads(h.ctx, h.blob, { limit: 3 })).removed).toBe(0);
  });

  it('sweeps nothing on a blob store that cannot tell whether an object exists', async () => {
    await create();
    h.clock.advance(ABANDONED_UPLOAD_TTL_MS + HOUR);
    const blind = Object.assign(new FakeBlobStore(), { head: undefined });
    expect(await sweepAbandonedUploads(h.ctx, blind)).toMatchObject({ removed: 0 });
    expect(h.store.allEvents().some((e) => e.type === 'asset.deleted')).toBe(false);
  });
});

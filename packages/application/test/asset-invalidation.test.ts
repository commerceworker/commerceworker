import type { DomainEvent } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  dispatchEvent,
  getPublishedEntry,
  listPublishedEntries,
  publishAsset,
  publishEntry,
  SYSTEM_CALLER,
  unpublishAsset,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

/**
 * Delivery renders EMBED a published asset into every entry that links it, and
 * leave an unresolved link as a `{ id, linkType }` stub. Publishing or
 * unpublishing an asset therefore CHANGES those renders — but assets emitted no
 * domain events, so nothing invalidated them and the stale embed (or stale
 * stub) survived until the cache TTL.
 *
 * Note the reachable surface: no use-case updates a published asset's
 * title/description, so the transitions below are exactly the ways an asset
 * can change what an entry renders.
 */
function setup() {
  const store = new InMemoryContentStore();
  const cache = new InMemoryCache();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    cache,
  };
  const sender = new RecordingWebhookSender();
  let dispatched = 0;
  const drain = async () => {
    const events = store.allEvents();
    for (const e of events.slice(dispatched)) {
      await dispatchEvent(ctx, { sender, cache }, e as DomainEvent);
    }
    dispatched = events.length;
  };
  return { ctx, store, cache, blob: new FakeBlobStore(), drain, sender };
}

async function seedEntryWithAsset(h: ReturnType<typeof setup>) {
  const { ctx, blob } = h;
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
      {
        apiId: 'hero',
        name: 'Hero',
        type: 'Link',
        localized: false,
        required: false,
        position: 1,
        linkType: 'Asset',
      },
    ],
  });
  const asset = await createAsset(ctx, blob, scope, {
    fileName: 'hero.png',
    contentType: 'image/png',
    title: { 'en-US': 'Original' },
  });
  await publishAsset(ctx, scope, asset.asset.id);
  const entry = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: {
      title: { 'en-US': 'Home' },
      hero: { 'en-US': { id: asset.asset.id, linkType: 'Asset' } },
    },
  });
  await publishEntry(ctx, scope, entry.entry.id);
  await h.drain();
  return { assetId: asset.asset.id, entryId: entry.entry.id };
}

// The renders ask for en-US, so the embedded asset's title is flattened to that locale.
const heroTitle = (e: { fields: Record<string, unknown> }) =>
  (e.fields.hero as { title?: string } | undefined)?.title;

describe('asset cache invalidation', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('emits asset.published / asset.unpublished to the outbox', async () => {
    const { assetId } = await seedEntryWithAsset(h);
    await unpublishAsset(h.ctx, scope, assetId);
    const types = h.store.allEvents().map((e) => e.type);
    expect(types).toContain('asset.published');
    expect(types).toContain('asset.unpublished');
  });

  it('refreshes a cached ENTRY render when a linked asset becomes published', async () => {
    const { assetId, entryId } = await seedEntryWithAsset(h);
    const opts = { locale: 'en-US', include: 1 };

    // Start from the unpublished state so the render is a stub, and cache it.
    await unpublishAsset(h.ctx, scope, assetId);
    await h.drain();
    expect((await getPublishedEntry(h.ctx, scope, entryId, opts)).fields.hero).toEqual({
      id: assetId,
      linkType: 'Asset',
    });

    // Publishing the asset changes what the ENTRY renders, though the entry
    // itself never changed — only the asset event can evict it.
    await publishAsset(h.ctx, scope, assetId);
    await h.drain();
    expect(heroTitle(await getPublishedEntry(h.ctx, scope, entryId, opts))).toBe('Original');
  });

  it('refreshes a cached LIST render when a linked asset becomes published', async () => {
    const { assetId } = await seedEntryWithAsset(h);
    const q = { contentTypeApiId: 'page' };
    const opts = { locale: 'en-US', include: 1 };

    await unpublishAsset(h.ctx, scope, assetId);
    await h.drain();
    const stubbed = await listPublishedEntries(h.ctx, scope, q, opts);
    expect(stubbed[0]?.fields.hero).toEqual({ id: assetId, linkType: 'Asset' });

    await publishAsset(h.ctx, scope, assetId);
    await h.drain();
    const embedded = await listPublishedEntries(h.ctx, scope, q, opts);
    expect(heroTitle(embedded[0] as { fields: Record<string, unknown> })).toBe('Original');
  });

  it('reverts the embed to a stub when the asset is unpublished', async () => {
    const { assetId, entryId } = await seedEntryWithAsset(h);
    const opts = { locale: 'en-US', include: 1 };
    expect(heroTitle(await getPublishedEntry(h.ctx, scope, entryId, opts))).toBe('Original');

    await unpublishAsset(h.ctx, scope, assetId);
    await h.drain();

    const after = await getPublishedEntry(h.ctx, scope, entryId, opts);
    // Unpublished target renders as the unresolved link stub.
    expect(after.fields.hero).toEqual({ id: assetId, linkType: 'Asset' });
  });

  it('reverts a cached LIST embed to a stub when the asset is unpublished', async () => {
    const { assetId } = await seedEntryWithAsset(h);
    const q = { contentTypeApiId: 'page' };
    const opts = { locale: 'en-US', include: 1 };
    expect(heroTitle((await listPublishedEntries(h.ctx, scope, q, opts))[0] as never)).toBe(
      'Original',
    );

    await unpublishAsset(h.ctx, scope, assetId);
    await h.drain();
    const after = await listPublishedEntries(h.ctx, scope, q, opts);
    expect(after[0]?.fields.hero).toEqual({ id: assetId, linkType: 'Asset' });
  });

  it('rolls back the outbox event when the asset write fails', async () => {
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const before = h.store.allEvents().length;
    // Publishing a nonexistent asset must not leave an orphaned event.
    await expect(publishAsset(h.ctx, scope, 'no-such-asset')).rejects.toThrow();
    expect(h.store.allEvents()).toHaveLength(before);
  });
});

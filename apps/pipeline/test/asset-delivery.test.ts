import { env } from 'cloudflare:workers';
import { assetGateKey, createKvAssetGate } from '@commerceworker/adapters/asset-gate-kv';
import {
  type AppContext,
  addToAssetCollection,
  archiveAsset,
  commitAssetFile,
  consumeEvent,
  createAsset,
  createAssetCollection,
  createAssetRendition,
  createAssetShareLink,
  createEnvironment,
  createSpace,
  createVideoAsset,
  deleteAsset,
  deleteEnvironment,
  finishIngest,
  publishAsset,
  refreshVideoAsset,
  replaceAssetFile,
  revokeAssetShareLink,
  runDueAssetExpiries,
  setAssetRights,
  unpublishAsset,
} from '@commerceworker/application';
import type { DomainEvent, Principal } from '@commerceworker/domain';
import {
  mediaCollectionTag,
  mediaShareLinkTag,
  type PurgeMessage,
} from '@commerceworker/platform/messages';
import { createD1Store } from '@commerceworker/store';
import { FakeBlobStore, FakeVideoHost, RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_TAGS_PER_MESSAGE,
  newPurgePlan,
  type PurgeQueues,
  planPurges,
  REVOCATION_REPURGE_SECONDS,
  sendPurges,
} from '../src/purges';

/**
 * What the events consumer does for published assets, on D1 and KV: it keeps the media origin's
 * gate in line with what is published, and asks both edge caches (delivery's and media's) to drop
 * what went stale, a revoked asset's media twice.
 */
const store = createD1Store(env.DB);
let seq = 0;
async function space(extra: Partial<AppContext> = {}) {
  const ctx: AppContext = {
    store,
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
    ...extra,
  };
  const spaceId = `engine-assets-${++seq}`;
  await createSpace(ctx, { spaceId, name: 'Assets', defaultLocale: 'en-US' });
  return { ctx, scope: { spaceId, environmentId: 'main' } };
}

const gate = createKvAssetGate(env.KV_CACHE);

/** Fake producers that record what was sent, as the queue bindings would carry it. */
function queues() {
  const sent: { queue: string; body: PurgeMessage; delaySeconds?: number }[] = [];
  const producer = (queue: string) => ({
    async send(body: unknown, opts?: { delaySeconds?: number }) {
      sent.push({
        queue,
        body: body as PurgeMessage,
        ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}),
      });
    },
  });
  const q: PurgeQueues = {
    PURGE_QUEUE: producer('purge') as never,
    MEDIA_PURGE_QUEUE: producer('media-purge') as never,
  };
  return { q, sent };
}

/** Consumes the scope's new outbox events as the engine does: effects, then one plan per batch. */
async function consume(ctx: AppContext, events: DomainEvent[]) {
  const plan = newPurgePlan();
  for (const e of events) {
    await consumeEvent(ctx, { sender: new RecordingWebhookSender(), assetGate: gate }, e);
    await planPurges(ctx, plan, e);
  }
  return plan;
}

async function eventsSince(scope: { spaceId: string }, since: number) {
  const rows = await env.DB.prepare(
    "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? and rowid > ? order by rowid",
  )
    .bind(scope.spaceId, since)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as DomainEvent);
}

async function lastRowid(): Promise<number> {
  const row = await env.DB.prepare('select ifnull(max(rowid), 0) as n from outbox').first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe('asset events in the engine', () => {
  it('write the gate on publish and remove it on unpublish, purging both caches', async () => {
    const { ctx, scope } = await space();
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    let mark = await lastRowid();
    await publishAsset(ctx, scope, asset.id);
    const published = await consume(ctx, await eventsSince(scope, mark));
    const raw = await env.KV_CACHE.get(assetGateKey(scope, asset.id));
    expect(JSON.parse(raw as string)).toEqual({
      v: 1,
      r2Key: asset.r2Key,
      contentType: 'image/png',
      fileName: 'a.png',
    });
    const { q, sent } = queues();
    await sendPurges(q, published, () => {});
    expect(sent).toEqual([
      { queue: 'purge', body: { tags: [`cw:${scope.spaceId}:main`] } },
      { queue: 'media-purge', body: { tags: [`cwa:${scope.spaceId}:main:${asset.id}`] } },
    ]);

    mark = await lastRowid();
    await unpublishAsset(ctx, scope, asset.id);
    const events = await eventsSince(scope, mark);
    const revoked = await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
    const second = queues();
    await sendPurges(second.q, revoked, () => {});
    const tag = `cwa:${scope.spaceId}:main:${asset.id}`;
    // Now, and again once every colo's cached gate read has lapsed.
    expect(second.sent.filter((s) => s.queue === 'media-purge')).toEqual([
      { queue: 'media-purge', body: { tags: [tag] } },
      { queue: 'media-purge', body: { tags: [tag] }, delaySeconds: REVOCATION_REPURGE_SECONDS },
    ]);

    // Redelivered: the gate stays removed, and nothing throws.
    await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
  });

  it('purge delivery for a published asset’s ingest, and nothing for a draft’s', async () => {
    const { ctx, scope } = await space();
    const blob = new FakeBlobStore();
    const { asset: draft } = await createAsset(ctx, blob, scope, {
      fileName: 'draft.png',
      contentType: 'image/png',
    });
    const { asset: live } = await createAsset(ctx, blob, scope, {
      fileName: 'live.png',
      contentType: 'image/png',
    });
    await publishAsset(ctx, scope, live.id);
    const mark = await lastRowid();
    const hashed = { contentHash: 'a'.repeat(64), size: 3 };
    await finishIngest(ctx, { scope, assetId: draft.id, version: 1 }, hashed);
    const draftEvents = await eventsSince(scope, mark);
    expect(draftEvents).toEqual([
      expect.objectContaining({ type: 'asset.ingested', assetId: draft.id, published: false }),
    ]);
    expect([...(await consume(ctx, draftEvents)).delivery]).toEqual([]);

    const next = await lastRowid();
    await finishIngest(ctx, { scope, assetId: live.id, version: 1 }, hashed);
    const liveEvents = await eventsSince(scope, next);
    expect(liveEvents).toEqual([
      expect.objectContaining({ type: 'asset.ingested', assetId: live.id, published: true }),
    ]);
    expect([...(await consume(ctx, liveEvents)).delivery]).toEqual([`cw:${scope.spaceId}:main`]);
  });

  it('purge every environment’s delivery and the preset’s media when a rendition changes', async () => {
    const { ctx, scope } = await space();
    await createEnvironment(ctx, scope.spaceId, 'staging', 'Staging');
    const mark = await lastRowid();
    await createAssetRendition(ctx, scope, { name: 'thumb', width: 200 });
    const plan = await consume(ctx, await eventsSince(scope, mark));
    expect([...plan.delivery].sort()).toEqual([
      `cw:${scope.spaceId}:main`,
      `cw:${scope.spaceId}:staging`,
    ]);
    expect([...plan.revoked]).toEqual([`cwr:${scope.spaceId}:thumb`]);
  });

  it('clear a deleted environment’s gate and purge its media now and once more later', async () => {
    const { ctx, scope } = await space();
    await createEnvironment(ctx, scope.spaceId, 'feature', 'Feature');
    const feature = { spaceId: scope.spaceId, environmentId: 'feature' };
    const { asset } = await createAsset(ctx, new FakeBlobStore(), feature, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    let mark = await lastRowid();
    await publishAsset(ctx, feature, asset.id);
    await consume(ctx, await eventsSince(scope, mark));
    expect(await env.KV_CACHE.get(assetGateKey(feature, asset.id))).not.toBeNull();

    mark = await lastRowid();
    const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
    await deleteEnvironment(ctx, scope.spaceId, 'feature', {
      confirm: 'feature',
      principal: admin,
    });
    // The deletion's events, then each purge step's hand-on, as the queue would bring them.
    const plan = newPurgePlan();
    const seen: string[] = [];
    for (let events = await eventsSince(scope, mark); events.length > 0; ) {
      mark = await lastRowid();
      for (const e of events) {
        seen.push(e.type);
        await consumeEvent(ctx, { sender: new RecordingWebhookSender(), assetGate: gate }, e);
        await planPurges(ctx, plan, e);
      }
      events = await eventsSince(scope, mark);
    }
    expect(seen).toContain('environment.deleted');
    expect(seen).toContain('environment.purge_due');
    expect(await env.KV_CACHE.get(assetGateKey(feature, asset.id))).toBeNull();

    const { q, sent } = queues();
    await sendPurges(q, plan, () => {});
    const tag = `cwe:${scope.spaceId}:feature`;
    const media = sent.filter((m) => m.queue === 'media-purge' && m.body.tags.includes(tag));
    expect(media.map((m) => m.delaySeconds)).toEqual([undefined, REVOCATION_REPURGE_SECONDS]);
  });

  it('send nothing to a queue that isn’t bound, and survive a failed send', async () => {
    const plan = newPurgePlan();
    plan.delivery.add('cw:s:e');
    plan.revoked.add('cwa:s:e:a');
    await sendPurges({}, plan, () => {});
    const failures: string[] = [];
    await sendPurges(
      {
        PURGE_QUEUE: { send: async () => Promise.reject(new Error('down')) } as never,
        MEDIA_PURGE_QUEUE: { send: async () => Promise.reject(new Error('down')) } as never,
      },
      plan,
      (what) => failures.push(what),
    );
    expect(failures.sort()).toEqual(['delivery purge', 'media purge', 'media re-purge']);
  });

  it('update a published video’s snapshot when Stream finishes, on D1', async () => {
    const host = new FakeVideoHost();
    const { ctx, scope } = await space({ video: host });
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'c.mp4',
      contentType: 'video/mp4',
    });
    await publishAsset(ctx, scope, asset.id);
    host.setVideo(asset.file.video?.videoId as string, {
      status: 'ready',
      hlsUrl: 'https://s/v.m3u8',
    });
    const mark = await lastRowid();
    await refreshVideoAsset(ctx, scope, asset.id);
    const snapshot = await store.assets.getPublished(scope, asset.id);
    expect(snapshot?.file.video).toMatchObject({ status: 'ready', hlsUrl: 'https://s/v.m3u8' });
    const events = await eventsSince(scope, mark);
    expect(events.map((e) => e.type)).toEqual(['asset.published']);
    // A hosted video is never gated: it plays from its host.
    await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
  });
});

describe('asset versions and rights in the engine', () => {
  it('purge an old version’s media as a revocation once a republish replaces it', async () => {
    const { ctx, scope } = await space();
    const blob = new FakeBlobStore();
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    await publishAsset(ctx, scope, asset.id);
    await consume(ctx, await eventsSince(scope, 0));
    const r = await replaceAssetFile(ctx, blob, scope, asset.id, {
      fileName: 'b.png',
      contentType: 'image/png',
    });
    const key = `${scope.spaceId}/main/${asset.id}/v2/file-${r.commit.attempt}/b.png`;
    await blob.put(key, 'b', 'image/png');
    let mark = await lastRowid();
    await commitAssetFile(ctx, blob, scope, asset.id, r.commit);
    // The draft's new file changes nothing delivered: no purge, and the gate keeps v1.
    const replaced = await consume(ctx, await eventsSince(scope, mark));
    expect([...replaced.media, ...replaced.revoked, ...replaced.delivery]).toEqual([]);
    expect(
      JSON.parse((await env.KV_CACHE.get(assetGateKey(scope, asset.id))) as string),
    ).toMatchObject({ v: 1, r2Key: asset.r2Key });

    mark = await lastRowid();
    await publishAsset(ctx, scope, asset.id);
    const plan = await consume(ctx, await eventsSince(scope, mark));
    expect(
      JSON.parse((await env.KV_CACHE.get(assetGateKey(scope, asset.id))) as string),
    ).toMatchObject({ v: 2, r2Key: key, fileName: 'b.png' });
    const { q, sent } = queues();
    await sendPurges(q, plan, () => {});
    const tag = `cwa:${scope.spaceId}:main:${asset.id}`;
    expect(sent.filter((s) => s.queue === 'media-purge')).toEqual([
      { queue: 'media-purge', body: { tags: [tag] } },
      { queue: 'media-purge', body: { tags: [tag] }, delaySeconds: REVOCATION_REPURGE_SECONDS },
    ]);
  });

  it('carry a rights change into the gate and purge both caches', async () => {
    const { ctx, scope } = await space();
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    await publishAsset(ctx, scope, asset.id);
    const mark = await lastRowid();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await setAssetRights(ctx, scope, asset.id, { credit: 'Ana', expiresAt });
    const plan = await consume(ctx, await eventsSince(scope, mark));
    expect(
      JSON.parse((await env.KV_CACHE.get(assetGateKey(scope, asset.id))) as string),
    ).toMatchObject({ expiresAt });
    expect([...plan.delivery]).toEqual([`cw:${scope.spaceId}:main`]);
    expect([...plan.revoked]).toEqual([`cwa:${scope.spaceId}:main:${asset.id}`]);
  });

  it('take an expired asset out: the sweep unpublishes it, the gate goes, media is revoked', async () => {
    let now = Date.now();
    const { ctx, scope } = await space({ clock: { now: () => new Date(now) } });
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    await setAssetRights(ctx, scope, asset.id, { expiresAt: new Date(now + 60_000).toISOString() });
    await publishAsset(ctx, scope, asset.id);
    await consume(ctx, await eventsSince(scope, 0));
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).not.toBeNull();

    now += 60_000;
    const mark = await lastRowid();
    const swept = await runDueAssetExpiries(ctx, { limit: 1000 });
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const events = await eventsSince(scope, mark);
    expect(events.map((e) => e.type)).toEqual(['asset.unpublished', 'asset.expired']);
    const plan = await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
    expect([...plan.revoked]).toEqual([`cwa:${scope.spaceId}:main:${asset.id}`]);
    expect([...plan.delivery]).toEqual([`cw:${scope.spaceId}:main`]);
    // A redelivered pair converges on the same state.
    await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
  });
});

describe('collections and share links in the engine', () => {
  it('purge a collection’s share pages and Delivery when it or a member changes', async () => {
    const { ctx, scope } = await space();
    const blob = new FakeBlobStore();
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    const since = await lastRowid();
    const c = await createAssetCollection(ctx, scope, { name: 'Kit' });
    await addToAssetCollection(ctx, scope, c.id, [asset.id]);
    await publishAsset(ctx, scope, asset.id);
    const plan = await consume(ctx, await eventsSince(scope, since));
    const { spaceId, environmentId } = scope;
    expect(plan.delivery).toContain(`cw:${spaceId}:${environmentId}`);
    // The member's publish reaches the collection's pages through the asset's memberships.
    expect(plan.media).toContain(mediaCollectionTag(spaceId, environmentId, c.id));

    // A deleted member: its delete announces the collection (the membership is gone by now).
    const before = await lastRowid();
    await unpublishAsset(ctx, scope, asset.id);
    await archiveAsset(ctx, scope, asset.id);
    await deleteAsset(ctx, scope, asset.id);
    const after = await consume(ctx, await eventsSince(scope, before));
    // Leaving Delivery (or the collection) is purged as a revocation: now and once more later.
    expect(after.revoked).toContain(mediaCollectionTag(spaceId, environmentId, c.id));
  });

  it('purge a revoked link’s page twice, and split a large purge into bounded messages', async () => {
    const { ctx, scope } = await space();
    const c = await createAssetCollection(ctx, scope, { name: 'Kit' });
    const link = await createAssetShareLink(ctx, scope, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const before = await lastRowid();
    await revokeAssetShareLink(ctx, scope, link.id);
    const plan = newPurgePlan();
    for (const e of await eventsSince(scope, before)) await planPurges(ctx, plan, e);
    const tag = mediaShareLinkTag(scope.spaceId, scope.environmentId, link.id);
    expect(plan.revoked).toContain(tag);
    const { q, sent } = queues();
    await sendPurges(q, plan, () => {});
    expect(sent.filter((m) => m.body.tags.includes(tag)).map((m) => m.delaySeconds)).toEqual([
      undefined,
      REVOCATION_REPURGE_SECONDS,
    ]);
  });

  it('send a batch touching many collections in bounded messages, revocations first', async () => {
    const plan = newPurgePlan();
    for (let i = 0; i < 250; i++) plan.media.add(`cwc:s:e:${i}`);
    plan.revoked.add('cwa:s:e:gone');
    const { q, sent } = queues();
    await sendPurges(q, plan, () => {});
    const now = sent.filter((m) => m.queue === 'media-purge' && !m.delaySeconds);
    expect(now.map((m) => m.body.tags.length)).toEqual([MEDIA_TAGS_PER_MESSAGE, 100, 51]);
    expect(now[0]?.body.tags[0]).toBe('cwa:s:e:gone');
    expect(sent.filter((m) => m.delaySeconds).map((m) => m.body.tags)).toEqual([['cwa:s:e:gone']]);
  });
});

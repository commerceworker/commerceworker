import { env, introspectWorkflowInstance } from 'cloudflare:test';
import {
  type AppContext,
  type AssetIngestDeps,
  assetIngestInstanceId,
  assetTextKey,
  createAsset,
  createSpace,
  createTag,
  startAssetIngestForObject,
} from '@commerceworker/application';
import { CloudflareAssetIngestStarter } from '@commerceworker/platform/asset-ingest';
import { createShardedSearchIndex } from '@commerceworker/platform/do/search-shard';
import {
  FakeBlobStore,
  FakeImageProbe,
  FakeTextExtractor,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { assetIngestTestState } from './fixtures/asset-ingest';

// The real Workflows engine (miniflare) running AssetIngestWorkflowBase over fakes for the bytes,
// the Images binding, extraction and the model, with the real SearchShard objects as the asset
// corpus. Started the way the engine's asset-events consumer starts it.

let seq = 0;

describe('AssetIngestWorkflow on Cloudflare Workflows', () => {
  let ctx: AppContext;
  let deps: AssetIngestDeps & { blob: FakeBlobStore };
  let scope: { spaceId: string; environmentId: string };
  let images: FakeImageProbe;
  let extractor: FakeTextExtractor;
  let vectors: InMemoryVectorStore;
  const starter = () => new CloudflareAssetIngestStarter(env.ASSET_INGEST_WF);
  const index = () => createShardedSearchIndex(env.SEARCH, 2, 'assets');

  beforeEach(async () => {
    seq += 1;
    // Unique per test: instance ids and shard names live as long as the test worker.
    scope = { spaceId: `ingest${seq}`, environmentId: 'main' };
    ctx = {
      store: new InMemoryContentStore(),
      clock: { now: () => new Date() },
      ids: new SequenceIdGenerator(`asset${seq}`),
    };
    images = new FakeImageProbe();
    extractor = new FakeTextExtractor();
    vectors = new InMemoryVectorStore();
    deps = {
      blob: new FakeBlobStore(),
      images,
      extractor,
      ai: new StubAIProvider(() => ({ altText: 'A red bicycle against a brick wall' })),
      search: { embeddings: new LocalEmbeddingsProvider(64), vectors, index: index() },
    };
    assetIngestTestState.ctx = ctx;
    assetIngestTestState.deps = deps;
    await createSpace(ctx, { spaceId: scope.spaceId, name: 'Ingest', defaultLocale: 'en-US' });
  });

  async function upload(fileName: string, contentType: string, bytes: string) {
    const { asset } = await createAsset(ctx, deps.blob, scope, { fileName, contentType });
    const key = asset.r2Key as string;
    await deps.blob.put(key, bytes, contentType);
    return { asset, key, instanceId: assetIngestInstanceId(scope, asset.id, 1) };
  }

  it('ingests an uploaded image end to end, and a redelivered notification starts nothing', async () => {
    await createTag(ctx, scope, { name: 'bicycle' });
    const { asset, key, instanceId } = await upload('bike.png', 'image/png', 'png-bytes');
    images.set('png-bytes', { width: 1600, height: 900, format: 'image/png' });

    await using instance = await introspectWorkflowInstance(env.ASSET_INGEST_WF, instanceId);
    expect(await startAssetIngestForObject(ctx, starter(), key)).toBe('started');
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ outcome: 'ready', altText: 'suggested' });

    const after = await ctx.store.assets.get(scope, asset.id);
    expect(after).toMatchObject({
      ingestStatus: 'ready',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      file: { width: 1600, height: 900, size: 9 },
      metadata: { altText: { 'en-US': 'A red bicycle against a brick wall' } },
      aiSuggestions: { altText: ['en-US'] },
    });
    const hits = await index().search(scope, 'bicycle brick', { topK: 5 });
    expect(hits.map((h) => h.entryId)).toEqual([asset.id]);
    expect(vectors.assetRows.size).toBe(1);

    // R2's notification arriving after the upload path started the run: the same id, no run,
    // and the finished asset stays ready (Workflows reports the id as taken, code 10405).
    expect(await startAssetIngestForObject(ctx, starter(), key)).toBe('started');
    expect((await ctx.store.assets.get(scope, asset.id))?.ingestStatus).toBe('ready');
    expect(await starter().start(instanceId, { scope, assetId: asset.id, version: 1 })).toBe(false);
    const ingested = (ctx.store as InMemoryContentStore)
      .allEvents()
      .filter((e) => e.type === 'asset.ingested');
    expect(ingested).toHaveLength(1);
    expect(images.calls).toBe(1);
  });

  it('extracts a PDF’s text into blob storage beside the file and indexes it', async () => {
    const { asset, key, instanceId } = await upload('report.pdf', 'application/pdf', '%PDF');
    extractor.setText('report.pdf', '# Quarterly report\n\nHeliotrope revenue grew.');

    await using instance = await introspectWorkflowInstance(env.ASSET_INGEST_WF, instanceId);
    await startAssetIngestForObject(ctx, starter(), key);
    await instance.waitForStatus('complete');

    const textKey = assetTextKey(scope, asset.id, 1) as string;
    expect(textKey).toBe(`${scope.spaceId}/main/${asset.id}/v1/text.md`);
    expect(await deps.blob.get(textKey)).toContain('Heliotrope revenue');
    const hits = await index().search(scope, 'heliotrope', { topK: 5 });
    expect(hits.map((h) => h.entryId)).toEqual([asset.id]);
    // Extracted text is not an asset file: its own object-create notification is ignored.
    expect(await startAssetIngestForObject(ctx, starter(), textKey)).toBe('ignored');
  });
});

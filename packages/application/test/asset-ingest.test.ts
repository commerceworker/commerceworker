import type { DomainEvent, Principal } from '@commerceworker/domain';
import type { AIProvider, GenerateRequest, GenerateResult } from '@commerceworker/ports';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FakeImageProbe,
  FakeTextExtractor,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  InMemoryCostGuard,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingAssetIngestStarter,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type AssetIngestDeps,
  archiveAsset,
  assetIngestInstanceId,
  assetReindexChunkRunner,
  assetTextKey,
  beginIngest,
  createAsset,
  createEnvironment,
  createSpace,
  createTag,
  deleteAsset,
  deleteEnvironment,
  dispatchEvent,
  exportSnapshot,
  finishIngest,
  getAsset,
  getPublishedAsset,
  hashAsset,
  importSnapshot,
  ingestErrorMessage,
  MAX_EXTRACT_DOCUMENT_BYTES,
  MAX_HASH_BYTES,
  MAX_PLACEHOLDER_BYTES,
  MAX_PROBE_BYTES,
  publishAsset,
  reingestAsset,
  runAssetIngest,
  searchAssets,
  setAssetMetadata,
  startAssetIngestForObject,
  startAssetReindex,
  startRequestedAssetIngest,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const ADMIN = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;

/** A model whose answer a test can change mid-run (`respondWith`), recording every request. */
class ScriptedAI implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  constructor(public respondWith: (req: GenerateRequest) => Promise<unknown>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const object = await this.respondWith(req);
    return { text: JSON.stringify(object), object, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function setup(opts: { aiAnswer?: unknown } = {}) {
  const store = new InMemoryContentStore();
  const clock = new FixedClock();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('a') };
  const blob = new FakeBlobStore();
  const images = new FakeImageProbe();
  const extractor = new FakeTextExtractor();
  const ai = new ScriptedAI(
    async () => opts.aiAnswer ?? { altText: 'A ceramic mug on a wooden table' },
  );
  const vectors = new InMemoryVectorStore();
  const index = new InMemorySearchIndex();
  const deps: AssetIngestDeps & { blob: FakeBlobStore } = {
    blob,
    images,
    extractor,
    ai,
    search: { embeddings: new LocalEmbeddingsProvider(64), vectors, index },
  };
  /** Uploads a file: the asset row, then its bytes, as the signed PUT leaves them. */
  const upload = async (fileName: string, contentType: string, bytes: string, at = scope) => {
    const { asset } = await createAsset(ctx, blob, at, { fileName, contentType });
    await blob.put(asset.r2Key as string, bytes, contentType);
    return asset;
  };
  const params = (assetId: string, version = 1, at = scope) => ({ scope: at, assetId, version });
  const run = (assetId: string, steps = new FakeWorkflowSteps(clock)) =>
    steps.run(() => runAssetIngest(steps, ctx, deps, params(assetId)));
  return { store, clock, ctx, blob, images, extractor, ai, vectors, index, deps, upload, run };
}

const ingested = (store: InMemoryContentStore) =>
  store
    .allEvents()
    .filter(
      (e): e is Extract<DomainEvent, { type: 'asset.ingested' }> => e.type === 'asset.ingested',
    );

describe('asset ingest', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('hashes, probes, suggests alt text, indexes, and finishes ready with asset.ingested', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    t.images.set('jpeg-bytes', { width: 1200, height: 800, format: 'image/jpeg' });
    const out = await t.run(asset.id);
    expect(out).toMatchObject({
      status: 'complete',
      value: { outcome: 'ready', altText: 'suggested' },
    });

    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.file).toMatchObject({ width: 1200, height: 800, size: 10 });
    expect(after.metadata.altText).toEqual({ 'en-US': 'A ceramic mug on a wooden table' });
    expect(after.aiSuggestions).toEqual({ altText: ['en-US'] });
    expect(t.vectors.assetRows.size).toBe(1);
    expect(t.index.textOf(scope, asset.id)).toContain('ceramic mug');
    expect(ingested(t.store)).toEqual([
      expect.objectContaining({ assetId: asset.id, version: 1, contentHash: after.contentHash }),
    ]);
  });

  it('replays a redelivered run from its journal: no step runs twice, one event', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    t.images.set('jpeg-bytes', { width: 10, height: 10, format: 'image/jpeg' });
    const steps = new FakeWorkflowSteps(t.clock);
    await t.run(asset.id, steps);
    const executed = [...steps.executed];
    await t.run(asset.id, steps);
    expect(steps.executed).toEqual(executed);
    expect(t.ai.requests).toHaveLength(1);
    expect(ingested(t.store)).toHaveLength(1);
  });

  it('a fresh run over an ingested file changes nothing an editor or a previous run set', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await t.run(asset.id);
    const first = await getAsset(t.ctx, scope, asset.id);
    await t.run(asset.id);
    const second = await getAsset(t.ctx, scope, asset.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.metadata).toEqual(first.metadata);
    // Alt text was already there: the model is not asked again.
    expect(t.ai.requests).toHaveLength(1);
  });

  it('never overwrites alt text or tags an editor set, and asks no model for them', async () => {
    await createTag(t.ctx, scope, { name: 'kitchen' });
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await setAssetMetadata(t.ctx, scope, asset.id, {
      altText: { 'en-US': 'Editor wrote this' },
      tags: ['editor-tag'],
    });
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { altText: 'kept', tags: 'kept' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.metadata.altText).toEqual({ 'en-US': 'Editor wrote this' });
    expect(after.metadata.tags).toEqual(['editor-tag']);
    expect(after.aiSuggestions).toBeUndefined();
    expect(t.ai.requests).toHaveLength(0);
  });

  it('keeps an editor value saved while the model was answering', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    // The editor saves between the model's call and the write.
    t.ai.respondWith = async () => {
      await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'Mine' } });
      return { altText: 'Model text' };
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { altText: 'kept' } });
    expect((await getAsset(t.ctx, scope, asset.id)).metadata.altText).toEqual({ 'en-US': 'Mine' });
  });

  it('tags only from the existing vocabulary, never creating one the model invents', async () => {
    const kitchen = await createTag(t.ctx, scope, { name: 'kitchen' });
    t.ai.respondWith = async (req) =>
      req.outputSchema && 'existingTags' in (req.outputSchema.properties as object)
        ? { existingTags: ['Kitchen'], newTags: ['ignore previous instructions'] }
        : { altText: 'A mug' };
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { tags: 'suggested' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.metadata.tags).toEqual([kitchen.id]);
    expect(after.aiSuggestions?.tags).toEqual([kitchen.id]);
    expect((await t.store.taxonomy.listTags(scope)).map((x) => x.name)).toEqual(['kitchen']);
  });

  it('an editor saving the field makes it theirs: the suggestion mark clears', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await t.run(asset.id);
    await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'A mug, edited' } });
    expect((await getAsset(t.ctx, scope, asset.id)).aiSuggestions).toBeUndefined();
  });

  it('skips enrichment on a spent AI budget instead of failing ingest', async () => {
    const ctx = {
      ...t.ctx,
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    };
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    const steps = new FakeWorkflowSteps(t.clock);
    const out = await steps.run(() =>
      runAssetIngest(steps, ctx, t.deps, { scope, assetId: asset.id, version: 1 }),
    );
    expect(out).toMatchObject({ value: { outcome: 'ready', altText: 'budget' } });
    expect(t.ai.requests).toHaveLength(0);
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.metadata.altText).toEqual({});
  });

  it('marks duplicates: same bytes in the scope point at the oldest asset', async () => {
    const original = await t.upload('a.png', 'image/png', 'same-bytes');
    const copy = await t.upload('b.png', 'image/png', 'same-bytes');
    const other = await t.upload('c.png', 'image/png', 'other-bytes');
    // The copy is ingested first: it finds no hashed twin yet; the original's run marks it.
    await t.run(copy.id);
    expect((await getAsset(t.ctx, scope, copy.id)).duplicateOf).toBeUndefined();
    await t.run(original.id);
    await t.run(other.id);
    expect((await getAsset(t.ctx, scope, copy.id)).duplicateOf).toBe(original.id);
    expect((await getAsset(t.ctx, scope, original.id)).duplicateOf).toBeUndefined();
    expect((await getAsset(t.ctx, scope, other.id)).duplicateOf).toBeUndefined();
    expect(ingested(t.store).find((e) => e.assetId === copy.id)?.duplicateOf).toBeUndefined();
  });

  it('marks two copies hashed at the same time, though neither saw the other when it looked', async () => {
    const original = await t.upload('a.png', 'image/png', 'same-bytes');
    const copy = await t.upload('b.png', 'image/png', 'same-bytes');
    // Both hash steps list the scope before either has written its hash.
    const list = t.store.assets.list.bind(t.store.assets);
    let looking = 0;
    let release: () => void = () => {};
    const bothLooked = new Promise<void>((r) => {
      release = r;
    });
    t.store.assets.list = async (sc, q) => {
      const page = await list(sc, q);
      if (q.filters?.contentHash && looking < 2) {
        looking += 1;
        if (looking === 2) release();
        await bothLooked;
      }
      return page;
    };
    const hash = (assetId: string) => hashAsset(t.ctx, t.deps, { scope, assetId, version: 1 });
    await Promise.all([hash(original.id), hash(copy.id)]);
    t.store.assets.list = list;
    expect((await getAsset(t.ctx, scope, copy.id)).duplicateOf).toBe(original.id);
    expect((await getAsset(t.ctx, scope, original.id)).duplicateOf).toBeUndefined();
  });

  it('does not mark a duplicate across environments (scope isolation)', async () => {
    await createEnvironment(t.ctx, 'shop', 'staging', 'Staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const a = await t.upload('a.png', 'image/png', 'same-bytes');
    const b = await t.upload('b.png', 'image/png', 'same-bytes', staging);
    await t.run(a.id);
    const steps = new FakeWorkflowSteps(t.clock);
    await steps.run(() =>
      runAssetIngest(steps, t.ctx, t.deps, { scope: staging, assetId: b.id, version: 1 }),
    );
    expect((await getAsset(t.ctx, staging, b.id)).duplicateOf).toBeUndefined();
  });

  it('extracts a document’s text beside the file, capped, and never into the asset row', async () => {
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF-bytes');
    t.extractor.setText('brief.pdf', `Heliotrope launch plan\u0000${'x'.repeat(10)}`);
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'ready', altText: 'skipped' } });
    const key = assetTextKey(scope, asset.id, 1) as string;
    expect(key).toBe(`shop/main/${asset.id}/v1/text.md`);
    const text = await t.blob.get(key);
    expect(text).toContain('Heliotrope launch plan');
    expect(text).not.toContain('\u0000');
    // The extractor read the asset's own file and nothing else.
    expect(t.extractor.read.map((f) => f.fileName)).toEqual(['brief.pdf']);
    expect(t.blob.opened.every((k) => k === asset.r2Key)).toBe(true);
    expect(JSON.stringify(await getAsset(t.ctx, scope, asset.id))).not.toContain('Heliotrope');
    const found = await searchAssets(t.ctx, t.deps.search ?? {}, scope, { q: 'heliotrope' });
    expect(found.items.map((a) => a.id)).toEqual([asset.id]);
  });

  it('skips extraction of a file over the size cap', async () => {
    const asset = await t.upload('huge.pdf', 'application/pdf', 'x'.repeat(16));
    const original = t.blob.open.bind(t.blob);
    t.blob.open = async (key) => {
      const o = await original(key);
      return o ? { ...o, size: MAX_EXTRACT_DOCUMENT_BYTES + 1 } : o;
    };
    await t.run(asset.id);
    expect(await t.blob.get(assetTextKey(scope, asset.id, 1) as string)).toBeNull();
    expect(t.extractor.read).toHaveLength(0);
  });

  it('records a step that keeps failing as error, with the message only', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    t.images.info = async () => {
      throw new Error('images binding down\n    at secret/stack.ts:1');
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'error' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('error');
    expect(after.ingestError).toBe('images binding down at secret/stack.ts:1');
    expect(ingested(t.store)).toHaveLength(0);
  });

  it('a run for a replaced or deleted file does nothing', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    // Replaced since the run was queued: a save can't move the version, a replace does.
    await t.store.withTransaction((tx) =>
      tx.assets.replaceFile(
        scope,
        { ...asset, version: 2 },
        { version: 1, file: asset.file, replacedAt: '2026-01-01T00:00:00.000Z' },
      ),
    );
    expect(await t.run(asset.id)).toMatchObject({ value: { outcome: 'stale' } });
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBeUndefined();
  });

  it('an editor save after ingest keeps the hash and status ingest recorded', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const stale = await getAsset(t.ctx, scope, asset.id); // read before ingest
    await t.run(asset.id);
    await t.store.assets.save(scope, { ...stale, title: { 'en-US': 'Mug' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('asset ingest, under failure and limits', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('a model that keeps failing records failed for its enrichment, and the run finishes', async () => {
    await createTag(t.ctx, scope, { name: 'kitchen' });
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    t.ai.respondWith = async () => {
      throw new Error('upstream model 503');
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({
      status: 'complete',
      value: { outcome: 'ready', altText: 'failed', tags: 'failed' },
    });
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('ready');
    expect(t.index.textOf(scope, asset.id)).toContain('mug.png');
  });

  it('a model answer without the shape asked for suggests nothing, and the run finishes', async () => {
    await createTag(t.ctx, scope, { name: 'kitchen' });
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    // A number where each list and sentence was asked for.
    t.ai.respondWith = async (req) =>
      Object.fromEntries(
        Object.keys((req.outputSchema?.properties ?? {}) as object).map((k) => [k, 42]),
      );
    const out = await t.run(asset.id);
    expect(out).toMatchObject({
      status: 'complete',
      value: { outcome: 'ready', altText: 'none', tags: 'none' },
    });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after).toMatchObject({ ingestStatus: 'ready', metadata: { altText: {}, tags: [] } });
    expect(after.aiSuggestions).toBeUndefined();
    // One call each: a malformed answer is not retried.
    expect(t.ai.requests).toHaveLength(2);
  });

  it('a store failure during enrichment still fails the run', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const getConfig = t.store.spaces.getConfig.bind(t.store.spaces);
    let calls = 0;
    t.store.spaces.getConfig = async (s) => {
      calls += 1;
      if (calls > 0) throw new Error('D1 unavailable');
      return getConfig(s);
    };
    const out = await t.run(asset.id);
    t.store.spaces.getConfig = getConfig;
    expect(out).toMatchObject({ value: { outcome: 'error', error: 'D1 unavailable' } });
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('error');
  });

  it('meters text extraction: a spent budget skips it, and the run goes on', async () => {
    const ctx = {
      ...t.ctx,
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    };
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    const steps = new FakeWorkflowSteps(t.clock);
    const out = await steps.run(() =>
      runAssetIngest(steps, ctx, t.deps, { scope, assetId: asset.id, version: 1 }),
    );
    expect(out).toMatchObject({ value: { outcome: 'ready', textChars: 0 } });
    expect(t.extractor.read).toHaveLength(0);
    expect(await t.blob.get(assetTextKey(scope, asset.id, 1) as string)).toBeNull();
  });

  it('meters text extraction against the budget when there is one', async () => {
    const guard = new InMemoryCostGuard({ maxRequests: 10, maxTokens: 100, windowSeconds: 60 });
    const ctx = { ...t.ctx, costGuard: guard };
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    t.extractor.setText('brief.pdf', 'x'.repeat(400));
    const steps = new FakeWorkflowSteps(t.clock);
    await steps.run(() =>
      runAssetIngest(steps, ctx, t.deps, { scope, assetId: asset.id, version: 1 }),
    );
    expect(t.extractor.read).toHaveLength(1);
    // The extraction's ~100 tokens (400 characters) were settled: the budget is now spent.
    expect(await guard.consume(scope)).toMatchObject({ allowed: false, reason: 'tokens' });
  });

  it('hands the extractor the stream’s chunks, never one joined copy', async () => {
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF-body');
    await t.run(asset.id);
    expect(t.extractor.read[0]).toMatchObject({ size: 9, chunks: [expect.any(Uint8Array)] });
  });

  it('skips the hash of a file over the cap, and goes on', async () => {
    const asset = await t.upload('big.png', 'image/png', 'bytes');
    const original = t.blob.open.bind(t.blob);
    let returned = 0;
    t.blob.open = async (key) => {
      const o = await original(key);
      if (!o) return o;
      const inner = o.body;
      const body = {
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]();
          return {
            next: () => it.next(),
            return: async () => {
              returned += 1;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
      return { ...o, body, size: MAX_HASH_BYTES + 1 };
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'ready' } });
    expect((out as { value: { contentHash?: string } }).value.contentHash).toBeUndefined();
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.contentHash).toBeUndefined();
    expect(after.file.size).toBe(MAX_HASH_BYTES + 1);
    // Neither the hash, the probe nor the placeholder (each over its own, smaller cap) read the
    // body: each let it go.
    expect(returned).toBe(3);
    expect(ingested(t.store)[0]?.contentHash).toBeUndefined();
  });

  it('does not probe a file over the image cap', async () => {
    const asset = await t.upload('huge.png', 'image/png', 'bytes');
    t.images.set('bytes', { width: 10, height: 10, format: 'image/png' });
    const original = t.blob.open.bind(t.blob);
    t.blob.open = async (key) => {
      const o = await original(key);
      return o ? { ...o, size: MAX_PROBE_BYTES + 1 } : o;
    };
    await t.run(asset.id);
    expect(t.images.calls).toBe(0);
    expect((await getAsset(t.ctx, scope, asset.id)).file.width).toBeUndefined();
  });

  it('writes the measured size and dimensions into a snapshot published before ingest', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'png-bytes');
    t.images.set('png-bytes', { width: 640, height: 480, format: 'image/png' });
    await publishAsset(t.ctx, scope, asset.id);
    await t.run(asset.id);
    const published = await getPublishedAsset(t.ctx, scope, asset.id);
    expect(published.file).toMatchObject({ width: 640, height: 480, size: 9 });
    expect(ingested(t.store)[0]?.published).toBe(true);
  });

  const PLACEHOLDER = {
    thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==',
    dominantColor: '#a07850',
  };

  it('records a raster image’s placeholder, into a snapshot published before ingest too', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'png-bytes');
    t.images.set('png-bytes', { width: 640, height: 480, format: 'image/png' });
    t.images.setPlaceholder('png-bytes', PLACEHOLDER);
    await publishAsset(t.ctx, scope, asset.id);
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'ready', placeholder: true } });
    expect((await getAsset(t.ctx, scope, asset.id)).file.placeholder).toEqual(PLACEHOLDER);
    expect((await getPublishedAsset(t.ctx, scope, asset.id)).file.placeholder).toEqual(PLACEHOLDER);
  });

  it('makes no placeholder for what the image service cannot decode, nor over its input cap', async () => {
    const svg = await t.upload('logo.svg', 'image/svg+xml', '<svg/>');
    const pdf = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    await t.run(svg.id);
    await t.run(pdf.id);
    expect(t.images.placeholderCalls).toBe(0);

    const huge = await t.upload('huge.png', 'image/png', 'png-bytes');
    t.images.setPlaceholder('png-bytes', PLACEHOLDER);
    let returned = 0;
    const original = t.blob.open.bind(t.blob);
    t.blob.open = async (key) => {
      const o = await original(key);
      if (!o) return o;
      const body = o.body;
      return {
        ...o,
        size: MAX_PLACEHOLDER_BYTES + 1,
        body: {
          [Symbol.asyncIterator]: () => {
            const it = body[Symbol.asyncIterator]();
            return {
              next: () => it.next(),
              return: async () => {
                returned += 1;
                return { done: true as const, value: undefined };
              },
            };
          },
        },
      };
    };
    const out = await t.run(huge.id);
    expect(out).toMatchObject({ value: { outcome: 'ready', placeholder: false } });
    expect(t.images.placeholderCalls).toBe(0);
    expect(returned).toBeGreaterThan(0);
    expect((await getAsset(t.ctx, scope, huge.id)).file.placeholder).toBeUndefined();
  });

  it('finishes ready without a placeholder when the image service keeps failing to make one', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'png-bytes');
    t.images.set('png-bytes', { width: 640, height: 480, format: 'image/png' });
    t.images.failPlaceholders = true;
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'ready', placeholder: false } });
    // Retried as a step is, then given up on.
    expect(t.images.placeholderCalls).toBeGreaterThan(1);
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.file.placeholder).toBeUndefined();
  });

  it('leaves a snapshot of another version as it was', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'png-bytes');
    await publishAsset(t.ctx, scope, asset.id);
    const stored = await getAsset(t.ctx, scope, asset.id);
    await t.store.assets.save(scope, {
      ...stored,
      version: 2,
      file: { ...stored.file, width: 1, height: 1 },
    });
    await finishIngest(t.ctx, { scope, assetId: asset.id, version: 2 }, { size: 1 });
    const published = await getPublishedAsset(t.ctx, scope, asset.id);
    expect(published.file.width).toBeUndefined();
  });

  it('records a failure without the credentials a provider quoted back', () => {
    const message = ingestErrorMessage(
      new Error('fetch https://user:hunter2@r2.example/x failed: Bearer abcdefghijkl'),
    );
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('abcdefghijkl');
    expect(message).toContain('r2.example');
  });

  it('an asset deleted while its text was extracted leaves no text behind', async () => {
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    const extract = t.extractor.extract.bind(t.extractor);
    t.extractor.extract = async (file) => {
      await t.store.assets.delete(scope, asset.id);
      return extract(file);
    };
    await t.run(asset.id);
    expect(await t.blob.get(assetTextKey(scope, asset.id, 1) as string)).toBeNull();
  });

  it('deleting the original re-points its copies at the oldest one left', async () => {
    const original = await t.upload('a.png', 'image/png', 'same');
    const second = await t.upload('b.png', 'image/png', 'same');
    const third = await t.upload('c.png', 'image/png', 'same');
    for (const a of [original, second, third]) await t.run(a.id);
    expect((await getAsset(t.ctx, scope, third.id)).duplicateOf).toBe(original.id);

    await archiveAsset(t.ctx, scope, original.id);

    await deleteAsset(t.ctx, scope, original.id);
    expect((await getAsset(t.ctx, scope, second.id)).duplicateOf).toBeUndefined();
    expect((await getAsset(t.ctx, scope, third.id)).duplicateOf).toBe(second.id);
  });

  it('an editor save clears the AI marks only for what it changed', async () => {
    const kitchen = await createTag(t.ctx, scope, { name: 'kitchen' });
    t.ai.respondWith = async (req) =>
      req.outputSchema && 'existingTags' in (req.outputSchema.properties as object)
        ? { existingTags: ['kitchen'], newTags: [] }
        : { altText: 'A mug' };
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    await t.run(asset.id);
    const ingestedAsset = await getAsset(t.ctx, scope, asset.id);
    expect(ingestedAsset.aiSuggestions).toEqual({ altText: ['en-US'], tags: [kitchen.id] });
    // A form sends the whole map and list back unchanged: still suggestions.
    await setAssetMetadata(t.ctx, scope, asset.id, {
      altText: ingestedAsset.metadata.altText,
      tags: ingestedAsset.metadata.tags,
    });
    expect((await getAsset(t.ctx, scope, asset.id)).aiSuggestions).toEqual({
      altText: ['en-US'],
      tags: [kitchen.id],
    });
    // Another locale added, the suggested one untouched: still a suggestion.
    await setAssetMetadata(t.ctx, scope, asset.id, {
      altText: { ...ingestedAsset.metadata.altText, 'de-DE': 'Ein Becher' },
    });
    expect((await getAsset(t.ctx, scope, asset.id)).aiSuggestions?.altText).toEqual(['en-US']);
    // Edited: the editor's now.
    await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'My mug' } });
    expect((await getAsset(t.ctx, scope, asset.id)).aiSuggestions).toEqual({ tags: [kitchen.id] });
  });
});

describe('importing and cloning assets', () => {
  it('a clone carries no ingest state and sends its assets through ingest', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(t.ctx, 'shop', 'copy', 'Copy');
    const target = { spaceId: 'shop', environmentId: 'copy' };
    const a = await t.upload('a.png', 'image/png', 'same');
    const b = await t.upload('b.png', 'image/png', 'same');
    await t.run(a.id);
    await t.run(b.id);
    await t.store.assets.save(scope, {
      ...(await getAsset(t.ctx, scope, b.id)),
      aiSuggestions: { altText: ['en-US'] },
    });

    await importSnapshot(t.ctx, target, await exportSnapshot(t.ctx, scope), {
      reindexAssets: true,
    });
    const copied = await getAsset(t.ctx, target, b.id);
    expect(copied.ingestStatus).toBeUndefined();
    expect(copied.ingestError).toBeUndefined();
    expect(copied.duplicateOf).toBeUndefined();
    expect(copied.aiSuggestions).toBeUndefined();
    const [job] = await t.store.bulkJobs.listJobs(target);
    expect(job).toMatchObject({ action: 'asset_reindex', totalItems: 2 });
  });

  it('without the ingest queue, an import starts no reindex', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(t.ctx, 'shop', 'copy', 'Copy');
    const target = { spaceId: 'shop', environmentId: 'copy' };
    await t.upload('a.png', 'image/png', 'a');
    await importSnapshot(t.ctx, target, await exportSnapshot(t.ctx, scope));
    expect(await t.store.bulkJobs.listJobs(target)).toEqual([]);
  });

  it('a snapshot job’s create phase completing starts the reindex, once', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await t.upload('a.png', 'image/png', 'a');
    const now = t.clock.now().toISOString();
    for (const [id, phase] of [
      ['create-job', 'create'],
      ['publish-job', 'publish'],
    ] as const) {
      await t.store.bulkJobs.createJob(scope, {
        id,
        action: 'import',
        status: 'completed',
        totalItems: 1,
        totalChunks: 1,
        completedChunks: 1,
        succeeded: 1,
        failed: 0,
        createdAt: now,
        config: { kind: 'snapshot', phase },
      });
    }
    const completed = (jobId: string) =>
      ({
        id: `ev-${jobId}`,
        type: 'bulk.job_completed',
        scope,
        occurredAt: now,
        jobId,
        action: 'import',
        total: 1,
        succeeded: 1,
        failed: 0,
      }) as DomainEvent;
    const deps = {
      sender: new RecordingWebhookSender(),
      assetIngest: new FakeAssetIngestQueue(),
    };
    await dispatchEvent(t.ctx, deps, completed('publish-job'));
    expect(
      (await t.store.bulkJobs.listJobs(scope)).filter((j) => j.action === 'asset_reindex'),
    ).toEqual([]);
    await dispatchEvent(t.ctx, deps, completed('create-job'));
    await dispatchEvent(t.ctx, deps, completed('create-job')); // redelivered
    const reindex = (await t.store.bulkJobs.listJobs(scope)).filter(
      (j) => j.action === 'asset_reindex',
    );
    expect(reindex).toHaveLength(1);
  });
});

describe('starting ingest', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('one run per file: the upload path and the notification start the same instance', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    expect(await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string)).toBe('started');
    expect(await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string)).toBe('started');
    expect(starter.started).toEqual([
      {
        instanceId: assetIngestInstanceId(scope, asset.id, 1),
        params: { scope, assetId: asset.id, version: 1 },
      },
    ]);
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('pending');
  });

  it('instance ids are deterministic, scoped, short, and differ per version and rerun', () => {
    const id = assetIngestInstanceId(scope, 'a-1', 1);
    expect(id).toBe(assetIngestInstanceId(scope, 'a-1', 1));
    expect(id).not.toBe(assetIngestInstanceId({ ...scope, environmentId: 'other' }, 'a-1', 1));
    expect(id).not.toBe(assetIngestInstanceId(scope, 'a-1', 2));
    expect(id).not.toBe(assetIngestInstanceId(scope, 'a-1', 1, { rerun: 'retry' }));
    // The bytes: a second PUT through the same URL is a run of its own; R2's quoted and
    // unquoted forms of one etag are the same bytes.
    const etag = assetIngestInstanceId(scope, 'a-1', 1, { etag: '"ABC"' });
    expect(etag).not.toBe(id);
    expect(etag).toBe(assetIngestInstanceId(scope, 'a-1', 1, { etag: 'abc' }));
    expect(etag).not.toBe(assetIngestInstanceId(scope, 'a-1', 1, { etag: 'def' }));
    const long = assetIngestInstanceId(scope, 'x'.repeat(300), 1, {
      rerun: 'retry',
      etag: 'e'.repeat(64),
    });
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ignores keys that are not an asset’s current file', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    for (const key of [
      `shop/main/${asset.id}/v1/text.md`,
      `shop/main/${asset.id}/other.png`,
      'versions/shop/main/e1/v1.json',
      'imports/shop/main/job/c1.json',
      'shop/main/missing/mug.png',
      '../shop/main/x',
    ]) {
      expect(await startAssetIngestForObject(t.ctx, starter, key)).toBe('ignored');
    }
    expect(starter.started).toEqual([]);
  });

  it('a requested rerun is its own run, and is ignored once the file moved on', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string);
    const request = { scope, assetId: asset.id, version: 1, rerun: 'r1' };
    expect(await startRequestedAssetIngest(t.ctx, starter, request)).toBe('started');
    expect(starter.started).toHaveLength(2);
    expect(await startRequestedAssetIngest(t.ctx, starter, { ...request, version: 2 })).toBe(
      'ignored',
    );
  });

  it('reingest queues a fresh run; a hosted video is refused', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const queue = new FakeAssetIngestQueue();
    const out = await reingestAsset(t.ctx, queue, scope, asset.id);
    expect(out.ingestStatus).toBe('pending');
    // Stored, not only answered: a reload shows the retry queued.
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('pending');
    expect(queue.requested).toEqual([
      { scope, assetId: asset.id, version: 1, rerun: expect.any(String) },
    ]);
  });

  it('the reindex job covers assets never ingested or failed, and its chunk asks once per job', async () => {
    const fresh = await t.upload('a.png', 'image/png', 'a');
    const done = await t.upload('b.png', 'image/png', 'b');
    await t.run(done.id);
    const { assets, job } = await startAssetReindex(t.ctx, scope);
    expect(assets).toBe(1);
    expect(job?.action).toBe('asset_reindex');

    const queue = new FakeAssetIngestQueue();
    const runChunk = assetReindexChunkRunner(t.ctx, queue);
    const chunk = {
      jobId: job?.id as string,
      chunkId: 'c00000',
      entryIds: [fresh.id, 'gone'],
      status: 'running' as const,
      attempts: 1,
      failures: [],
    };
    const outcome = await runChunk(scope, job as NonNullable<typeof job>, chunk);
    expect(outcome).toEqual({ succeeded: 1, failures: [{ id: 'gone', error: 'Asset not found' }] });
    // A chunk run again asks for the same run (the job's token), so it starts once.
    await runChunk(scope, job as NonNullable<typeof job>, chunk);
    const starter = new RecordingAssetIngestStarter();
    for (const r of queue.requested) await startRequestedAssetIngest(t.ctx, starter, r);
    expect(starter.started).toHaveLength(1);
  });

  it('a reindex while one is running returns that job; once it is done, a new one starts', async () => {
    await t.upload('a.png', 'image/png', 'a');
    const done = await t.upload('b.png', 'image/png', 'b');
    await t.run(done.id);
    const first = await startAssetReindex(t.ctx, scope);
    const again = await startAssetReindex(t.ctx, scope, { all: true });
    expect(again).toEqual({ assets: 1, job: first.job, running: true });
    expect((await t.store.bulkJobs.listJobs(scope)).length).toBe(1);

    await t.store.bulkJobs.finalizeJob(scope, first.job?.id as string, 'completed', new Date());
    const all = await startAssetReindex(t.ctx, scope, { all: true });
    expect(all.assets).toBe(2);
    expect(all.job?.id).not.toBe(first.job?.id);
    expect(all.running).toBeUndefined();
  });

  it('reingest does nothing while a run is queued or running', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const queue = new FakeAssetIngestQueue();
    for (const status of ['pending', 'processing'] as const) {
      await t.store.assets.recordIngest(scope, asset.id, 1, { status });
      const out = await reingestAsset(t.ctx, queue, scope, asset.id);
      expect(out.ingestStatus).toBe(status);
    }
    expect(queue.requested).toEqual([]);
    await t.store.assets.recordIngest(scope, asset.id, 1, { status: 'error', error: 'x' });
    await reingestAsset(t.ctx, queue, scope, asset.id);
    expect(queue.requested).toHaveLength(1);
  });

  it('a repeat start after the run finished leaves the asset as the run left it', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    const key = asset.r2Key as string;
    await startAssetIngestForObject(t.ctx, starter, key, '"e1"');
    await t.run(asset.id);
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('ready');
    // R2's notification after the upload path's run finished: same bytes, same id, no run.
    expect(await startAssetIngestForObject(t.ctx, starter, key, 'e1')).toBe('started');
    expect(starter.started).toHaveLength(1);
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('ready');

    // A failed run keeps its status and message through a repeated request too.
    await t.store.assets.recordIngest(scope, asset.id, 1, { status: 'error', error: 'boom' });
    const request = { scope, assetId: asset.id, version: 1, rerun: 'job-1' };
    await startRequestedAssetIngest(t.ctx, starter, request);
    await t.store.assets.recordIngest(scope, asset.id, 1, { status: 'error', error: 'boom' });
    await startRequestedAssetIngest(t.ctx, starter, request);
    expect(await getAsset(t.ctx, scope, asset.id)).toMatchObject({
      ingestStatus: 'error',
      ingestError: 'boom',
    });
  });

  it('never writes pending over a run in progress (the two triggers racing)', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string);
    await beginIngest(t.ctx, { scope, assetId: asset.id, version: 1 });
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('processing');
    // The other trigger, late, and a requested rerun that does start a run.
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string);
    await startRequestedAssetIngest(t.ctx, starter, {
      scope,
      assetId: asset.id,
      version: 1,
      rerun: 'r',
    });
    expect(starter.started).toHaveLength(2);
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('processing');
  });

  it('a second PUT of new bytes through the same URL is ingested again', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string, '"first"');
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string, '"first"');
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string, '"second"');
    expect(starter.started.map((s) => s.instanceId)).toEqual([
      assetIngestInstanceId(scope, asset.id, 1, { etag: 'first' }),
      assetIngestInstanceId(scope, asset.id, 1, { etag: 'second' }),
    ]);
  });
});

describe('asset ingest cleanup', () => {
  it('deleting an asset removes its vector, its search document and its extracted text', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    t.extractor.setText('brief.pdf', 'Heliotrope');
    await t.run(asset.id);
    const textKey = assetTextKey(scope, asset.id, 1) as string;
    expect(await t.blob.get(textKey)).toBe('Heliotrope');

    await archiveAsset(t.ctx, scope, asset.id);

    await deleteAsset(t.ctx, scope, asset.id);
    const deps = {
      sender: new RecordingWebhookSender(),
      blob: t.blob,
      assetSearch: t.deps.search,
    };
    for (const event of t.store.allEvents()) await dispatchEvent(t.ctx, deps, event);
    expect(t.vectors.assetRows.size).toBe(0);
    expect(t.index.textOf(scope, asset.id)).toBeUndefined();
    expect(await t.blob.get(textKey)).toBeNull();
    expect(t.blob.bytes(asset.r2Key as string)).toBeNull();
  });

  it('publishing re-indexes from the published snapshot', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'Teal mug' } });
    await publishAsset(t.ctx, scope, asset.id);
    const deps = { sender: new RecordingWebhookSender(), blob: t.blob, assetSearch: t.deps.search };
    for (const event of t.store.allEvents()) await dispatchEvent(t.ctx, deps, event);
    expect(t.index.textOf(scope, asset.id)).toContain('teal mug');
  });

  it('an environment purge removes its assets’ vectors and documents before the rows go', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(t.ctx, 'shop', 'staging', 'Staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const kept = await t.upload('keep.png', 'image/png', 'k');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await t.upload(`s${i}.png`, 'image/png', `s${i}`, staging);
      const steps = new FakeWorkflowSteps(t.clock);
      await steps.run(() =>
        runAssetIngest(steps, t.ctx, t.deps, { scope: staging, assetId: a.id, version: 1 }),
      );
      ids.push(a.id);
    }
    await t.run(kept.id);
    expect(t.vectors.assetRows.size).toBe(4);

    await deleteEnvironment(t.ctx, 'shop', 'staging', { confirm: 'staging', principal: ADMIN });
    const deps = { sender: new RecordingWebhookSender(), blob: t.blob, assetSearch: t.deps.search };
    // Drain as the engine does: every new event, until none are left.
    for (let seen = 0, guard = 0; guard < 50; guard++) {
      const events = t.store.allEvents().slice(seen);
      if (events.length === 0) break;
      seen += events.length;
      for (const e of events) await dispatchEvent(t.ctx, deps, e);
    }
    expect([...t.vectors.assetRows.keys()]).toEqual([`shop::main::${kept.id}`]);
    for (const id of ids) expect(t.index.textOf(staging, id)).toBeUndefined();
    expect(t.index.textOf(scope, kept.id)).toBeDefined();
  });
});

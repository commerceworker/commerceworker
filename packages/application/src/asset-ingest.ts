import { createHash } from 'node:crypto';
import {
  type Asset,
  type AssetAiSuggestions,
  applyAssetMetadata,
  assetKind,
  isTransformableImage,
  NotFoundError,
  RateLimitedError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type {
  AIProvider,
  AssetIngestParams,
  AssetIngestQueue,
  AssetIngestRequest,
  AssetIngestStarter,
  BlobStore,
  BulkJob,
  BulkJobChunk,
  ByteStream,
  GenerateRequest,
  GenerateResult,
  ImageProbe,
  TextExtractor,
  WorkflowStepConfig,
  WorkflowSteps,
} from '@commerceworker/ports';
import { redactCredentials } from '@commerceworker/redaction';
import { runWithBudget } from './ai-budget';
import { type AssetSearchDeps, embedAssetForSearch, indexAssetText } from './asset-search';
import { allAssets, assetFileKey, assetTextKey, parseAssetObjectKey } from './assets';
import type { BulkChunkOutcome } from './bulk-jobs';
import { startBulkJob } from './bulk-jobs';
import type { AppContext } from './context';
import { autoTagAsset, generateAltText, NoAltTextError } from './media-ai';

/**
 * Asset ingest: what happens to a file once its bytes land in storage. One durable run per file
 * version (an `AssetIngestWorkflow` instance on edge), each step one unit of work that can be
 * retried or replayed on its own:
 *
 * 1. `hash`: SHA-256 of the bytes, streamed, and the duplicate marker (the oldest other asset in
 *    the scope with the same hash).
 * 2. `probe`: an image's dimensions and real format; `placeholder`: a raster image's ThumbHash and
 *    dominant colour, from a thumbnail (a failure there leaves the asset without one, never fails
 *    ingest).
 * 3. `alt-text`, `tags`: an image's alt text and tags from the existing AI use-cases, written only
 *    where empty and marked as AI suggestions. A spent AI budget skips them, and a model that still
 *    fails once the step's retries are spent records `failed`: neither fails ingest.
 * 4. `extract-text`: a document's or recording's text, into blob storage beside the file
 *    (`assetTextKey`), never into D1, and never anywhere the media origin serves. Metered by the
 *    space's AI budget, which skips it when spent.
 * 5. `embed`, `index`: the asset's search vectors and lexical documents (library and published).
 * 6. `finish`: `ingest_status` ready, the published snapshot's measurements and `asset.ingested`,
 *    in one unit.
 *
 * Everything a step writes is checked against the file version the run is for: a file replaced
 * mid-run makes the rest of the run a no-op (the new version has its own run).
 */

/** What an ingest run reads and writes beyond the store. Each port is optional, as is its step. */
export interface AssetIngestDeps {
  /** Where the bytes are; without `open`, nothing that reads them runs. */
  readonly blob: BlobStore;
  readonly images?: ImageProbe;
  readonly extractor?: TextExtractor;
  /** Generation model for alt text and tags; absent, enrichment is skipped. */
  readonly ai?: AIProvider;
  readonly search?: AssetSearchDeps;
}

/**
 * Largest file hashed. SHA-256 streams, so memory is not the bound, but a step's time is: a larger
 * file keeps no hash (and so no duplicate check) and ingest goes on without it.
 */
export const MAX_HASH_BYTES = 512 * 1024 * 1024;
/** Largest file probed for dimensions: an image's size, not a video's or an archive's. */
export const MAX_PROBE_BYTES = 70 * 1024 * 1024;
/** Largest image a placeholder is made from: what the Images binding takes as input. */
export const MAX_PLACEHOLDER_BYTES = 20 * 1024 * 1024;
/** Largest document text extraction reads (Markdown conversion takes the whole file). */
export const MAX_EXTRACT_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Largest recording transcription reads (Whisper takes it base64-encoded, in one request). */
export const MAX_EXTRACT_AUDIO_BYTES = 10 * 1024 * 1024;
/** Most characters of extracted text kept; the rest of a long document is not indexed. */
export const MAX_EXTRACTED_TEXT_CHARS = 500_000;
/** Longest alt text ingest writes (the use-case asks for under 125; a model may not listen). */
export const MAX_INGEST_ALT_TEXT_CHARS = 300;
/** Longest error message recorded on an asset. */
export const MAX_INGEST_ERROR_CHARS = 300;
/** Other assets with the same hash re-pointed at the original per run. */
const MAX_DUPLICATES_MARKED = 50;

const STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
};
/** Model calls (enrichment, conversion, transcription) get longer, and fewer retries. */
const SLOW_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};

// ---- starting a run ------------------------------------------------------------------------

/**
 * The run id for one write of a file version: the same scope, asset, version and bytes (`etag`,
 * as R2 names them) always give the same id, so the upload path and R2's notification (and any
 * redelivery of either) start one run between them, while a second PUT through the same signed
 * URL (new bytes, same key) is a run of its own. A rerun (a person's retry, the reindex job) adds
 * its own token. Workflows ids are at most 100 characters of `[A-Za-z0-9_-]`; an asset id that
 * isn't one is hashed in.
 */
export function assetIngestInstanceId(
  scope: Scope,
  assetId: string,
  version: number,
  opts: { readonly rerun?: string; readonly etag?: string } = {},
): string {
  const scopeHash = sha256Hex(`${scope.spaceId}\n${scope.environmentId}`).slice(0, 16);
  const id = /^[A-Za-z0-9-]{1,40}$/.test(assetId) ? assetId : sha256Hex(assetId).slice(0, 32);
  const etag = opts.etag ? normalEtag(opts.etag) : '';
  const token = etag || opts.rerun ? `${etag}\n${opts.rerun ?? ''}` : '';
  const suffix = token ? `-x${sha256Hex(token).slice(0, 12)}` : '';
  return `ingest-${id}-v${version}-${scopeHash}${suffix}`;
}

/** An etag as R2's notification and its `put` result both give it: unquoted, lowercase. */
const normalEtag = (etag: string) => etag.replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();

export type IngestStart = 'started' | 'ignored';

/**
 * Starts ingest for an object that was written (the asset-events queue body for an R2
 * notification, or the api's own upload message, each naming the bytes by `etag`). Only an
 * asset's current file starts a run: a key that isn't an asset file (extracted text, a version
 * body), an asset that is gone or has moved to another version, and a hosted video are ignored.
 */
export async function startAssetIngestForObject(
  ctx: AppContext,
  starter: AssetIngestStarter,
  key: string,
  etag?: string,
): Promise<IngestStart> {
  const parsed = parseAssetObjectKey(key);
  if (!parsed) return 'ignored';
  const { scope, assetId } = parsed;
  const asset = await ctx.store.assets.get(scope, assetId);
  if (!asset || asset.file.video || assetFileKey(scope, asset) !== key) return 'ignored';
  const version = asset.version ?? 1;
  await startRun(
    ctx,
    starter,
    asset,
    { scope, assetId, version },
    assetIngestInstanceId(scope, assetId, version, etag ? { etag } : {}),
  );
  return 'started';
}

/** Statuses a new run may mark pending: anything but a run in progress. */
const NOT_PROCESSING = [null, 'pending', 'ready', 'error'] as const;

/**
 * Marks the file pending and starts its run. Pending is never written over `processing` (the
 * other trigger of the same upload got there first, and that run moves the status on). When the
 * run already existed (a redelivery, or the other trigger after the run finished), the finished
 * status it had is put back, so an asset is never left pending with no run to move it on.
 */
async function startRun(
  ctx: AppContext,
  starter: AssetIngestStarter,
  asset: Asset,
  params: AssetIngestParams,
  instanceId: string,
): Promise<void> {
  const { scope, assetId, version } = params;
  const before = asset.ingestStatus ?? null;
  await ctx.store.assets.recordIngest(scope, assetId, version, {
    status: 'pending',
    error: null,
    onlyFrom: NOT_PROCESSING,
  });
  const created = await starter.start(instanceId, params);
  if (!created && (before === 'ready' || before === 'error')) {
    await ctx.store.assets.recordIngest(scope, assetId, version, {
      status: before,
      error: before === 'error' ? (asset.ingestError ?? null) : null,
      onlyFrom: ['pending'],
    });
  }
}

/**
 * Starts the run a request asks for (a retry or the reindex job): the asset must still be on the
 * requested version. The request's `rerun` token makes it a run of its own.
 */
export async function startRequestedAssetIngest(
  ctx: AppContext,
  starter: AssetIngestStarter,
  request: AssetIngestRequest,
): Promise<IngestStart> {
  const { scope, assetId, version } = request;
  const asset = await ctx.store.assets.get(scope, assetId);
  if (!asset || asset.file.video || (asset.version ?? 1) !== version) return 'ignored';
  await startRun(
    ctx,
    starter,
    asset,
    { scope, assetId, version },
    assetIngestInstanceId(scope, assetId, version, request.rerun ? { rerun: request.rerun } : {}),
  );
  return 'started';
}

/**
 * Runs ingest on an asset's current file again (a person's retry after an error, or after the
 * extraction or AI setup changed). Refused for a hosted video, whose bytes the video host keeps.
 * While a run is queued or running it does nothing and returns the asset as it is: a second run
 * would only repeat the first (and its model calls).
 */
export async function reingestAsset(
  ctx: AppContext,
  queue: AssetIngestQueue,
  scope: Scope,
  id: string,
): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  if (asset.file.video) {
    throw new ValidationError([
      { field: 'id', message: 'A hosted video is processed by its video host, not ingest' },
    ]);
  }
  if (asset.ingestStatus === 'pending' || asset.ingestStatus === 'processing') return asset;
  const version = asset.version ?? 1;
  // Recorded now, so a reload shows the retry queued (and a second click is the no-op above).
  await ctx.store.assets.recordIngest(scope, id, version, {
    status: 'pending',
    error: null,
    onlyFrom: NOT_PROCESSING,
  });
  await queue.request([{ scope, assetId: id, version, rerun: ctx.ids.newId() }]);
  return { ...asset, ingestStatus: 'pending' };
}

export interface AssetReindexResult {
  /** Assets sent through ingest. */
  readonly assets: number;
  /** The bulk job that sends them; absent when there was nothing to do. */
  readonly job?: BulkJob;
  /** Set when `job` is a reindex that was already running, not a new one. */
  readonly running?: true;
}

/** Recent jobs looked through for a reindex still running. */
const RUNNING_REINDEX_LOOKBACK = 50;

/**
 * Sends the library through ingest as a resumable bulk job (`asset_reindex`): by default the
 * assets never ingested (uploaded before ingest shipped) or whose ingest failed; with `all`, every
 * asset with a file. Hosted videos are left out. While a reindex is still running in the scope,
 * that job is returned instead of a second one (whose runs, and model calls, would repeat it).
 */
export async function startAssetReindex(
  ctx: AppContext,
  scope: Scope,
  opts: { readonly all?: boolean } = {},
): Promise<AssetReindexResult> {
  const running = (
    await ctx.store.bulkJobs.listJobs(scope, { limit: RUNNING_REINDEX_LOOKBACK })
  ).find((j) => j.action === 'asset_reindex' && j.status === 'running');
  if (running) return { assets: running.totalItems, job: running, running: true };
  const ids = (await allAssets(ctx, scope))
    .filter((a) => !a.file.video)
    .filter((a) => opts.all || a.ingestStatus === undefined || a.ingestStatus === 'error')
    .map((a) => a.id);
  if (ids.length === 0) return { assets: 0 };
  const job = await startBulkJob(ctx, scope, { action: 'asset_reindex', entryIds: ids });
  return { assets: ids.length, job };
}

/**
 * The `asset_reindex` chunk runner: hands the chunk's assets to the ingest queue. The rerun token
 * is the job's, so a chunk run twice (a redelivery, the stall sweep) asks for the same runs.
 */
export function assetReindexChunkRunner(
  ctx: AppContext,
  queue: AssetIngestQueue,
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job, chunk) => {
    const found = new Map(
      (await ctx.store.assets.getMany(scope, chunk.entryIds)).map((a) => [a.id, a]),
    );
    const requests: AssetIngestRequest[] = [];
    const failures: { id: string; error: string }[] = [];
    for (const id of chunk.entryIds) {
      const asset = found.get(id);
      if (!asset) failures.push({ id, error: 'Asset not found' });
      else if (asset.file.video) failures.push({ id, error: 'Hosted videos are not ingested' });
      else requests.push({ scope, assetId: id, version: asset.version ?? 1, rerun: job.id });
    }
    if (requests.length > 0) await queue.request(requests);
    return { succeeded: requests.length, failures };
  };
}

// ---- the run ---------------------------------------------------------------------------------

/** How a run ended: `stale` when the asset was deleted or its file replaced along the way. */
export type IngestOutcome = 'ready' | 'error' | 'stale';

/** What each step did, as the run's result records it (JSON, for the Workflows journal). */
export interface IngestSummary {
  readonly outcome: IngestOutcome;
  readonly contentHash?: string;
  readonly duplicateOf?: string;
  readonly altText?: EnrichOutcome;
  readonly tags?: EnrichOutcome;
  /** Whether a placeholder was recorded. */
  readonly placeholder?: boolean;
  readonly textChars?: number;
  readonly error?: string;
}

/**
 * One ingest run over durable steps (`step.do` on Workflows; FakeWorkflowSteps in tests). Steps are
 * named by what they do, so a replay finds each one's recorded result. A step that still fails
 * after its retries ends the run as `error`, recorded on the asset, rather than leaving it
 * processing for good.
 */
export async function runAssetIngest(
  steps: Pick<WorkflowSteps, 'do'>,
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<IngestSummary> {
  const begun = await steps.do('begin', STEP, () => beginIngest(ctx, params));
  if (!begun) return { outcome: 'stale' };
  try {
    const hashed = await steps.do('hash', STEP, () => hashAsset(ctx, deps, params));
    if (!hashed) return { outcome: 'stale' };
    await steps.do('probe', STEP, () => probeAsset(ctx, deps, params));
    const placeholder = await steps
      .do('placeholder', STEP, () => placeholderAsset(ctx, deps, params))
      // A placeholder is a nicety: one the service kept failing to make is simply not there.
      .catch(() => false);
    const altText = await enrichStep(steps, 'alt-text', () => enrichAltText(ctx, deps, params));
    const tags = await enrichStep(steps, 'tags', () => enrichTags(ctx, deps, params));
    const text = await steps.do('extract-text', SLOW_STEP, () => extractText(ctx, deps, params));
    await steps.do('embed', STEP, async () =>
      deps.search
        ? embedAssetForSearch(ctx, deps.search, deps.blob, params.scope, params.assetId)
        : false,
    );
    await steps.do('index', STEP, async () =>
      deps.search
        ? indexAssetText(ctx, deps.search, deps.blob, params.scope, params.assetId)
        : false,
    );
    const finished = await steps.do('finish', STEP, () => finishIngest(ctx, params, hashed));
    return {
      outcome: finished ? 'ready' : 'stale',
      ...(hashed.contentHash ? { contentHash: hashed.contentHash } : {}),
      ...(hashed.duplicateOf ? { duplicateOf: hashed.duplicateOf } : {}),
      altText,
      tags,
      placeholder,
      textChars: text.chars,
    };
  } catch (err) {
    const error = ingestErrorMessage(err);
    await steps.do('fail', STEP, () => failIngest(ctx, params, error));
    return { outcome: 'error', error };
  }
}

/**
 * An enrichment step (alt text, tags). A model that still fails once the step's retries are spent
 * is recorded as `failed` and the run goes on: the suggestion is a nicety, the rest of ingest is
 * not. Anything else (the store) still fails the run.
 */
async function enrichStep(
  steps: Pick<WorkflowSteps, 'do'>,
  name: string,
  enrich: () => Promise<EnrichOutcome>,
): Promise<EnrichOutcome> {
  try {
    return await steps.do(name, SLOW_STEP, enrich);
  } catch (err) {
    if (isModelFailure(err)) return 'failed';
    throw err;
  }
}

/**
 * Marks a failure as the model's, in its message: Workflows hands a step's last error back as a
 * plain `Error`, so the class does not survive the journal, but the message does.
 */
const MODEL_FAILURE = 'AI model call failed: ';

class ModelCallError extends Error {
  constructor(cause: unknown) {
    super(`${MODEL_FAILURE}${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ModelCallError';
  }
}

const isModelFailure = (err: unknown) =>
  err instanceof ModelCallError || (err instanceof Error && err.message.includes(MODEL_FAILURE));

/** The provider, with what its `generate` throws marked as the model's (see {@link enrichStep}). */
function markingModelFailures(ai: AIProvider): AIProvider {
  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      try {
        return await ai.generate(req);
      } catch (err) {
        throw new ModelCallError(err);
      }
    },
  };
}

/** The asset as the run sees it: `null` once it is gone, on another version, or a hosted video. */
async function currentAsset(ctx: AppContext, params: AssetIngestParams): Promise<Asset | null> {
  const asset = await ctx.store.assets.get(params.scope, params.assetId);
  if (!asset || asset.file.video || (asset.version ?? 1) !== params.version) return null;
  return asset;
}

export async function beginIngest(ctx: AppContext, params: AssetIngestParams): Promise<boolean> {
  if (!(await currentAsset(ctx, params))) return false;
  await ctx.store.assets.recordIngest(params.scope, params.assetId, params.version, {
    status: 'processing',
    error: null,
  });
  return true;
}

export interface HashResult {
  /** Absent for a file over {@link MAX_HASH_BYTES}, which is not hashed. */
  readonly contentHash?: string;
  readonly size: number;
  readonly duplicateOf?: string;
}

/**
 * Hashes the file (SHA-256, streamed: it is never held whole) and marks duplicates: the oldest
 * asset in the scope with these bytes is the original, and every other one, this one included,
 * points at it. Two copies hashed at the same time may each look before the other has written its
 * hash, so after writing, the marks are checked once more against everything with this hash: the
 * later of the two second looks sees both. A file over {@link MAX_HASH_BYTES} is not read: its size is
 * recorded and ingest goes on without a hash. `null` when the asset moved on.
 */
export async function hashAsset(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<HashResult | null> {
  const { scope, assetId, version } = params;
  const asset = await currentAsset(ctx, params);
  if (!asset) return null;
  if (!deps.blob.open) throw new Error('The blob store cannot stream files');
  const object = await deps.blob.open(assetFileKey(scope, asset));
  if (!object) throw new Error('The file is not in storage');
  if (object.size > MAX_HASH_BYTES) {
    await discard(object.body);
    await ctx.store.assets.recordIngest(scope, assetId, version, { size: object.size });
    return { size: object.size };
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of object.body) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  const contentHash = hash.digest('hex');
  const same = (
    await ctx.store.assets.list(scope, {
      limit: MAX_DUPLICATES_MARKED,
      filters: { contentHash, status: 'all' },
      sort: { field: 'createdAt', direction: 'asc' },
    })
  ).items.filter((a) => a.id !== assetId);
  const original = [...same, { ...asset, contentHash }].sort(byAge)[0];
  const duplicateOf = original && original.id !== assetId ? original.id : undefined;
  await ctx.store.withTransaction(async (tx) => {
    await tx.assets.recordIngest(scope, assetId, version, {
      contentHash,
      size,
      duplicateOf: duplicateOf ?? null,
    });
    for (const other of same) {
      if (!original || other.id === original.id || other.duplicateOf === original.id) continue;
      await tx.assets.recordIngest(scope, other.id, other.version ?? 1, {
        duplicateOf: original.id,
      });
    }
  });
  const settled = await settleDuplicates(ctx, scope, contentHash, assetId);
  return { contentHash, size, ...(settled ? { duplicateOf: settled } : {}) };
}

/**
 * Re-reads every asset with `contentHash` (this one's hash now among them) and points each at the
 * oldest, the oldest at nothing. Returns what `assetId` points at now.
 */
async function settleDuplicates(
  ctx: AppContext,
  scope: Scope,
  contentHash: string,
  assetId: string,
): Promise<string | undefined> {
  const all = (
    await ctx.store.assets.list(scope, {
      limit: MAX_DUPLICATES_MARKED,
      filters: { contentHash, status: 'all' },
      sort: { field: 'createdAt', direction: 'asc' },
    })
  ).items.sort(byAge);
  const original = all[0];
  if (!original) return undefined;
  const wrong = all.filter(
    (a) => (a.duplicateOf ?? null) !== (a.id === original.id ? null : original.id),
  );
  if (wrong.length > 0) {
    await ctx.store.withTransaction(async (tx) => {
      for (const a of wrong) {
        await tx.assets.recordIngest(scope, a.id, a.version ?? 1, {
          duplicateOf: a.id === original.id ? null : original.id,
        });
      }
    });
  }
  return assetId === original.id ? undefined : original.id;
}

/** Oldest first; an asset with no creation time (a pre-0007 row) counts as oldest; then by id. */
function byAge(a: Asset, b: Asset): number {
  const at = (x: Asset) => (x.createdAt ? Date.parse(x.createdAt) : 0);
  return at(a) - at(b) || a.id.localeCompare(b.id);
}

/** Content types that say nothing about the bytes: the probe may name the real one. */
const UNKNOWN_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const mimeOf = (contentType: string) => (contentType.split(';')[0] ?? '').trim().toLowerCase();

/**
 * Reads an image's dimensions and format (images, and files uploaded without a useful content
 * type, which may turn out to be one). The format replaces the content type only where the
 * upload declared none worth keeping. A file over {@link MAX_PROBE_BYTES} is no image the probe
 * should read: it is skipped, its body cancelled unread.
 */
export async function probeAsset(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<{ width?: number; height?: number; format?: string }> {
  const asset = await currentAsset(ctx, params);
  if (!asset || !deps.images || !deps.blob.open) return {};
  const declared = mimeOf(asset.file.contentType);
  if (!declared.startsWith('image/') && !UNKNOWN_TYPES.has(declared)) return {};
  const object = await deps.blob.open(assetFileKey(params.scope, asset));
  if (!object) return {};
  if (object.size > MAX_PROBE_BYTES) {
    await discard(object.body);
    return {};
  }
  const info = await deps.images.info(object.body);
  if (!info) return {};
  await ctx.store.assets.recordIngest(params.scope, params.assetId, params.version, {
    width: info.width,
    height: info.height,
    ...(UNKNOWN_TYPES.has(declared) && info.format.startsWith('image/')
      ? { contentType: info.format }
      : {}),
  });
  return { width: info.width, height: info.height, format: info.format };
}

/**
 * Records a raster image's placeholder (ThumbHash and dominant colour) from a thumbnail the image
 * service makes. Only types the service can decode, no larger than {@link MAX_PLACEHOLDER_BYTES}
 * (a larger file is skipped, its body cancelled unread). `false` when nothing was recorded.
 */
export async function placeholderAsset(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<boolean> {
  const asset = await currentAsset(ctx, params);
  const make = deps.images?.placeholder?.bind(deps.images);
  // After the probe: a file uploaded without a type has its real one by now.
  if (!asset || !make || !deps.blob.open || !isTransformableImage(asset.file.contentType)) {
    return false;
  }
  const object = await deps.blob.open(assetFileKey(params.scope, asset));
  if (!object) return false;
  if (object.size > MAX_PLACEHOLDER_BYTES) {
    await discard(object.body);
    return false;
  }
  const placeholder = await make(object.body);
  if (!placeholder) return false;
  await ctx.store.assets.recordIngest(params.scope, params.assetId, params.version, {
    placeholder,
  });
  return true;
}

/**
 * What an enrichment step did: wrote a suggestion, kept a value someone set, or didn't run
 * (`budget`: the space's AI budget was spent; `failed`: the model kept failing).
 */
export type EnrichOutcome = 'suggested' | 'kept' | 'none' | 'skipped' | 'budget' | 'failed';

/**
 * Suggests alt text for an image in the space's default locale, when it has none. The existing
 * use-case writes the prompt (from the file name, title and description, never from file
 * contents) and records the run in the agent ledger; a spent budget skips the step.
 */
export async function enrichAltText(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<EnrichOutcome> {
  const asset = await currentAsset(ctx, params);
  if (!asset || !deps.ai || assetKind(asset.file.contentType) !== 'image') return 'skipped';
  const config = await ctx.store.spaces.getConfig(params.scope);
  if (!config) return 'skipped';
  const locale = config.defaultLocale;
  if (hasText(asset.metadata.altText[locale])) return 'kept';
  let altText: string;
  try {
    ({ altText } = await generateAltText(
      ctx,
      markingModelFailures(deps.ai),
      params.scope,
      params.assetId,
      { locale },
    ));
  } catch (err) {
    if (err instanceof RateLimitedError) return 'budget';
    // An answer with no alt text in it (empty, or not the shape asked for) suggests nothing; the
    // rest of ingest goes on, and asking again would get the same answer at another call's cost.
    if (err instanceof NoAltTextError) return 'none';
    throw err;
  }
  const clean = plainLine(altText, MAX_INGEST_ALT_TEXT_CHARS);
  if (!clean) return 'none';
  return (await applySuggestions(ctx, params, { altText: { [locale]: clean } }))
    ? 'suggested'
    : 'kept';
}

/**
 * Suggests tags for an image that has none: only tags already in the space's vocabulary. The
 * model may propose new names; ingest never creates them (a person's "Suggest tags" does), so
 * nothing a model says can grow the taxonomy unattended.
 */
export async function enrichTags(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<EnrichOutcome> {
  const asset = await currentAsset(ctx, params);
  if (!asset || !deps.ai || assetKind(asset.file.contentType) !== 'image') return 'skipped';
  if (asset.metadata.tags.length > 0) return 'kept';
  // An empty vocabulary has nothing to choose from: no call.
  if ((await ctx.store.taxonomy.listTags(params.scope)).length === 0) return 'none';
  let tagIds: readonly string[];
  try {
    ({ tagIds } = await autoTagAsset(
      ctx,
      markingModelFailures(deps.ai),
      params.scope,
      params.assetId,
    ));
  } catch (err) {
    if (err instanceof RateLimitedError) return 'budget';
    throw err;
  }
  if (tagIds.length === 0) return 'none';
  return (await applySuggestions(ctx, params, { tags: [...new Set(tagIds)] }))
    ? 'suggested'
    : 'kept';
}

/**
 * Writes suggestions through the metadata path (`applyAssetMetadata` validates as an editor's
 * patch is validated), re-reading the asset first: only fields still empty are filled, so a value
 * an editor saved while the model ran wins. Marks what it wrote as AI suggestions.
 */
async function applySuggestions(
  ctx: AppContext,
  params: AssetIngestParams,
  suggestion: { readonly altText?: Record<string, string>; readonly tags?: readonly string[] },
): Promise<boolean> {
  const asset = await currentAsset(ctx, params);
  if (!asset) return false;
  const altText = Object.fromEntries(
    Object.entries(suggestion.altText ?? {}).filter(([l]) => !hasText(asset.metadata.altText[l])),
  );
  const tags = asset.metadata.tags.length === 0 ? (suggestion.tags ?? []) : [];
  if (Object.keys(altText).length === 0 && tags.length === 0) return false;
  const updated = applyAssetMetadata(asset, {
    ...(Object.keys(altText).length > 0
      ? { altText: { ...asset.metadata.altText, ...altText } }
      : {}),
    ...(tags.length > 0 ? { tags } : {}),
  });
  const marks: AssetAiSuggestions = {
    ...(Object.keys(altText).length > 0
      ? {
          altText: [...new Set([...(asset.aiSuggestions?.altText ?? []), ...Object.keys(altText)])],
        }
      : asset.aiSuggestions?.altText
        ? { altText: asset.aiSuggestions.altText }
        : {}),
    ...(tags.length > 0
      ? { tags }
      : asset.aiSuggestions?.tags
        ? { tags: asset.aiSuggestions.tags }
        : {}),
  };
  await ctx.store.assets.save(params.scope, { ...updated, aiSuggestions: marks });
  return true;
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/** Model output as one plain line: control characters and markup brackets out, length capped. */
function plainLine(text: string, max: number): string {
  return Array.from(text.replace(/[<>]/g, ''))
    .map((ch) => (/[\p{Cc}\p{Cf}]/u.test(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * Reads a document's or recording's text into blob storage beside the file (`assetTextKey`). The
 * key is derived from the run's scope and asset, and the bytes read are the asset's own file
 * (`assetFileKey`, validated), so a crafted key can neither be read nor written. Files over the
 * size cap are skipped; text beyond its cap is cut. Nothing goes to D1. The conversion is a model
 * call, metered by the space's AI budget: a spent budget skips it (`budget`). An asset deleted
 * while the model ran leaves no text behind.
 */
export async function extractText(
  ctx: AppContext,
  deps: AssetIngestDeps,
  params: AssetIngestParams,
): Promise<{ chars: number; skipped?: 'unsupported' | 'too-large' | 'budget' }> {
  const asset = await currentAsset(ctx, params);
  if (!asset || !deps.extractor || !deps.blob.open) return { chars: 0, skipped: 'unsupported' };
  const contentType = mimeOf(asset.file.contentType);
  const kind = assetKind(contentType);
  if ((kind !== 'document' && kind !== 'audio') || !deps.extractor.supports(contentType)) {
    return { chars: 0, skipped: 'unsupported' };
  }
  const textKey = assetTextKey(params.scope, params.assetId, params.version);
  if (!textKey) return { chars: 0, skipped: 'unsupported' };
  const cap = kind === 'audio' ? MAX_EXTRACT_AUDIO_BYTES : MAX_EXTRACT_DOCUMENT_BYTES;
  const object = await deps.blob.open(assetFileKey(params.scope, asset));
  if (!object) throw new Error('The file is not in storage');
  if (object.size > cap) {
    await discard(object.body);
    return { chars: 0, skipped: 'too-large' };
  }
  const read = await readCapped(object.body, cap);
  if (!read) return { chars: 0, skipped: 'too-large' };
  const extractor = deps.extractor;
  let raw: string;
  try {
    raw = await runWithBudget(
      ctx,
      params.scope,
      () => extractor.extract({ fileName: asset.file.fileName, contentType, ...read }),
      // No usage comes back: the text's length stands in for the tokens it cost.
      (text) => Math.max(1, Math.ceil(text.length / 4)),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) return { chars: 0, skipped: 'budget' };
    throw err;
  }
  const text = storableText(raw);
  // Deleted meanwhile: its delete already removed what ingest derived, so write nothing; and if
  // it went just after this check, take the text back out.
  if (!(await currentAsset(ctx, params))) return { chars: 0 };
  await deps.blob.put(textKey, text, 'text/markdown; charset=utf-8');
  if (!(await currentAsset(ctx, params))) {
    await deps.blob.delete(textKey);
    return { chars: 0 };
  }
  return { chars: text.length };
}

/**
 * The stream's chunks as they came (never joined: the extractor builds what it sends from them),
 * or `null` once it runs past `cap` (a size the store under-reported).
 */
async function readCapped(
  body: ByteStream,
  cap: number,
): Promise<{ chunks: Uint8Array[]; size: number } | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return { chunks, size };
}

/** Lets go of a body unread (a web stream's iterator cancels the stream when returned). */
async function discard(body: ByteStream): Promise<void> {
  await body[Symbol.asyncIterator]().return?.();
}

/** Extracted text as stored: NULs and other control characters (but line breaks) out, capped. */
function storableText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (out.length >= MAX_EXTRACTED_TEXT_CHARS) break;
    out += ch === '\n' || ch === '\t' || !/\p{Cc}/u.test(ch) ? ch : ' ';
  }
  return out;
}

/**
 * Ready, the published snapshot's measurements, and `asset.ingested`, in one unit. A snapshot
 * published before ingest measured the file (the usual case: publish right after upload) gets
 * the size, dimensions and placeholder ingest found, for the same version only. The event says whether the
 * asset is published, so only then is Delivery's cache purged. `false` when the asset moved on.
 */
export async function finishIngest(
  ctx: AppContext,
  params: AssetIngestParams,
  hashed: HashResult,
): Promise<boolean> {
  const { scope, assetId, version } = params;
  const [asset, published] = await Promise.all([
    currentAsset(ctx, params),
    ctx.store.assets.getPublished(scope, assetId),
  ]);
  if (!asset) return false;
  const measured = {
    ...(asset.file.size !== undefined ? { size: asset.file.size } : {}),
    ...(asset.file.width !== undefined ? { width: asset.file.width } : {}),
    ...(asset.file.height !== undefined ? { height: asset.file.height } : {}),
    ...(asset.file.placeholder ? { placeholder: asset.file.placeholder } : {}),
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.assets.recordIngest(scope, assetId, version, { status: 'ready', error: null });
    if (published && (published.version ?? 1) === version) {
      await tx.assets.recordPublishedFile(scope, assetId, version, measured);
    }
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.ingested',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId,
      version,
      published: published !== null,
      ...(hashed.contentHash ? { contentHash: hashed.contentHash } : {}),
      ...(hashed.duplicateOf ? { duplicateOf: hashed.duplicateOf } : {}),
    });
  });
  return true;
}

export async function failIngest(
  ctx: AppContext,
  params: AssetIngestParams,
  error: string,
): Promise<void> {
  await ctx.store.assets.recordIngest(params.scope, params.assetId, params.version, {
    status: 'error',
    error,
  });
}

/**
 * What a failure says on the asset: its message, on one line, credentials masked (a provider error
 * can quote a URL or a token back), capped. Never a stack.
 */
export function ingestErrorMessage(err: unknown): string {
  const message = redactCredentials(err instanceof Error ? err.message : String(err));
  return plainLine(message, MAX_INGEST_ERROR_CHARS) || 'Ingest failed';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

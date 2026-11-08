import { type Asset, NotFoundError, type Scope, ValidationError } from '@commerceworker/domain';
import type { BlobStore, BulkJob, BulkJobChunk, RemoteFetcher } from '@commerceworker/ports';
import { copyRemoteAsset, TransientCopyError } from './asset-copy';
import { publishAsset } from './assets';
import { type ChainedJob, persistJob } from './bulk-jobs';
import type { AppContext } from './context';
import { importChunkKey } from './job-staging';
import {
  confineSnapshotFiles,
  createSnapshotAsset,
  createSnapshotEntry,
  type EnvironmentSnapshot,
  exportSnapshot,
  type ImportOptions,
  type ImportReport,
  normalizeSnapshotModel,
  prepareSnapshotImport,
  publishSnapshotEntry,
  type StagedSnapshotEntry,
  type StagedSnapshotPublication,
  stagedEntry,
  stagedPublication,
  writeSnapshotModel,
} from './snapshots';

/**
 * Environment import and clone as durable jobs.
 *
 * Replaying a snapshot writes every entry through the use-cases, which for an environment of any
 * size is far more than one request can hold (CPU, and the request's lifetime). So the request
 * does what must be synchronous: every check (`prepareSnapshotImport`, so a bad snapshot is
 * refused before anything is written), then the content model, taxonomy and workflows, which are
 * small and which everything else depends on. The assets and entries are staged in object storage
 * in chunks and written by the bulk-job machinery, which brings resumability, cancellation, the
 * stall sweep and a per-item report.
 *
 * Two jobs, chained. The first creates asset records and entries as drafts. Publishing waits for
 * it to finish, because publishing an entry needs every entry and asset it links to to exist, and
 * chunks run concurrently. When the first job completes, the second (publish what was published,
 * then lay changed entries' drafts on top) starts in the same write that finalizes the first.
 */

/** Items per staged chunk: each is a few use-case calls, so a chunk stays well inside a queue
 *  consumer's limits. */
export const SNAPSHOT_JOB_CHUNK_SIZE = 100;

/** The `config` of a snapshot import job; `phase` says what its chunks do. */
export interface SnapshotJobConfig extends Record<string, unknown> {
  readonly kind: 'snapshot';
  /** `prepare` (a clone's one chunk: export, check, stage, start the create job), `create`,
   *  then `publish`. */
  readonly phase: 'prepare' | 'create' | 'publish';
  /** prepare: the environment to clone, and the ids its create and publish jobs will take. */
  readonly source?: Scope;
  readonly publish?: boolean;
  readonly createJobId?: string;
  readonly publishJobId?: string;
  /**
   * The snapshot's taxonomy ids mapped to the ones the import created (create phase). Entries are
   * staged with the snapshot's ids, before the model is written, and remapped as they are created.
   */
  readonly taxonomyIds?: Readonly<Record<string, string>>;
}

interface CreateChunk {
  readonly assets: readonly Asset[];
  /** Assets whose file is copied from another system as the record is created (see `remoteFiles`). */
  readonly remoteAssets?: readonly { readonly asset: Asset; readonly url: string }[];
  readonly entries: readonly StagedSnapshotEntry[];
}

interface PublishChunk {
  readonly assetIds: readonly string[];
  readonly entries: readonly StagedSnapshotPublication[];
}

export interface StartedSnapshotImport {
  readonly report: ImportReport;
  /** The job creating the assets and entries; null when the snapshot has neither. */
  readonly job: BulkJob | null;
  /** The publishing job that starts when `job` completes; null when nothing is published. */
  readonly publishJobId: string | null;
}

export const isSnapshotJob = (config: unknown): config is SnapshotJobConfig =>
  (config as { kind?: unknown } | undefined)?.kind === 'snapshot';

/**
 * Starts importing a snapshot into `target` as a job. Everything that can refuse it is checked
 * first, exactly as `importSnapshot` does; then the model is written and the rest is staged.
 */
export interface StartSnapshotOptions extends ImportOptions {
  /** The ids the create and publish jobs take (a clone fixes them up front); otherwise new. */
  readonly jobIds?: { readonly create: string; readonly publish: string };
  /**
   * Asset id → the URL its file is copied from, for assets whose bytes are in another system (a
   * space export). Set by the importer that read that file, never from a request: an uploaded
   * snapshot names no URL the server would fetch.
   */
  readonly remoteFiles?: ReadonlyMap<string, string>;
}

export async function startSnapshotImport(
  ctx: AppContext,
  blob: BlobStore,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  options: StartSnapshotOptions = {},
): Promise<StartedSnapshotImport> {
  snapshot = normalizeSnapshotModel(confineSnapshotFiles(target, snapshot, options.filesFrom));
  const { report, publishable } = await prepareSnapshotImport(ctx, target, snapshot, options);
  const publishing = options.publish !== false;

  const createItems = [
    ...snapshot.assets.map((asset) => {
      const url = options.remoteFiles?.get(asset.id);
      return url ? { asset, url } : { asset };
    }),
    // With the snapshot's own taxonomy ids: remapped as each entry is created (see config).
    ...snapshot.entries.map((entry) => ({
      entry: stagedEntry(entry, new Map(), publishing, options.keepCreators),
    })),
  ];
  if (createItems.length === 0) {
    await writeSnapshotModel(ctx, target, snapshot, report.skipped as string[]);
    return { report, job: null, publishJobId: null };
  }

  const publishItems = publishing
    ? [
        ...snapshot.assets.filter((a) => a.status === 'published').map((a) => ({ assetId: a.id })),
        ...publishable.map((entry) => ({ entry: stagedPublication(entry) })),
      ]
    : [];

  const now = ctx.clock.now().toISOString();
  const jobId = options.jobIds?.create ?? ctx.ids.newId();
  // Everything is staged first, before the model is written: a failure while staging leaves the
  // target untouched (still empty, so a retry works), and no chunk can ever be claimed before its
  // work is readable. After the model, the only write left is the job itself.
  const createChunks = await stageChunks(
    blob,
    target,
    jobId,
    createItems,
    itemId,
    (items): CreateChunk => {
      const remoteAssets = items.flatMap((i) =>
        'asset' in i && 'url' in i && i.url ? [{ asset: i.asset, url: i.url }] : [],
      );
      return {
        assets: items.flatMap((i) => ('asset' in i && !('url' in i) ? [i.asset] : [])),
        ...(remoteAssets.length > 0 ? { remoteAssets } : {}),
        entries: items.flatMap((i) => ('entry' in i ? [i.entry] : [])),
      };
    },
  );
  let next: ChainedJob | undefined;
  if (publishItems.length > 0) {
    const publishJobId = options.jobIds?.publish ?? ctx.ids.newId();
    const publishChunks = await stageChunks(
      blob,
      target,
      publishJobId,
      publishItems,
      itemId,
      (items) => ({
        assetIds: items.flatMap((i) => ('assetId' in i ? [i.assetId] : [])),
        entries: items.flatMap((i) => ('entry' in i ? [i.entry] : [])),
      }),
    );
    next = {
      id: publishJobId,
      totalItems: publishItems.length,
      chunkIds: publishChunks.map((c) => c.chunkId),
      config: { kind: 'snapshot', phase: 'publish' } satisfies SnapshotJobConfig,
    };
  }

  const taxonomyIds = await writeSnapshotModel(ctx, target, snapshot, report.skipped as string[]);
  const config: SnapshotJobConfig & { next?: ChainedJob } = {
    kind: 'snapshot',
    phase: 'create',
    taxonomyIds: Object.fromEntries(taxonomyIds),
    ...(next ? { next } : {}),
  };
  const job = await persistJob(
    ctx,
    target,
    {
      id: jobId,
      action: 'import',
      status: 'running',
      totalItems: createItems.length,
      totalChunks: createChunks.length,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now,
      config,
    },
    createChunks,
    now,
  );
  return { report, job, publishJobId: next?.id ?? null };
}

export interface StartedClone {
  /** The prepare job (one chunk): exports the source, checks it, and starts the create job. */
  readonly job: BulkJob;
  /** The create job's id, once the prepare job has started it. */
  readonly createJobId: string;
  /** The publishing job's id, once the create job completes cleanly (if anything is published). */
  readonly publishJobId: string;
}

/**
 * Clones `source` into `target`, entirely as jobs. The request checks only what is cheap (both
 * environments exist, the target holds no content types) and starts a one-chunk prepare job; the
 * engine then exports the source, runs every check, stages the work and writes the model
 * (`startSnapshotImport`), so neither the export (one read per 100 entries) nor validating every
 * entry runs inside the request. A snapshot the checks refuse fails the prepare job, and its
 * report names the problems; nothing is written.
 */
export async function startEnvironmentClone(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  options: ImportOptions = {},
): Promise<StartedClone> {
  await requireEnvironmentExists(ctx, source);
  await requireEnvironmentExists(ctx, target);
  const existing = await ctx.store.contentTypes.list(target);
  if (existing.length > 0) {
    throw new ValidationError([
      {
        field: 'target',
        message: `Target environment "${target.environmentId}" already defines ${existing.length} content type(s); import expects an empty environment`,
      },
    ]);
  }
  const now = ctx.clock.now().toISOString();
  const jobId = ctx.ids.newId();
  const config: SnapshotJobConfig = {
    kind: 'snapshot',
    phase: 'prepare',
    source,
    publish: options.publish !== false,
    createJobId: ctx.ids.newId(),
    publishJobId: ctx.ids.newId(),
  };
  const job = await persistJob(
    ctx,
    target,
    {
      id: jobId,
      action: 'import',
      status: 'running',
      totalItems: 1,
      totalChunks: 1,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now,
      config,
    },
    [
      {
        jobId,
        chunkId: 'c00000',
        entryIds: [PREPARE_ITEM],
        status: 'pending',
        attempts: 0,
        failures: [],
      },
    ],
    now,
  );
  return {
    job,
    createJobId: config.createJobId as string,
    publishJobId: config.publishJobId as string,
  };
}

/** What a prepare job's one item is reported under. */
const PREPARE_ITEM = 'snapshot';

async function requireEnvironmentExists(ctx: AppContext, scope: Scope): Promise<void> {
  if (!(await ctx.store.spaces.getConfig(scope))) throw new NotFoundError('Space', scope.spaceId);
  const envs = await ctx.store.spaces.listEnvironments(scope.spaceId);
  if (!envs.some((e) => e.id === scope.environmentId)) {
    throw new NotFoundError('Environment', `${scope.spaceId}/${scope.environmentId}`);
  }
}

/**
 * Runs a clone's prepare chunk: export the source, then start the import exactly as a request
 * would, under the ids fixed when the clone started. Run again after its create job exists (a
 * crash before the chunk was recorded), it does nothing. A snapshot the checks refuse is the
 * prepare job's one failure, with the problems as its message; anything else throws, so the
 * chunk is retried.
 */
async function runClonePrepare(
  ctx: AppContext,
  blob: BlobStore,
  target: Scope,
  config: SnapshotJobConfig,
): Promise<SnapshotChunkOutcome> {
  const { source, createJobId, publishJobId } = config;
  if (!source || !createJobId || !publishJobId) {
    throw new Error("A clone's prepare job is missing its source or job ids");
  }
  if (await ctx.store.bulkJobs.getJob(target, createJobId)) return { succeeded: 1, failures: [] };
  try {
    await startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source), {
      publish: config.publish !== false,
      jobIds: { create: createJobId, publish: publishJobId },
      filesFrom: source.spaceId,
      keepCreators: true,
    });
    return { succeeded: 1, failures: [] };
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const problems = err.issues.map((i) => i.message).join('; ');
    return { succeeded: 0, failures: [{ id: PREPARE_ITEM, error: problems || err.message }] };
  }
}

/** The id an item is reported under: the asset's or the entry's. */
const itemId = (item: {
  asset?: { id: string };
  assetId?: string;
  entry?: { id: string };
}): string => item.asset?.id ?? item.assetId ?? item.entry?.id ?? '';

/**
 * Splits `items` into staged chunks under `jobId`, returning the chunk rows to persist. Each row
 * lists its items' ids, so a chunk that fails for good reports every one of them as failed.
 */
async function stageChunks<T, P>(
  blob: BlobStore,
  scope: Scope,
  jobId: string,
  items: readonly T[],
  idOf: (item: T) => string,
  toPayload: (items: readonly T[]) => P,
): Promise<BulkJobChunk[]> {
  const chunks: BulkJobChunk[] = [];
  for (let at = 0; at < items.length; at += SNAPSHOT_JOB_CHUNK_SIZE) {
    const chunkId = `c${String(chunks.length).padStart(5, '0')}`;
    const payloadKey = importChunkKey(scope, jobId, chunkId);
    const slice = items.slice(at, at + SNAPSHOT_JOB_CHUNK_SIZE);
    await blob.put(payloadKey, JSON.stringify(toPayload(slice)), 'application/json');
    chunks.push({
      jobId,
      chunkId,
      entryIds: slice.map(idOf),
      payloadKey,
      status: 'pending',
      attempts: 0,
      failures: [],
    });
  }
  return chunks;
}

export interface SnapshotChunkOutcome {
  readonly succeeded: number;
  readonly failures: readonly { id: string; error: string }[];
}

/**
 * Runs one staged chunk of a snapshot import. Each item is attempted on its own, so one bad
 * entry is a reported failure rather than a stalled chunk; every step is safe to run again
 * (see `createSnapshotEntry`, `copyRemoteAsset` and `publishSnapshotEntry`), so a chunk re-run
 * after a crash finishes the job instead of duplicating it. A file download that may succeed
 * later (`TransientCopyError`) fails the whole chunk instead, so it is retried.
 */
export async function runSnapshotChunk(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  config: SnapshotJobConfig,
  payloadKey: string | undefined,
  fetcher?: RemoteFetcher,
): Promise<SnapshotChunkOutcome> {
  if (config.phase === 'prepare') return runClonePrepare(ctx, blob, scope, config);
  if (!payloadKey) throw new Error('A snapshot import chunk is missing its staged work');
  const raw = await blob.get(payloadKey);
  if (raw === null) {
    // Failing the chunk is right: reporting success would claim an import that never happened.
    throw new Error(`Staged work for this chunk is missing (${payloadKey})`);
  }
  let succeeded = 0;
  const failures: { id: string; error: string }[] = [];
  const attempt = async (id: string, work: () => Promise<void>) => {
    try {
      await work();
      succeeded += 1;
    } catch (err) {
      if (err instanceof TransientCopyError) throw err;
      failures.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (config.phase === 'create') {
    const chunk = JSON.parse(raw) as CreateChunk;
    const remap = (id: string) => config.taxonomyIds?.[id] ?? id;
    for (const asset of chunk.assets) {
      await attempt(asset.id, () => createSnapshotAsset(ctx, scope, asset));
    }
    if (chunk.remoteAssets?.length && !fetcher) {
      // A wiring fault, not a bad file: the chunk is released for a consumer that can fetch.
      throw new Error('This consumer has no outbound fetcher to copy asset files with');
    }
    for (const { asset, url } of chunk.remoteAssets ?? []) {
      await attempt(asset.id, () =>
        copyRemoteAsset(ctx, blob, fetcher as RemoteFetcher, scope, asset, url),
      );
    }
    for (const entry of chunk.entries) {
      const remapped = {
        ...entry,
        tags: entry.tags.map(remap),
        concepts: entry.concepts.map(remap),
      };
      await attempt(entry.id, () => createSnapshotEntry(ctx, scope, remapped));
    }
  } else {
    const chunk = JSON.parse(raw) as PublishChunk;
    for (const assetId of chunk.assetIds) {
      await attempt(assetId, async () => {
        const asset = await ctx.store.assets.get(scope, assetId);
        if (asset?.status !== 'published') await publishAsset(ctx, scope, assetId);
      });
    }
    for (const publication of chunk.entries) {
      await attempt(publication.id, () => publishSnapshotEntry(ctx, scope, publication));
    }
  }
  return { succeeded, failures };
}

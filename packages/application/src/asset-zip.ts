import {
  type AssetZipJob,
  type AssetZipSource,
  ConflictError,
  MAX_ZIP_ASSETS,
  NotFoundError,
  type Scope,
  ValidationError,
  ZIP_RETENTION_SECONDS,
  zipFileName,
} from '@commerceworker/domain';
import type {
  AssetZipParams,
  BlobStore,
  MultipartBlobStore,
  UploadedPart,
  WorkflowSteps,
} from '@commerceworker/ports';
import { assetFileKey, READ_URL_TTL_SECONDS } from './assets';
import type { AppContext } from './context';
import {
  Crc32,
  planZip,
  uniqueZipNames,
  type ZipPlan,
  zipDescriptorBytes,
  zipDirectoryBytes,
  zipPartSegments,
} from './zip';

/**
 * Zip downloads: a selection's or a collection's current files in one archive, built by the
 * engine's `AssetZipWorkflow` into blob storage under `zips/` (a reserved prefix: no space can be
 * named `zips`, and no media URL serves it), then handed out as a short-lived signed URL.
 *
 * The archive is written as an R2 multipart upload, one Workflow step per part. Its layout is
 * fixed by the files' sizes ({@link planZip}), so each step builds one part (at most
 * {@link ZIP_PART_BYTES} in memory, never the archive) from ranged reads of the files it covers,
 * and passes on only a running CRC-32. A retried step writes the same part again.
 */

/**
 * Every part but the last is this long (R2 needs them equal; 5 MiB at least). The one buffer a
 * step holds, so several builds can share an isolate's 128 MB.
 */
export const ZIP_PART_BYTES = 8 * 1024 * 1024;
/** Largest archive one job builds (a part per step: 2,560 steps at this size, of 10,000). */
export const MAX_ZIP_BYTES = 20 * 1024 * 1024 * 1024;

/** Where a job's archive is: under the reserved `zips/` prefix, named for download. */
export function zipObjectKey(scope: Scope, job: Pick<AssetZipJob, 'id' | 'fileName'>): string {
  return `zips/${scope.spaceId}/${scope.environmentId}/${job.id}/${job.fileName}`;
}

/** Where a job's plan is kept while it builds (beside the archive; removed once it is built). */
export function zipPlanKey(scope: Scope, job: Pick<AssetZipJob, 'id'>): string {
  return `zips/${scope.spaceId}/${scope.environmentId}/${job.id}/plan.json`;
}

/** Most zips one environment builds at once (pending or running); another is a 409. */
export const MAX_ACTIVE_ZIPS = 3;

/** Asks for a zip of a selection of assets, or of a collection's members. */
export interface RequestAssetZipInput {
  readonly assetIds?: readonly string[];
  readonly collectionId?: string;
  /** The archive's name (`.zip` is added). */
  readonly name?: string;
}

/**
 * Starts a zip download: the job and its `asset_zip.requested` event commit in one unit, and the
 * engine starts the Workflow that builds it. Progress is the job's ({@link getAssetZip}).
 */
export async function requestAssetZip(
  ctx: AppContext,
  scope: Scope,
  input: RequestAssetZipInput,
  opts: { readonly createdBy?: string } = {},
): Promise<AssetZipJob> {
  let source: AssetZipSource;
  let fallbackName = 'assets';
  if (input.collectionId !== undefined && input.assetIds !== undefined) {
    throw new ValidationError([
      { field: 'assetIds', message: 'Zip a selection or a collection, not both' },
    ]);
  }
  if (input.collectionId !== undefined) {
    const collection = await ctx.store.assetCollections.get(scope, input.collectionId);
    if (!collection) throw new NotFoundError('AssetCollection', input.collectionId);
    if (collection.itemCount === 0) {
      throw new ValidationError([{ field: 'collectionId', message: 'The collection is empty' }]);
    }
    source = { kind: 'collection', collectionId: collection.id };
    fallbackName = collection.name;
  } else {
    const ids = [...new Set(input.assetIds ?? [])];
    if (ids.length === 0 || ids.length > MAX_ZIP_ASSETS) {
      throw new ValidationError([
        { field: 'assetIds', message: `Zip between 1 and ${MAX_ZIP_ASSETS} assets` },
      ]);
    }
    source = { kind: 'selection', assetIds: ids };
  }
  // Each job reads every file and writes an archive kept a day: a scope runs a few at a time.
  const active = (await ctx.store.assetZips.list(scope, MAX_ZIP_JOBS_LISTED)).filter(
    (j) => j.status === 'pending' || j.status === 'running',
  );
  if (active.length >= MAX_ACTIVE_ZIPS) {
    throw new ConflictError(
      `${MAX_ACTIVE_ZIPS} zips are already being built here; wait for one to finish`,
    );
  }
  const now = ctx.clock.now();
  const job: AssetZipJob = {
    id: ctx.ids.newId(),
    status: 'pending',
    source,
    fileName: zipFileName(input.name, fallbackName),
    partsDone: 0,
    createdAt: now.toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    expiresAt: new Date(now.getTime() + ZIP_RETENTION_SECONDS * 1000).toISOString(),
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.assetZips.create(scope, job);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset_zip.requested',
      scope,
      occurredAt: now.toISOString(),
      jobId: job.id,
    });
  });
  return job;
}

/**
 * A zip job, with a short-lived signed download URL once its archive is built (and until it
 * expires).
 */
export async function getAssetZip(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
): Promise<AssetZipJob> {
  const job = await ctx.store.assetZips.get(scope, id);
  if (!job) throw new NotFoundError('AssetZip', id);
  if (job.status !== 'completed' || Date.parse(job.expiresAt) <= ctx.clock.now().getTime()) {
    return job;
  }
  const downloadUrl = await blob.getDownloadUrl(zipObjectKey(scope, job), {
    expiresInSeconds: READ_URL_TTL_SECONDS,
  });
  return { ...job, downloadUrl };
}

/** Most zip jobs a listing returns. */
export const MAX_ZIP_JOBS_LISTED = 50;

/** The scope's recent zip jobs, newest first (no download URLs: get one job for that). */
export async function listAssetZips(ctx: AppContext, scope: Scope): Promise<AssetZipJob[]> {
  return ctx.store.assetZips.list(scope, MAX_ZIP_JOBS_LISTED);
}

/** What the plan step finds: the layout, and how many assets had no file to put in it. */
interface PlannedZip {
  readonly plan: ZipPlan;
  readonly skipped: number;
}

/** The asset ids a job zips, in order (a collection holds at most {@link MAX_ZIP_ASSETS}). */
async function zipAssetIds(ctx: AppContext, scope: Scope, source: AssetZipSource) {
  if (source.kind === 'selection') return [...source.assetIds];
  const ids = await ctx.store.assetCollections.listItemIds(scope, source.collectionId);
  return ids.slice(0, MAX_ZIP_ASSETS);
}

/**
 * Lays the archive out from the assets' current files: one entry per asset with bytes (a hosted
 * video has none here, and a file whose upload never landed is left out), named for its file and
 * made unique. Throws when there is nothing to zip or the archive would pass {@link MAX_ZIP_BYTES}.
 */
async function planAssetZip(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  job: AssetZipJob,
): Promise<PlannedZip> {
  if (!blob.head) throw new Error('blob storage cannot measure files');
  const ids = await zipAssetIds(ctx, scope, job.source);
  const byId = new Map((await ctx.store.assets.getMany(scope, ids)).map((a) => [a.id, a]));
  const files: { name: string; key: string; size: number }[] = [];
  let skipped = 0;
  for (const id of ids) {
    const asset = byId.get(id);
    if (!asset || asset.file.video) {
      skipped += 1;
      continue;
    }
    const key = assetFileKey(scope, asset);
    // The size ingest measured, from the row: no read per file (a collection of a thousand icons
    // would be a thousand). A file without one (never measured) is looked at. A size that is wrong
    // fails the build when its bytes are read (`changed or went away`), never a corrupt archive.
    if (asset.file.size !== undefined && asset.ingestStatus === 'ready') {
      files.push({ name: asset.file.fileName, key, size: asset.file.size });
      continue;
    }
    const head = await blob.head(key);
    if (!head) {
      skipped += 1;
      continue;
    }
    files.push({ name: asset.file.fileName, key, size: head.size });
  }
  if (files.length === 0) throw new ZipFailure('None of the selected assets has a file to zip');
  const names = uniqueZipNames(files.map((f) => f.name));
  const plan = planZip(
    files.map((f, i) => ({ ...f, name: names[i] ?? f.name })),
    new Date(job.createdAt),
  );
  if (plan.length > MAX_ZIP_BYTES) {
    throw new ZipFailure(
      `The archive would be ${plan.length} bytes; a zip holds at most ${MAX_ZIP_BYTES}`,
    );
  }
  return { plan, skipped };
}

/** A reason the job can't succeed, said to the person who asked (never retried into success). */
export class ZipFailure extends Error {}

/** What one part's step hands the next: its etag, and the CRCs it finished or carries on. */
interface PartResult {
  readonly part: UploadedPart;
  /** Entries whose bytes ended in this part: [index, CRC]. */
  readonly finished: readonly (readonly [number, number])[];
  /** The entry whose bytes run on into the next part, and its CRC so far. */
  readonly carry?: readonly [number, number];
}

/**
 * Builds part `index` (0-based) of the archive in one pass, in order: local headers as they are,
 * file slices read by range (each checked against the planned length, its CRC run on from `carry`
 * or from 0 at the file's start), then each descriptor once its file's CRC is known, and the
 * central directory once every CRC is (`crcs` holds those of earlier parts).
 */
async function writePart(
  blob: BlobStore,
  multipart: MultipartBlobStore,
  key: string,
  uploadId: string,
  plan: ZipPlan,
  index: number,
  partBytes: number,
  crcs: ReadonlyMap<number, number>,
  carry: readonly [number, number] | undefined,
): Promise<PartResult> {
  if (!blob.openRange) throw new Error('blob storage cannot read ranges');
  const start = index * partBytes;
  const end = Math.min(plan.length, start + partBytes);
  const buffer = new Uint8Array(end - start);
  const known = new Map(crcs);
  // An empty file has no bytes to read: its CRC is 0.
  plan.entries.forEach((e, i) => {
    if (e.size === 0) known.set(i, 0);
  });
  const finished: [number, number][] = [];
  let running = carry;
  let at = 0;
  const put = (bytes: Uint8Array) => {
    buffer.set(bytes, at);
    at += bytes.byteLength;
  };
  for (const segment of zipPartSegments(plan, start, end)) {
    if (segment.kind === 'bytes') {
      put(segment.bytes);
    } else if (segment.kind === 'directory') {
      put(zipDirectoryBytes(plan, known).subarray(segment.from, segment.from + segment.length));
    } else if (segment.kind === 'descriptor') {
      const crc = known.get(segment.entry);
      if (crc === undefined) throw new Error(`zip entry ${segment.entry} has no CRC`);
      const bytes = zipDescriptorBytes(plan, segment.entry, crc);
      put(bytes.subarray(segment.from, segment.from + segment.length));
    } else {
      const entry = plan.entries[segment.entry];
      if (!entry) throw new Error(`zip entry ${segment.entry} is not in the plan`);
      const object = await blob.openRange(entry.key, segment.from, segment.length);
      if (!object || object.size !== entry.size) {
        throw new ZipFailure(`"${entry.name}" changed or went away while the zip was being built`);
      }
      let crc = 0;
      if (segment.from > 0) {
        if (running?.[0] !== segment.entry) {
          throw new Error(`zip entry ${segment.entry} lost its running CRC`);
        }
        crc = running[1];
      }
      let read = 0;
      for await (const chunk of object.body) {
        if (read + chunk.byteLength > segment.length) throw new ZipFailure(`"${entry.name}" grew`);
        crc = Crc32.update(chunk, crc);
        buffer.set(chunk, at + read);
        read += chunk.byteLength;
      }
      if (read !== segment.length) throw new ZipFailure(`"${entry.name}" came back short`);
      at += read;
      if (segment.from + segment.length === entry.size) {
        known.set(segment.entry, crc);
        finished.push([segment.entry, crc]);
        running = undefined;
      } else {
        running = [segment.entry, crc];
      }
    }
  }
  if (at !== buffer.byteLength) {
    throw new Error(`zip part ${index + 1} is ${at} bytes, not ${buffer.byteLength}`);
  }
  const part = await multipart.uploadPart(key, uploadId, index + 1, buffer);
  return { part, finished, ...(running ? { carry: running } : {}) };
}

const STEP_RETRIES = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
} as const;

/** A step's outcome: its value, or a {@link ZipFailure}'s reason (returned, so never retried). */
type Settled<T> = { readonly ok: T } | { readonly failed: string };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: await fn() };
  } catch (err) {
    if (err instanceof ZipFailure) return { failed: err.message };
    throw err;
  }
}

/** The value of a settled step, or its failure thrown again outside it. */
function unwrap<T>(settled: Settled<T>): T {
  if ('failed' in settled) throw new ZipFailure(settled.failed);
  return settled.ok;
}

/** Most of an error a failed job keeps (it is shown to the person who asked). */
const MAX_ZIP_ERROR = 300;

/**
 * The `AssetZipWorkflow` body: plan, start the upload, one step per part, complete. Every effect
 * is inside a step, so a replay after a crash redoes nothing a finished step did. A failure (after
 * a step's retries) aborts the upload and marks the job failed with a short reason.
 */
export async function runAssetZip(
  steps: WorkflowSteps,
  ctx: AppContext,
  blob: BlobStore,
  params: AssetZipParams,
  options: { readonly partBytes?: number } = {},
): Promise<{ readonly status: 'completed' | 'failed' | 'gone'; readonly parts?: number }> {
  const { scope, jobId } = params;
  const partBytes = options.partBytes ?? ZIP_PART_BYTES;
  const multipart = blob.multipart;
  const job = await steps.do('load job', async () => ctx.store.assetZips.get(scope, jobId));
  if (!job) return { status: 'gone' };
  if (job.status === 'completed' || job.status === 'failed') return { status: job.status };
  let uploadId: string | undefined;
  let key = '';
  try {
    if (!multipart) throw new ZipFailure('Zip downloads are not available on this deployment');
    // A ZipFailure (nothing to zip, a file that changed) can't succeed on a retry: the step
    // returns it as its result, and it is thrown again out here.
    // The plan can be larger than a step's result may be (1 MiB: a thousand long file names), so
    // it is kept beside the archive and each step reads it back; the step returns its size only.
    const planKey = zipPlanKey(scope, job);
    const planned = unwrap(
      await steps.do('plan', STEP_RETRIES, () =>
        settle(async () => {
          const p = await planAssetZip(ctx, blob, scope, job);
          await blob.put(planKey, JSON.stringify(p.plan), 'application/json');
          await ctx.store.assetZips.update(scope, jobId, {
            status: 'running',
            fileCount: p.plan.entries.length,
            totalBytes: p.plan.length,
            partCount: Math.ceil(p.plan.length / partBytes),
            partsDone: 0,
          });
          return { length: p.plan.length, files: p.plan.entries.length, skipped: p.skipped };
        }),
      ),
    );
    let cached: ZipPlan | undefined;
    const readPlan = async (): Promise<ZipPlan> => {
      if (cached) return cached;
      const raw = await blob.get(planKey);
      if (raw === null) throw new Error('the zip plan is missing');
      cached = JSON.parse(raw) as ZipPlan;
      return cached;
    };
    key = zipObjectKey(scope, job);
    const started = await steps.do('start upload', STEP_RETRIES, async () =>
      multipart.create(key, 'application/zip'),
    );
    uploadId = started.uploadId;
    const partCount = Math.ceil(planned.length / partBytes);
    const crcs = new Map<number, number>();
    const parts: UploadedPart[] = [];
    let carry: readonly [number, number] | undefined;
    for (let i = 0; i < partCount; i++) {
      const id = uploadId;
      const before = new Map(crcs);
      const prior = carry;
      const result = unwrap(
        await steps.do(`part ${i + 1}`, STEP_RETRIES, () =>
          settle(async () => {
            const plan = await readPlan();
            const r = await writePart(blob, multipart, key, id, plan, i, partBytes, before, prior);
            await ctx.store.assetZips.update(scope, jobId, { partsDone: i + 1 });
            return r;
          }),
        ),
      );
      for (const [entry, crc] of result.finished) crcs.set(entry, crc);
      carry = result.carry;
      parts.push(result.part);
    }
    const id = uploadId;
    await steps.do('complete', STEP_RETRIES, async () => {
      try {
        await multipart.complete(key, id, parts);
      } catch (err) {
        // A retry of a step whose complete did land (R2 has no such upload any more): the archive
        // is there, at its planned length, so carry on to recording it.
        const there = await blob.head?.(key);
        if (there?.size !== planned.length) throw err;
      }
      await blob.delete(planKey);
      await ctx.store.assetZips.update(scope, jobId, {
        status: 'completed',
        completedAt: ctx.clock.now().toISOString(),
      });
    });
    return { status: 'completed', parts: partCount };
  } catch (err) {
    const reason =
      err instanceof ZipFailure ? err.message : 'The zip could not be built; try again';
    const id = uploadId;
    await steps.do('fail', STEP_RETRIES, async () => {
      if (id && multipart) await multipart.abort(key, id);
      await ctx.store.assetZips.update(scope, jobId, {
        status: 'failed',
        error: reason.slice(0, MAX_ZIP_ERROR),
      });
    });
    return { status: 'failed' };
  }
}

/** Most expired archives one sweep removes. */
export const ZIP_SWEEP_LIMIT = 100;

/**
 * Removes archives past their expiry (a day after they were asked for) and their jobs, across
 * every space. The bucket's lifecycle rule on `zips/` is the backstop for a sweep that never ran.
 */
export async function sweepExpiredZips(
  ctx: AppContext,
  blob: BlobStore,
  opts: { readonly limit?: number } = {},
): Promise<{ readonly removed: number; readonly failed: number }> {
  const expired = await ctx.store.assetZips.listExpired(
    ctx.clock.now(),
    opts.limit ?? ZIP_SWEEP_LIMIT,
  );
  let removed = 0;
  let failed = 0;
  for (const { scope, id } of expired) {
    try {
      // The job's whole prefix: its archive, whatever it was named.
      await blob.deletePrefix?.(`zips/${scope.spaceId}/${scope.environmentId}/${id}/`, () => false);
      await ctx.store.assetZips.delete(scope, id);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

import {
  type Asset,
  AssetInUseError,
  ConflictError,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type {
  AssetIngestQueue,
  AssetUpload,
  BlobStore,
  MultipartBlobStore,
  UploadedPart,
} from '@commerceworker/ports';
import {
  assetFileKey,
  assetKeyAttempt,
  assetKeyVersion,
  type CommitAssetFileInput,
  type CreateAssetInput,
  commitStoredReplacement,
  createUploadDraft,
  deleteAbandonedAsset,
  prepareReplacement,
  prepareUploadDraft,
  withReadUrl,
} from './assets';
import type { AppContext } from './context';

/**
 * Multipart uploads, for files past what one signed PUT takes (100 MiB, the Workers request-body
 * cap). The api starts an R2 multipart upload for a new draft, signs a URL per part (each bound to
 * its upload, number and exact length), and completes it with the parts' etags; completing starts
 * ingest exactly as a finished single PUT does. The key is minted the same way as a single PUT's
 * ({@link prepareUploadDraft}), so it obeys the same rules.
 *
 * A file replacement past one PUT goes the same way ({@link startMultipartAssetFileReplacement}):
 * its upload is for the next version's key, its attempt's own, and completing it commits that
 * version in the same unit a single-PUT replacement's commit uses. Which kind an upload is, its key
 * says: version 1 is a new asset's, any later one a replacement's.
 *
 * An upload left unfinished is aborted by the hourly sweep a day on ({@link
 * sweepAbandonedMultipartUploads}), and by the bucket's lifecycle rule after that; its draft goes
 * with the abandoned-upload sweep.
 */

/** What one signed PUT takes; above it a client must upload in parts. */
export const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** Default cap on one file (ASSET_UPLOAD_MAX_BYTES overrides it). */
export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
/** R2's smallest part (every part but the last), and the size this server asks for at least. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
/** R2 takes at most this many parts. */
export const MAX_PARTS = 10_000;
/** Most part URLs one call signs. */
export const MAX_PART_URLS = 100;
/** How long an unfinished multipart upload is kept before the sweep aborts it. */
export const ABANDONED_MULTIPART_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The part size and count for a file of `size` bytes: {@link DEFAULT_PART_BYTES}, or larger (a
 * whole MiB) when that would need more than {@link MAX_PARTS} parts. Every part but the last has
 * exactly `partSize` bytes.
 */
export function multipartPlan(size: number): { partSize: number; partCount: number } {
  const mib = 1024 * 1024;
  const partSize = Math.max(DEFAULT_PART_BYTES, Math.ceil(size / MAX_PARTS / mib) * mib);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

const partCountOf = (upload: Pick<AssetUpload, 'size' | 'partSize'>) =>
  Math.max(1, Math.ceil(upload.size / upload.partSize));

/** The exact length of part `n` (1-based) of an upload: `partSize`, but the last part's rest. */
export function partLength(upload: Pick<AssetUpload, 'size' | 'partSize'>, n: number): number {
  const count = partCountOf(upload);
  return n < count ? upload.partSize : upload.size - upload.partSize * (count - 1);
}

function multipartOf(blob: BlobStore): MultipartBlobStore {
  if (!blob.multipart) {
    throw new ValidationError([
      { field: 'size', message: 'Multipart uploads are not available on this deployment' },
    ]);
  }
  return blob.multipart;
}

export interface MultipartUploadStarted {
  readonly asset: Asset;
  readonly upload: {
    readonly uploadId: string;
    readonly partSize: number;
    readonly partCount: number;
  };
}

/**
 * Creates a draft asset and starts a multipart upload of its file: `size` bytes, at most the
 * deployment's cap ({@link DEFAULT_MAX_UPLOAD_BYTES} unless ASSET_UPLOAD_MAX_BYTES says). Then sign
 * part URLs ({@link signAssetUploadParts}), PUT each part, and complete it.
 */
export async function startMultipartAssetUpload(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput & { readonly size: number },
  opts: { readonly createdBy?: string; readonly folderId?: string } = {},
): Promise<MultipartUploadStarted> {
  assertUploadSize(ctx, input.size);
  const multipart = multipartOf(blob);
  const { size, ...rest } = input;
  const { asset, key, contentType } = await prepareUploadDraft(ctx, blob, scope, rest, opts);
  const { partSize, partCount } = multipartPlan(size);
  await createUploadDraft(ctx, scope, asset);
  const { uploadId } = await multipart.create(key, contentType);
  await ctx.store.assetUploads.create(scope, {
    assetId: asset.id,
    uploadId,
    r2Key: key,
    size,
    partSize,
    contentType,
    createdAt: ctx.clock.now().toISOString(),
  });
  return { asset, upload: { uploadId, partSize, partCount } };
}

/** Never past what 10,000 parts of one request each (100 MiB) can carry, whatever is configured. */
function assertUploadSize(ctx: AppContext, size: number): void {
  const max = Math.min(
    ctx.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    MAX_PARTS * SINGLE_UPLOAD_MAX_BYTES,
  );
  if (!Number.isSafeInteger(size) || size < 1 || size > max) {
    throw new ValidationError([
      {
        field: 'size',
        message: `A file is 1 byte to ${max} bytes (${Math.floor(max / 2 ** 20)} MiB)`,
      },
    ]);
  }
}

export interface MultipartReplacementStarted extends MultipartUploadStarted {
  /** The version completing the upload makes current. */
  readonly version: number;
}

/**
 * Starts replacing an asset's file with a multipart upload, for a file past one signed PUT: the
 * same checks as {@link replaceAssetFile} (no hosted video, the `asset:beforeCreate` policy, the
 * next version's key, this attempt's own), and the size cap of a new multipart upload. Then sign
 * parts and complete as for a new asset; completing commits the version, unless another replace or
 * restore took it first. Nothing changes before that.
 */
export async function startMultipartAssetFileReplacement(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  input: { readonly fileName: string; readonly contentType: string; readonly size: number },
): Promise<MultipartReplacementStarted> {
  assertUploadSize(ctx, input.size);
  const multipart = multipartOf(blob);
  const { asset, key, commit } = await prepareReplacement(ctx, scope, id, input);
  const { partSize, partCount } = multipartPlan(input.size);
  const { uploadId } = await multipart.create(key, commit.contentType);
  await ctx.store.assetUploads.create(scope, {
    assetId: id,
    uploadId,
    r2Key: key,
    size: input.size,
    partSize,
    contentType: commit.contentType,
    createdAt: ctx.clock.now().toISOString(),
  });
  return { asset, upload: { uploadId, partSize, partCount }, version: commit.version };
}

/** What committing a replacement upload needs, read from its key (`…/v<n>/file-<attempt>/<name>`). */
function replacementOf(upload: AssetUpload): CommitAssetFileInput | null {
  const version = assetKeyVersion(upload.r2Key, upload.assetId);
  if (version === null || version <= 1) return null;
  const attempt = assetKeyAttempt(upload.r2Key);
  return {
    version,
    fileName: upload.r2Key.slice(upload.r2Key.lastIndexOf('/') + 1),
    contentType: upload.contentType,
    ...(attempt ? { attempt } : {}),
  };
}

async function uploadOrThrow(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  uploadId: string,
): Promise<AssetUpload> {
  const upload = await ctx.store.assetUploads.get(scope, assetId, uploadId);
  if (!upload) throw new NotFoundError('AssetUpload', uploadId);
  return upload;
}

export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
  /** The exact length the PUT must carry. */
  readonly length: number;
  readonly expiresAt: string;
}

/**
 * Signs upload URLs for parts of an upload in progress (at most {@link MAX_PART_URLS} per call;
 * a part may be signed again to retry it). Each URL takes exactly that part's length.
 */
export async function signAssetUploadParts(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  assetId: string,
  uploadId: string,
  partNumbers: readonly number[],
): Promise<{ readonly parts: readonly SignedPart[] }> {
  const upload = await uploadOrThrow(ctx, scope, assetId, uploadId);
  const count = partCountOf(upload);
  const numbers = [...new Set(partNumbers)];
  if (
    numbers.length === 0 ||
    numbers.length > MAX_PART_URLS ||
    numbers.some((n) => !Number.isInteger(n) || n < 1 || n > count)
  ) {
    throw new ValidationError([
      {
        field: 'partNumbers',
        message: `Name 1 to ${MAX_PART_URLS} parts, each from 1 to ${count}`,
      },
    ]);
  }
  const multipart = multipartOf(blob);
  const parts = await Promise.all(
    numbers.map(async (n) => {
      const length = partLength(upload, n);
      const signed = await multipart.partUrl(upload.r2Key, uploadId, n, length);
      return { partNumber: n, url: signed.url, length, expiresAt: signed.expiresAt };
    }),
  );
  return { parts };
}

/**
 * Completes an upload with every part's etag (parts 1..n, each once). The object then exists at
 * the asset's key, and ingest starts as it does for a finished single PUT. A replacement's upload
 * also commits its version, in the unit a single-PUT commit uses, which forgets the upload too
 * (ingest then starts from `asset.file_replaced`). Returns the asset, with a short-lived read URL.
 */
export async function completeMultipartAssetUpload(
  ctx: AppContext,
  deps: { readonly blob: BlobStore; readonly ingest?: AssetIngestQueue },
  scope: Scope,
  assetId: string,
  uploadId: string,
  parts: readonly UploadedPart[],
  opts: { readonly by?: string } = {},
): Promise<Asset> {
  const upload = await ctx.store.assetUploads.get(scope, assetId, uploadId);
  if (!upload) {
    // Completed already (a retry whose first answer was lost): the file is there, so the answer is
    // the same asset, not a 404 that would make a client upload it all again.
    const asset = await ctx.store.assets.get(scope, assetId);
    if (asset && deps.blob.head && (await deps.blob.head(assetFileKey(scope, asset)))) {
      return withReadUrl(deps.blob, scope, asset);
    }
    throw new NotFoundError('AssetUpload', uploadId);
  }
  const count = partCountOf(upload);
  const numbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (
    numbers.length !== count ||
    numbers.some((n, i) => n !== i + 1) ||
    parts.some((p) => typeof p.etag !== 'string' || p.etag === '')
  ) {
    throw new ValidationError([
      { field: 'parts', message: `Name each of parts 1 to ${count} once, with its etag` },
    ]);
  }
  const asset = await ctx.store.assets.get(scope, assetId);
  if (!asset) throw new NotFoundError('Asset', assetId);
  const replacement = replacementOf(upload);
  if (replacement && (asset.version ?? 1) >= replacement.version) {
    // Another replace or restore took this version first: completing could only store bytes nobody
    // will commit, so the upload is dropped instead.
    await multipartOf(deps.blob).abort(upload.r2Key, uploadId);
    await ctx.store.assetUploads.delete(scope, assetId, uploadId);
    throw new ConflictError(
      `Asset "${assetId}"'s file was replaced meanwhile (it is on version ${asset.version ?? 1} now); replace it again`,
      { version: asset.version ?? 1 },
    );
  }
  let etag: string | undefined;
  try {
    etag = (await multipartOf(deps.blob).complete(upload.r2Key, uploadId, parts)).etag;
  } catch (err) {
    // Completed by an earlier attempt whose row delete failed: the object is there at its size.
    const there = await deps.blob.head?.(upload.r2Key);
    if (there?.size === upload.size) {
      etag = there.etag;
    } else if (PART_ERROR.test(String(err))) {
      // A part never uploaded, an etag that isn't its part's, or uneven parts: R2 keeps the
      // upload, so the client can upload the part again and retry.
      throw new ValidationError([
        {
          field: 'parts',
          message: `The upload could not be completed: ${String(err).slice(0, 200)}`,
        },
      ]);
    } else {
      throw err;
    }
  }
  if (replacement) {
    try {
      const next = await commitStoredReplacement(ctx, deps.blob, scope, asset, replacement, {
        ...(opts.by ? { by: opts.by } : {}),
        inUnit: (tx) => tx.assetUploads.delete(scope, assetId, uploadId),
      });
      return withReadUrl(deps.blob, scope, next);
    } catch (err) {
      // Lost the race at commit: the upload is complete, so nothing is left to resume, and its
      // bytes, at this attempt's own key, will never be committed.
      if (err instanceof ConflictError) {
        await ctx.store.assetUploads.delete(scope, assetId, uploadId);
        await deps.blob.delete(upload.r2Key);
      }
      throw err;
    }
  }
  await ctx.store.assetUploads.delete(scope, assetId, uploadId);
  // The same notice a finished signed PUT sends: ingest names the bytes by their etag, so R2's
  // own notification of the completion starts no second run.
  if (deps.ingest) {
    await deps.ingest.objectCreated(upload.r2Key, etag).catch((err: unknown) => {
      console.error('upload ingest notice failed', { key: upload.r2Key, error: String(err) });
    });
  }
  return withReadUrl(deps.blob, scope, asset);
}

/** R2's refusals that name a part (InvalidPart, EntityTooSmall, NoSuchUpload): the client's to fix. */
const PART_ERROR = /InvalidPart|EntityTooSmall|NoSuchUpload|1002[45]|10011|10048|same size|part/i;

/**
 * Abandons an upload: its parts are discarded and, while it still has no bytes and nothing links
 * to it, its draft is deleted too. Aborting an upload already gone changes nothing.
 */
export async function abortMultipartAssetUpload(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  assetId: string,
  uploadId: string,
): Promise<void> {
  const upload = await uploadOrThrow(ctx, scope, assetId, uploadId);
  await multipartOf(blob).abort(upload.r2Key, uploadId);
  await ctx.store.assetUploads.delete(scope, assetId, uploadId);
  // A replacement's: the asset keeps the file it has.
  if (replacementOf(upload)) return;
  const asset = await ctx.store.assets.get(scope, assetId);
  if (asset?.status !== 'draft' || asset.file.size !== undefined) return;
  if (blob.head && (await blob.head(upload.r2Key))) return;
  try {
    await deleteAbandonedAsset(ctx, scope, assetId);
  } catch (err) {
    // Linked meanwhile: the draft stays (the abandoned-upload sweep marks it), the upload is gone.
    if (!(err instanceof AssetInUseError || err instanceof NotFoundError)) throw err;
  }
}

/** Most unfinished uploads one sweep aborts. */
export const ABANDONED_MULTIPART_SWEEP_LIMIT = 100;

/**
 * Aborts multipart uploads started more than {@link ABANDONED_MULTIPART_TTL_MS} ago that were
 * never completed or aborted, across every space (R2 keeps, and bills, their parts until then;
 * the bucket's lifecycle rule is the backstop). Each is forgotten once aborted, so a rerun finds
 * the rest. Their drafts go with the abandoned-upload sweep.
 */
export async function sweepAbandonedMultipartUploads(
  ctx: AppContext,
  blob: BlobStore,
  opts: { readonly ttlMs?: number; readonly limit?: number } = {},
): Promise<{ readonly aborted: number; readonly failed: number }> {
  if (!blob.multipart) return { aborted: 0, failed: 0 };
  const before = new Date(ctx.clock.now().getTime() - (opts.ttlMs ?? ABANDONED_MULTIPART_TTL_MS));
  const stale = await ctx.store.assetUploads.listStartedBefore(
    before,
    opts.limit ?? ABANDONED_MULTIPART_SWEEP_LIMIT,
  );
  let aborted = 0;
  let failed = 0;
  for (const { scope, upload } of stale) {
    try {
      await blob.multipart.abort(upload.r2Key, upload.uploadId);
      await ctx.store.assetUploads.delete(scope, upload.assetId, upload.uploadId);
      aborted += 1;
    } catch {
      failed += 1;
    }
  }
  return { aborted, failed };
}

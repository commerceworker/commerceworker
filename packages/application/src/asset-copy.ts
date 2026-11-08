import type { Asset, Scope } from '@commerceworker/domain';
import type { BlobStore, RemoteFetcher, RemoteFile } from '@commerceworker/ports';
import { assetObjectKey } from './assets';
import type { AppContext } from './context';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Copying an asset's file from another system's URL into this deployment's object storage, for
 * an import that brings assets with it (a space export). The bytes come through the outbound
 * fetcher (GET only, no redirects, size-capped) after the URL passes the SSRF guard, land under the
 * asset's own key, and only then is the record written: a record never points at a file that
 * isn't there. Ingest picks the asset up when the import's create job completes (as for any
 * snapshot import), so hashing, dimensions, placeholders and search happen the usual way.
 */

/**
 * Largest file copied. The bytes are held in memory while they are written (a Worker has 128 MB),
 * so a larger file is reported for uploading by hand rather than risking the whole chunk.
 */
export const ASSET_COPY_MAX_BYTES = 50 * 1024 * 1024;

/** How long one download may take. */
const ASSET_COPY_TIMEOUT_MS = 60_000;

/**
 * A failure worth running the chunk again for: the origin was unreachable, timed out, or
 * answered 5xx or 429. The bulk-job machinery retries the chunk (every step of which is safe to
 * repeat) and, after its attempts, reports it failed.
 */
export class TransientCopyError extends Error {}

/**
 * Creates `asset` (a draft, keeping its id) with its file copied from `url`. Safe to run again: an
 * asset already created counts as done, and a crash between the write and the record leaves only
 * the object, which the re-run writes over.
 */
export async function copyRemoteAsset(
  ctx: AppContext,
  blob: BlobStore,
  fetcher: RemoteFetcher,
  scope: Scope,
  asset: Asset,
  url: string,
): Promise<void> {
  if (await ctx.store.assets.get(scope, asset.id)) return;
  assertSafeExternalUrl(url, 'file.url');
  if ((asset.file.size ?? 0) > ASSET_COPY_MAX_BYTES) {
    throw new Error(
      `The file is ${asset.file.size} bytes; files over ${ASSET_COPY_MAX_BYTES} are not copied. Upload it to this asset by hand.`,
    );
  }
  let file: RemoteFile;
  try {
    file = await fetcher.getBytes(url, {
      maxBytes: ASSET_COPY_MAX_BYTES,
      timeoutMs: ASSET_COPY_TIMEOUT_MS,
    });
  } catch (err) {
    throw new TransientCopyError(
      `Could not download ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (file.status >= 500 || file.status === 429) {
    throw new TransientCopyError(`Downloading ${url} answered ${file.status}`);
  }
  if (file.status < 200 || file.status >= 300) {
    // A redirect is a status here, not a hop: the fetcher never follows one to an unscreened host.
    throw new Error(`Downloading ${url} answered ${file.status}`);
  }

  const key = assetObjectKey(scope, asset.id, asset.file.fileName);
  await blob.put(key, file.bytes, asset.file.contentType);
  await ctx.store.assets.create(scope, {
    ...asset,
    status: 'draft',
    r2Key: key,
    file: {
      ...asset.file,
      url: await blob.getDownloadUrl(key),
      size: file.bytes.byteLength,
    },
  });
}

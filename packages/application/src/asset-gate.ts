import type { AssetMediaAddress, Scope } from '@commerceworker/domain';
import type { AssetGate, AssetGateEntry, PublishedAsset } from '@commerceworker/ports';
import { assetFileKey } from './assets';
import type { AppContext } from './context';

/**
 * The gate entry for a published snapshot, or `null` when the media origin has nothing to serve
 * (a hosted video plays from its host). The media Worker builds the same entry from a D1 replica
 * when the gate has none yet, so both read paths agree.
 */
export function assetGateEntry(scope: Scope, snapshot: PublishedAsset): AssetGateEntry | null {
  if (snapshot.file.video) return null;
  const focal = snapshot.metadata.focalPoint;
  const expiresAt = snapshot.rights?.expiresAt;
  return {
    v: snapshot.version ?? 1,
    r2Key: assetFileKey(scope, {
      id: snapshot.assetId,
      file: snapshot.file,
      version: snapshot.version ?? 1,
      ...(snapshot.r2Key ? { r2Key: snapshot.r2Key } : {}),
    }),
    contentType: snapshot.file.contentType,
    fileName: snapshot.file.fileName,
    ...(focal ? { focal } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/** A published file's URL never changes meaning (the version is in it), so it keeps a year. */
export const IMMUTABLE_MEDIA = 'public, max-age=31536000, immutable';
const YEAR_SECONDS = 31_536_000;

/** Whether the media origin serves a request, and for how long a 200 may be cached. */
export type MediaServability =
  | { readonly status: 200; readonly cacheControl: string }
  | { readonly status: 404 | 410 };

/**
 * The media origin's rule for one published file, given its gate entry: a 404 for what isn't
 * published at this version and file name (an older version's URLs end with the publish that
 * replaced it), a 410 once the asset's rights have expired, and otherwise a 200 that caches for a
 * year, immutably, or, when the rights expire, only until they do (so no cache outlives them).
 */
export function mediaServability(
  address: Pick<AssetMediaAddress, 'version' | 'fileName'>,
  gate: AssetGateEntry | null,
  nowMs: number,
): MediaServability {
  if (!gate || gate.v !== address.version || gate.fileName !== address.fileName) {
    return { status: 404 };
  }
  if (!gate.expiresAt) return { status: 200, cacheControl: IMMUTABLE_MEDIA };
  const left = Math.floor((Date.parse(gate.expiresAt) - nowMs) / 1000);
  if (!(left > 0)) return { status: 410 };
  return { status: 200, cacheControl: `public, max-age=${Math.min(left, YEAR_SECONDS)}` };
}

/**
 * Brings the asset's gate entry in line with what is published now: written while a published
 * snapshot exists (in an environment that isn't being deleted), removed when there is none. It reads the current state rather than trusting
 * the event, so a redelivered or out-of-order event converges on the same entry. The engine runs
 * it for every asset event; nothing on a request path writes the gate.
 */
export async function syncAssetGate(
  ctx: AppContext,
  gate: AssetGate,
  scope: Scope,
  assetId: string,
): Promise<'written' | 'removed'> {
  // A deleted environment's rows outlive it until its purge removes them: nothing in it is
  // published any more, whatever a late event says.
  const [snapshot, name] = await Promise.all([
    ctx.store.assets.getPublished(scope, assetId),
    ctx.store.spaces.resolveName(scope.spaceId, scope.environmentId),
  ]);
  const entry = snapshot && !name.purging ? assetGateEntry(scope, snapshot) : null;
  if (entry) {
    await gate.put(scope, assetId, entry);
    return 'written';
  }
  await gate.delete(scope, assetId);
  return 'removed';
}

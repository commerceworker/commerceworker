import type { Scope } from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * Moving superseded entry version bodies out of D1.
 *
 * Version bodies are most of what an append-heavy space stores, and a D1 database holds at most
 * 10 GB. Only two versions of an entry are read on hot paths: the current one (joined into every
 * entry read) and the published one (diffed on every publish). Every other version is read only
 * by the history views, so its body can live in object storage. Versions are immutable and an
 * entry's current version only ever increases, so a version that is superseded stays superseded.
 *
 * The sweep writes each body to object storage first and only then drops it from D1, under a
 * condition that it is still there: a crash between the two leaves the body in D1 (and the sweep
 * tries again), and a read racing the sweep finds the body in one place or the other.
 */

/** Versions claimed at a time: their bodies are held in memory until written out. */
export const VERSION_ARCHIVE_BATCH = 50;
/** Batches per sweep (one cron tick). */
export const VERSION_ARCHIVE_BATCHES_PER_SWEEP = 4;

/** Where an archived version body lives. Keyed by environment, so a purge removes a prefix. */
export function versionBodyKey(scope: Scope, entryId: string, version: number): string {
  return `${versionBodyPrefix(scope, entryId)}${version}.json`;
}

/** Every archived version body of one entry. */
export function versionBodyPrefix(scope: Scope, entryId: string): string {
  return `versions/${scope.spaceId}/${scope.environmentId}/${entryId}/`;
}

/**
 * Moves due superseded version bodies to object storage, a batch at a time, up to `batches`
 * batches. Returns how many it moved.
 */
export async function archiveSupersededVersions(
  ctx: AppContext,
  blob: BlobStore,
  opts: { readonly limit?: number; readonly batches?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? VERSION_ARCHIVE_BATCH;
  let moved = 0;
  for (let batch = 0; batch < (opts.batches ?? VERSION_ARCHIVE_BATCHES_PER_SWEEP); batch++) {
    const candidates = await ctx.store.entries.claimArchivableVersions(limit, ctx.clock.now());
    if (candidates.length === 0) break;
    const archived = [];
    for (const v of candidates) {
      const bodyKey = versionBodyKey(v.scope, v.entryId, v.version);
      await blob.put(bodyKey, JSON.stringify(v.fields), 'application/json');
      archived.push({
        scope: v.scope,
        entryId: v.entryId,
        version: v.version,
        createdAt: v.createdAt,
        bodyKey,
      });
    }
    moved += await ctx.store.entries.markVersionsArchived(archived);
    if (candidates.length < limit) break;
  }
  return moved;
}

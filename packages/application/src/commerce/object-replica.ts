/**
 * The replica of the order documents bucket (`DOCS`): what the queue consumer does with an object's
 * create and delete events, and the nightly reconcile that finds what an event missed.
 *
 * Every function looks at what the two buckets hold now, never at the order events arrived in: a
 * create whose object is already gone does nothing, a delete whose key was written again does
 * nothing, so a redelivered, reordered or replayed event is safe. A copy is current when the replica
 * has the same size and the etag it recorded from the source (`SOURCE_ETAG`): the replica's own
 * etag can't be compared, since a multipart upload's differs from the copy's.
 *
 * `audit/` and `plugins/` are locked in the replica as in the primary (scripts/provision.sh): a lock
 * refuses an overwrite and a delete, so those keys are copied once, never refreshed or moved, and the
 * replica's lifecycle rule expires them as the primary's does. A delete elsewhere moves the copy to
 * `deleted/<date>/<key>`, which a 30-day lifecycle rule expires, so an erasure completes there within
 * 30 days. The engine's wiring is apps/engine/src/docs-replica.ts.
 */
import type { ObjectBucket, ObjectContent, ObjectInfo } from '@commerceworker/ports/commerce';

/** The metadata key a copy carries: the etag of the object it was copied from. */
export const SOURCE_ETAG = 'cw-source-etag';

/**
 * Keys the replica never mirrors: the write check's leftovers, the replica's own prefixes, and
 * `intake/`: a raw channel body holds buyer details, expires in days (`expireIntake`), and its queue
 * message is the durability, so a copy (and its 30-day `deleted/` stay) would only outlive it.
 */
const NOT_REPLICATED = ['health/', 'deleted/', 'replica/', 'dlq/', 'intake/'] as const;
/** Locked in both buckets (`provision.sh`): written once. */
const LOCKED = ['audit/', 'plugins/'] as const;

export const isReplicated = (key: string) => !NOT_REPLICATED.some((p) => key.startsWith(p));
export const isLocked = (key: string) => LOCKED.some((p) => key.startsWith(p));
export const deletedKey = (date: string, key: string) => `deleted/${date}/${key}`;
export const reportKey = (date: string) => `replica/${date}.json`;

/** The UTC date an event or a run is filed under. */
export const replicaDate = (at: Date) => at.toISOString().slice(0, 10);

const isCurrent = (source: ObjectInfo, copy: ObjectInfo | null) =>
  !!copy &&
  copy.size === source.size &&
  (copy.customMetadata?.[SOURCE_ETAG] ?? copy.etag) === source.etag;

async function copyOver(replica: ObjectBucket, from: ObjectContent) {
  await replica.write(from.key, from.body, {
    ...(from.contentType ? { contentType: from.contentType } : {}),
    customMetadata: { ...from.customMetadata, [SOURCE_ETAG]: from.etag },
  });
}

/**
 * What came of copying one key:
 * - `copied`: written (new, or stale and refreshed);
 * - `current`: the replica already holds it;
 * - `gone`: the primary no longer has it (a later delete event moves the copy);
 * - `skipped`: a key the replica doesn't mirror;
 * - `held`: a locked key whose copy differs, which the lock won't let us replace.
 */
export type CopyOutcome = 'copied' | 'current' | 'gone' | 'skipped' | 'held';

export async function replicateObject(
  primary: ObjectBucket,
  replica: ObjectBucket,
  key: string,
): Promise<CopyOutcome> {
  if (!isReplicated(key)) return 'skipped';
  const source = await primary.head(key);
  if (!source) return 'gone';
  const copy = await replica.head(key);
  if (isCurrent(source, copy)) return 'current';
  if (copy && isLocked(key)) return 'held';
  const from = await primary.read(key);
  if (!from) return 'gone';
  await copyOver(replica, from);
  return 'copied';
}

/**
 * What came of a delete event: `moved` (the copy went to `deleted/`), `absent` (the replica had
 * none: an earlier attempt moved it, or it never arrived), `recreated` (the primary has the key
 * again: the copy is current, not deleted), `locked` (nothing moves; the replica's lifecycle rule
 * expires it) or `skipped`.
 */
export type DeleteOutcome = 'moved' | 'absent' | 'recreated' | 'locked' | 'skipped';

export async function replicateDelete(
  primary: ObjectBucket,
  replica: ObjectBucket,
  key: string,
  date: string,
): Promise<DeleteOutcome> {
  if (!isReplicated(key)) return 'skipped';
  if (await primary.head(key)) return 'recreated';
  if (isLocked(key)) return 'locked';
  const copy = await replica.read(key);
  if (!copy) return 'absent';
  // Written before the original goes, so a crash between the two leaves both and a replay finishes.
  await replica.write(deletedKey(date, key), copy.body, {
    ...(copy.contentType ? { contentType: copy.contentType } : {}),
    customMetadata: { ...copy.customMetadata },
  });
  await replica.remove(key);
  return 'moved';
}

/** What one page of the reconcile did. */
export type ReconcilePage = {
  cursor?: string;
  scanned: number;
  copied: number;
  held: string[];
  /** Keys that failed to copy, with why: the page goes on and the run reports them. */
  failed: { key: string; error: string }[];
};

/** Copies what a page of the primary has and the replica lacks or holds stale. */
export async function reconcileCopies(
  primary: ObjectBucket,
  replica: ObjectBucket,
  cursor: string | undefined,
  limit = 100,
): Promise<ReconcilePage> {
  const page = await primary.list({ ...(cursor ? { cursor } : {}), limit });
  const out: ReconcilePage = { scanned: 0, copied: 0, held: [], failed: [], cursor: page.cursor };
  for (const source of page.objects) {
    if (!isReplicated(source.key)) continue;
    out.scanned++;
    try {
      const outcome = await replicateObject(primary, replica, source.key);
      if (outcome === 'copied') out.copied++;
      else if (outcome === 'held') out.held.push(source.key);
    } catch (err) {
      out.failed.push({ key: source.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** What one page of the replica turned up that the primary doesn't have. */
export type ExtrasPage = { cursor?: string; scanned: number; extras: string[] };

/**
 * Replica keys the primary no longer has. They are flagged, not moved: a delete event moves a copy,
 * so one left behind means an event was lost or the key is under a lock the primary's lifecycle
 * rule has expired, and an operator decides.
 */
export async function reconcileExtras(
  primary: ObjectBucket,
  replica: ObjectBucket,
  cursor: string | undefined,
  limit = 100,
): Promise<ExtrasPage> {
  const page = await replica.list({ ...(cursor ? { cursor } : {}), limit });
  const out: ExtrasPage = { scanned: 0, extras: [], cursor: page.cursor };
  for (const copy of page.objects) {
    if (!isReplicated(copy.key)) continue;
    out.scanned++;
    if (!(await primary.head(copy.key))) out.extras.push(copy.key);
  }
  return out;
}

/** What a nightly run writes to `replica/<date>.json`. */
export type ReconcileReport = {
  date: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'clean' | 'repaired' | 'attention';
  /** Objects on each side after the copies. */
  primary: number;
  replica: number;
  copied: number;
  /** Locked keys whose copy differs from the primary's. */
  held: string[];
  failed: { key: string; error: string }[];
  extras: { count: number; sample: string[] };
};

const SAMPLE = 100;

export function summarize(
  run: { date: string; startedAt: string; finishedAt: string },
  copies: { scanned: number; copied: number; held: string[]; failed: ReconcilePage['failed'] },
  extras: { scanned: number; keys: string[] },
): ReconcileReport {
  const attention = copies.held.length > 0 || copies.failed.length > 0 || extras.keys.length > 0;
  return {
    ...run,
    outcome: attention ? 'attention' : copies.copied > 0 ? 'repaired' : 'clean',
    primary: copies.scanned,
    replica: extras.scanned,
    copied: copies.copied,
    held: copies.held.slice(0, SAMPLE),
    failed: copies.failed.slice(0, SAMPLE),
    extras: { count: extras.keys.length, sample: extras.keys.slice(0, SAMPLE) },
  };
}

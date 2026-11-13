/**
 * The engine's Durable Objects: a restore to a point in time, a nightly copy of live state, and a
 * drill that proves the restore. The Workflows (apps/engine/src/objects.ts) call these a step at a
 * time; the objects' half (bookmark, rewind, export) is behind `ObjectState`.
 *
 * Point-in-time recovery reaches 30 days back. A restore finds every bookmark before it touches an
 * object, keeps each object's undo bookmark at `objects/restores/<instance>/…` before the object
 * restarts, and ends in a report, `objects/restores/<time>.json`, so it can be taken back. The
 * nightly copy is `objects/<date>/<class>/<n>.ndjson.gz` (a gzipped page of objects a line) and
 * `objects/<date>/manifest.json` written last: what is kept beyond PITR's 30 days. `objects/` is
 * under the backups bucket's lock, which refuses an overwrite, so every write looks first.
 */
import {
  type ActiveObjects,
  BackupRefusal,
  type BackupStore,
  OBJECT_CLASSES,
  type ObjectClass,
  type ObjectExport,
  type ObjectState,
  type SnapshotClass,
} from '@commerceworker/ports/commerce';
import { backupDate, putOnce, sha256Hex } from './database-backup';

/** How far back Durable Objects' point-in-time recovery reaches. */
export const OBJECTS_PITR_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The most objects one restore takes: a run is a step each, and a mistaken list is caught here. */
export const MAX_RESTORE_NAMES = 50;
/** Objects a snapshot chunk holds, and so a step exports. */
export const SNAPSHOT_PAGE = 25;
/** The most objects of a class one night copies, so the run stays under its step limit. */
export const SNAPSHOT_CAP = 20_000;
export const SNAPSHOT_FORMAT = 1;

// ── Restore ──────────────────────────────────────────────────────────────────

export type ObjectsRestoreParams = {
  class?: unknown;
  names?: unknown;
  /** RFC 3339: every object rewinds to this time. */
  at?: unknown;
  /** Object name → bookmark: the `undo` of an earlier restore, or bookmarks found by hand. */
  bookmarks?: unknown;
};

export type ObjectsRestorePlan = { class: ObjectClass; names: string[] } & (
  | { mode: 'at'; at: number }
  | { mode: 'bookmarks'; bookmarks: Record<string, string> }
);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** What an operator asked for, checked before anything is touched; refuses anything else. */
export function parseObjectsRestore(params: unknown, now: number): ObjectsRestorePlan {
  const p = (params ?? {}) as ObjectsRestoreParams;
  if (typeof p.class !== 'string' || !(OBJECT_CLASSES as readonly string[]).includes(p.class))
    throw new BackupRefusal(`"class" is one of ${OBJECT_CLASSES.join(', ')}`);
  const cls = p.class as ObjectClass;
  if (!Array.isArray(p.names) || !p.names.length)
    throw new BackupRefusal('"names" is a list of object names');
  if (p.names.length > MAX_RESTORE_NAMES)
    throw new BackupRefusal(
      `${p.names.length} names is too many: a restore takes at most ${MAX_RESTORE_NAMES}, run it again for the rest`,
    );
  const names = p.names as unknown[];
  if (!names.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 200))
    throw new BackupRefusal('every name is a non-empty string of at most 200 characters');
  if (new Set(names).size !== names.length) throw new BackupRefusal('"names" repeats a name');
  if ((p.at === undefined) === (p.bookmarks === undefined))
    throw new BackupRefusal('give exactly one of "at" or "bookmarks"');
  if (p.bookmarks !== undefined) {
    const map = p.bookmarks;
    if (typeof map !== 'object' || !map || Array.isArray(map))
      throw new BackupRefusal('"bookmarks" maps object names to bookmarks');
    const bookmarks = map as Record<string, unknown>;
    for (const name of names as string[]) {
      const b = bookmarks[name];
      if (typeof b !== 'string' || !b) throw new BackupRefusal(`${name} has no bookmark`);
    }
    return {
      class: cls,
      names: names as string[],
      mode: 'bookmarks',
      bookmarks: Object.fromEntries((names as string[]).map((n) => [n, bookmarks[n] as string])),
    };
  }
  if (typeof p.at !== 'string' || !RFC3339.test(p.at))
    throw new BackupRefusal('"at" is a time in RFC 3339, such as 2026-11-12T09:30:00Z');
  const at = Date.parse(p.at);
  if (!Number.isFinite(at)) throw new BackupRefusal('"at" is not a time');
  if (at >= now) throw new BackupRefusal('"at" must be in the past');
  if (at < now - OBJECTS_PITR_DAYS * DAY_MS)
    throw new BackupRefusal(
      `"at" is more than ${OBJECTS_PITR_DAYS} days ago: point-in-time recovery doesn't reach it`,
    );
  return { class: cls, names: names as string[], mode: 'at', at };
}

const part = (s: string) => encodeURIComponent(s);
export const restorePrefix = (instance: string) => `objects/restores/${instance}/`;
export const undoKey = (instance: string, cls: string, name: string) =>
  `${restorePrefix(instance)}${cls}/${part(name)}.undo.json`;
/** The report of a restore, named by the time it started (colons and dots made file-safe). */
export const restoreReportKey = (startedAt: string) =>
  `objects/restores/${startedAt.replace(/[:.]/g, '-')}.json`;

/** The bookmark each object restores to, all found first: a time out of reach changes nothing. */
export async function findBookmarks(
  state: ObjectState,
  plan: ObjectsRestorePlan,
): Promise<Record<string, string>> {
  if (plan.mode === 'bookmarks') return plan.bookmarks;
  const found: Record<string, string> = {};
  const failed: string[] = [];
  for (const name of plan.names)
    try {
      found[name] = await state.pitrBookmark(plan.class, name, plan.at);
    } catch (err) {
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  if (failed.length)
    throw new BackupRefusal(
      `no bookmark for every object, nothing was changed: ${failed.join('; ')}`,
    );
  return found;
}

/**
 * Rewinds one object and makes sure it took. The object keeps its undo bookmark at `key` just
 * before it aborts, so the call is expected to fail: what counts is that `key` is there. A retry
 * finds it and does nothing (restoring twice would make the undo the restored state); one that
 * finds the call returned, or nothing kept, fails so the step retries. Returns the undo bookmark.
 */
export async function restoreObject(
  state: { restoreTo(cls: string, name: string, bookmark: string, key: string): Promise<void> },
  store: BackupStore,
  at: { class: string; name: string; bookmark: string; instance: string },
): Promise<string> {
  const key = undoKey(at.instance, at.class, at.name);
  const kept = await store.head(key);
  if (kept) return kept.customMetadata?.undo ?? '';
  let returned = false;
  let failure: unknown;
  try {
    await state.restoreTo(at.class, at.name, at.bookmark, key);
    returned = true;
  } catch (err) {
    failure = err;
  }
  const after = await store.head(key);
  if (!after) throw failure ?? new Error(`${at.class} ${at.name}: the restore was never set`);
  if (returned)
    throw new Error(`${at.class} ${at.name}: the restore is set but the object didn't restart`);
  return after.customMetadata?.undo ?? '';
}

/**
 * After an object restarted restored, brings what D1 indexes of it back in step: an order's row
 * (status, waits, totals) and a cart's. The other classes have no index. Returns whether it ran.
 */
export async function reindexObject(
  state: Pick<ObjectState, 'reindex'>,
  cls: ObjectClass,
  name: string,
): Promise<boolean> {
  if (cls !== 'OrderAgent' && cls !== 'CartAgent') return false;
  await state.reindex(cls, name);
  return true;
}

export type RestoreOutcome = {
  name: string;
  bookmark: string;
  undo: string | null;
  reindexed: boolean;
  error?: string;
};

export type RestoreReport = {
  instance: string;
  startedAt: string;
  finishedAt: string;
  class: ObjectClass;
  mode: 'at' | 'bookmarks';
  at?: string;
  outcome: 'restored' | 'failed';
  objects: RestoreOutcome[];
  /** Object name → the bookmark that takes its restore back (run this restore with these as `bookmarks`). */
  undo: Record<string, string>;
};

/** Writes the report of a restore, once: a retried step finds it. */
export async function writeRestoreReport(store: BackupStore, report: RestoreReport) {
  await putOnce(store, restoreReportKey(report.startedAt), JSON.stringify(report, null, 2));
}

// ── The nightly copy ─────────────────────────────────────────────────────────

export const snapshotPrefix = (date: string) => `objects/${date}/`;
export const snapshotManifestKey = (date: string) => `${snapshotPrefix(date)}manifest.json`;
export const snapshotChunkKey = (date: string, cls: SnapshotClass, n: number) =>
  `${snapshotPrefix(date)}${cls}/${n}.ndjson.gz`;

export type SnapshotChunk = {
  key: string;
  sha256: string;
  objects: number;
  errors: number;
  bytes: number;
};
export type SnapshotManifest = {
  format: typeof SNAPSHOT_FORMAT;
  date: string;
  startedAt: string;
  finishedAt: string;
  classes: Record<
    SnapshotClass,
    { objects: number; errors: number; capped: boolean; chunks: SnapshotChunk[] }
  >;
};
/** What one chunk step returns: the chunk (none when no object remains) and where the next begins. */
export type SnapshotStep = { chunk: SnapshotChunk | null; next: string; more: boolean };

async function gzip(text: string): Promise<Uint8Array> {
  const body = new Response(new TextEncoder().encode(text)).body!.pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream,
  );
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * One chunk of a class: up to `limit` live objects after `after`, each exported and gzipped as a
 * line (`{ name, state }`, or `{ name, error }` for an object that couldn't be read: one that
 * vanished or failed doesn't fail the night). A chunk already stored (an earlier attempt) is not
 * read again. `take` is what the class may still copy of `SNAPSHOT_CAP`.
 */
export async function snapshotChunk(
  active: ActiveObjects,
  state: ObjectState,
  store: BackupStore,
  at: { date: string; class: SnapshotClass; n: number; after: string; take?: number },
  limit = SNAPSHOT_PAGE,
): Promise<SnapshotStep> {
  const key = snapshotChunkKey(at.date, at.class, at.n);
  const kept = await store.head(key);
  if (kept?.customMetadata?.next !== undefined) {
    const m = kept.customMetadata;
    return {
      chunk: {
        key,
        sha256: m.sha256 ?? '',
        objects: Number(m.objects),
        errors: Number(m.errors),
        bytes: Number(m.bytes),
      },
      next: m.next ?? '',
      more: m.more === 'true',
    };
  }
  const page = await active.page(at.class, at.after, Math.min(limit, at.take ?? limit));
  if (!page.names.length) return { chunk: null, next: at.after, more: false };
  const lines: string[] = [];
  let errors = 0;
  for (const name of page.names)
    try {
      const exported: ObjectExport = await state.exportState(at.class, name);
      lines.push(JSON.stringify({ name, state: exported }));
    } catch (err) {
      errors++;
      lines.push(JSON.stringify({ name, error: err instanceof Error ? err.message : String(err) }));
    }
  const body = await gzip(lines.join('\n'));
  const sha256 = await sha256Hex(body);
  const stored = await putOnce(store, key, body, {
    sha256,
    objects: String(page.names.length),
    errors: String(errors),
    bytes: String(body.byteLength),
    next: page.next,
    more: String(page.more),
  });
  const m = stored.customMetadata ?? {};
  // Another attempt stored this chunk first: carry on from where its objects end.
  return {
    chunk: {
      key,
      sha256: m.sha256 ?? sha256,
      objects: Number(m.objects ?? page.names.length),
      errors: Number(m.errors ?? errors),
      bytes: Number(m.bytes ?? body.byteLength),
    },
    next: m.next ?? page.next,
    more: (m.more ?? String(page.more)) === 'true',
  };
}

/** Writes the manifest, the last key of a night's copy: a date without one didn't finish. */
export async function writeSnapshotManifest(store: BackupStore, manifest: SnapshotManifest) {
  await putOnce(store, snapshotManifestKey(manifest.date), JSON.stringify(manifest), {
    format: String(SNAPSHOT_FORMAT),
  });
}

export const snapshotDate = backupDate;

// ── The drill ────────────────────────────────────────────────────────────────

/** `drills/objects-<date>.json`: next to the commerce database's, not over it. */
export const objectsDrillKey = (date: string) => `drills/objects-${date}.json`;

/** What the drill's object (`HealthProbe`) offers it: marked rows, and the bookmarks around them. */
export interface DrillProbe {
  /** Writes a row, makes it durable and returns the bookmark just after it. */
  /** Empties the probe, so a run starts from nothing. */
  reset(): Promise<void>;
  mark(label: string): Promise<string>;
  labels(): Promise<string[]>;
}

export type DrillCheck = { ok: boolean; expected: string[]; actual: string[] };

/** Whether the probe holds exactly the rows `expected` (order aside). */
export async function checkProbe(probe: DrillProbe, expected: string[]): Promise<DrillCheck> {
  const actual = [...(await probe.labels())].sort();
  const want = [...expected].sort();
  return { ok: JSON.stringify(actual) === JSON.stringify(want), expected: want, actual };
}

export type ObjectsDrillEvidence = {
  outcome: 'passed' | 'failed';
  date: string;
  instance: string;
  startedAt: string;
  finishedAt: string;
  minutes: number;
  bookmark: string | null;
  undo: string | null;
  checks: { restored: DrillCheck | null; undone: DrillCheck | null };
  error?: string;
};

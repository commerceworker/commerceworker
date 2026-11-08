import {
  diffEntryFields,
  type EntryVersion,
  type FieldDiff,
  InvalidStateError,
  maskDeniedFields,
  NotFoundError,
  type Principal,
  type Scope,
} from '@commerceworker/domain';
import type { AppContext } from './context';
import { type EntryView, updateEntry } from './entries';
import { assertExpectedVersion, type ExpectedVersion } from './publishing';

/** Lists every saved version of an entry, newest first. */
export async function listVersions(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryVersion[]> {
  if (!(await ctx.store.entries.get(scope, entryId))) throw new NotFoundError('Entry', entryId);
  return ctx.store.entries.listVersions(scope, entryId);
}

/** Reads one specific version snapshot. */
export async function getVersion(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  version: number,
): Promise<EntryVersion> {
  const found = await ctx.store.entries.getVersion(scope, entryId, version);
  if (!found) throw new NotFoundError('EntryVersion', `${entryId}@${version}`);
  return found;
}

/**
 * Which version a diff reads: a version number, or the entry's current draft or published
 * version as it stands when the diff runs.
 */
export type VersionRef = number | 'draft' | 'published';

/** A version reference from a query string or tool argument; `null` when it is not one. */
export function parseVersionRef(raw: unknown): VersionRef | null {
  if (raw === 'draft' || raw === 'published') return raw;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A readable diff between two versions of an entry (see `diffEntryFields`). */
export interface VersionDiff {
  readonly entryId: string;
  readonly contentType: string;
  /** The version numbers the references resolved to. */
  readonly from: number;
  readonly to: number;
  /** Every field either version holds, in the content type's order, unchanged ones included. */
  readonly changes: readonly FieldDiff[];
}

/** A diff as one principal may read it. */
export interface VisibleVersionDiff extends VersionDiff {
  /**
   * How many fields changed that this principal may not read. Their names and values stay out; the
   * count is here so that "nothing changed" is never said of a change they can't see.
   */
  readonly hiddenChanges: number;
}

/** Drops the fields `principal` may not read from a diff, and counts the ones that changed. */
export function visibleDiff(principal: Principal, diff: VersionDiff): VisibleVersionDiff {
  const allowed = maskDeniedFields(
    principal,
    diff.contentType,
    Object.fromEntries(diff.changes.map((c) => [c.field, c])),
  );
  return {
    ...diff,
    changes: Object.values(allowed),
    hiddenChanges: diff.changes.filter(
      (c) => !Object.hasOwn(allowed, c.field) && c.locales.some((l) => l.kind !== 'unchanged'),
    ).length,
  };
}

/**
 * Diffs two versions of an entry per field and per locale, with detail by field type. `from` is
 * the baseline and `to` the comparand, so `kind` reads as the change applied going from→to.
 * Either side may name the current draft or the published version instead of a number; asking
 * for `published` on an entry that has none is a 404. Fields are labelled from the content type
 * as it is now. A read: nothing is written.
 */
export async function diffVersions(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  from: VersionRef,
  to: VersionRef,
): Promise<VersionDiff> {
  const found = await ctx.store.entries.get(scope, entryId);
  if (!found) throw new NotFoundError('Entry', entryId);
  const { entry } = found;
  const resolve = (ref: VersionRef): number => {
    if (ref === 'draft') return entry.currentVersion;
    if (ref === 'published') {
      if (entry.publishedVersion === null) {
        throw new NotFoundError('EntryVersion', `${entryId}@published`);
      }
      return entry.publishedVersion;
    }
    return ref;
  };
  const fromVersion = resolve(from);
  const toVersion = resolve(to);
  const [a, b, contentType] = await Promise.all([
    getVersion(ctx, scope, entryId, fromVersion),
    getVersion(ctx, scope, entryId, toVersion),
    ctx.store.contentTypes.get(scope, entry.contentTypeApiId),
  ]);
  // An archived body that could not be read back has empty fields: diffing it would report every
  // field removed, which is not what happened.
  for (const v of [a, b]) {
    if (v.bodyUnavailable) {
      throw new InvalidStateError(`Version ${v.version} of entry ${entryId} is unavailable`);
    }
  }
  return {
    entryId,
    contentType: entry.contentTypeApiId,
    from: fromVersion,
    to: toVersion,
    changes: diffEntryFields(a.fields, b.fields, contentType ?? undefined),
  };
}

/**
 * Restores an older version by copying its fields into a NEW draft version
 * (history is append-only — nothing is rewritten). Validates the restored
 * fields against the current content type, so a restore can't reintroduce a
 * value the model no longer accepts. With `expectedVersion`, refused (409) when the entry has
 * moved past the version the caller saw.
 */
export async function restoreVersion(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  version: number,
  opts: ExpectedVersion = {},
): Promise<EntryView> {
  if (opts.expectedVersion !== undefined) {
    const found = await ctx.store.entries.get(scope, entryId);
    if (!found) throw new NotFoundError('Entry', entryId);
    assertExpectedVersion(found.entry, opts);
  }
  const target = await getVersion(ctx, scope, entryId, version);
  // The old version whole, as it was stored (see `EntryWriteOptions.copy`): a field its rules now
  // disable takes its old value back rather than refusing the restore.
  return updateEntry(ctx, scope, entryId, target.fields, { copy: true });
}

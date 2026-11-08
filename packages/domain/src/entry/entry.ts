import { InvalidStateError } from '../errors';
import type { EntryFields, EntryStatus } from '../types';

/**
 * An entry aggregate. `currentVersion` always points at the latest saved draft
 * snapshot; `publishedVersion` (when set) points at the snapshot currently
 * served by the Delivery API. The two diverge while an entry has unpublished
 * edits (status "changed").
 */
export interface Entry {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: EntryStatus;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
  /**
   * Authorship, stamped by the use-cases (which hold the clock and the actor) and kept by the
   * store: `createdAt`/`createdBy` once, at creation; `updatedBy` on every change (the change
   * `sys.updatedAt` records); `firstPublishedAt` by the first publish only. An actor is an
   * actor id (see `authorship.ts`). Null when unknown (an entry from before they were
   * recorded); absent on an entry nothing has stamped yet.
   */
  readonly createdAt?: string | null;
  readonly createdBy?: string | null;
  readonly updatedBy?: string | null;
  readonly firstPublishedAt?: string | null;
  /**
   * The entry's place in its type's manual order (`position.ts`), written only by a move and kept
   * by the store through every save; null or absent when it was never moved, and it sorts by its
   * id. Read it as `effectivePosition`.
   */
  readonly position?: string | null;
}

/** An immutable point-in-time snapshot of an entry's field values. */
export interface EntryVersion {
  readonly entryId: string;
  readonly version: number;
  readonly fields: EntryFields;
  /** When this version was saved (ISO-8601). Optional: set by use-cases, which
   *  hold the clock; the domain stays time-free. */
  readonly createdAt?: string;
  /** Who saved this version (an actor, as {@link Entry.updatedBy}); null when unknown. */
  readonly createdBy?: string | null;
  /** Set when the body moved to object storage and could not be read back there: `fields` is
   *  then empty. History lists show such a version without failing the rest. */
  readonly bodyUnavailable?: true;
}

/**
 * Derives the status an entry should carry given its current and published
 * versions. Centralizing this keeps the state machine consistent everywhere.
 */
export function deriveStatus(
  currentVersion: number,
  publishedVersion: number | null,
  archived: boolean,
): EntryStatus {
  if (archived) return 'archived';
  if (publishedVersion === null) return 'draft';
  if (currentVersion > publishedVersion) return 'changed';
  return 'published';
}

/** Result of saving new field values onto an entry. */
export interface SaveResult {
  readonly entry: Entry;
  readonly version: EntryVersion;
}

/** Applies an edit, producing a new draft version and the updated aggregate. */
export function saveDraft(entry: Entry, fields: EntryFields): SaveResult {
  if (entry.status === 'archived') {
    throw new InvalidStateError('Cannot edit an archived entry; unarchive it first');
  }
  const nextVersion = entry.currentVersion + 1;
  return {
    entry: {
      ...entry,
      currentVersion: nextVersion,
      status: deriveStatus(nextVersion, entry.publishedVersion, false),
    },
    version: { entryId: entry.id, version: nextVersion, fields },
  };
}

/** Marks the entry as published at its current version. */
export function publish(entry: Entry): Entry {
  if (entry.status === 'archived') {
    throw new InvalidStateError('Cannot publish an archived entry');
  }
  return {
    ...entry,
    publishedVersion: entry.currentVersion,
    status: 'published',
  };
}

/** Withdraws the published version; the entry reverts to a draft. */
export function unpublish(entry: Entry): Entry {
  if (entry.publishedVersion === null) {
    throw new InvalidStateError('Entry is not published');
  }
  return { ...entry, publishedVersion: null, status: 'draft' };
}

export function archive(entry: Entry): Entry {
  if (entry.publishedVersion !== null) {
    throw new InvalidStateError('Unpublish the entry before archiving it');
  }
  return { ...entry, status: 'archived' };
}

/**
 * Brings an archived entry back as a draft.
 *
 * It never returns to `published`: archiving requires an unpublished entry, so
 * there is no published version to restore, and re-publishing must be a
 * deliberate act rather than a side effect of undoing a delete.
 */
export function restore(entry: Entry): Entry {
  if (entry.status !== 'archived') {
    throw new InvalidStateError('Entry is not archived');
  }
  return { ...entry, status: deriveStatus(entry.currentVersion, null, false) };
}

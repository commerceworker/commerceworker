import {
  type AuditDetail,
  type ContentType,
  changedPaths,
  type Entry,
  type EntryChange,
  type EntryFields,
  MAX_AUDIT_DETAIL_ENTRIES,
} from '@commerceworker/domain';
import type { AppContext } from './context';

/**
 * What the entry saves of one request changed, for the audit row its surface writes afterwards.
 * The row is written in the surface, and what changed is known here, many use-cases down (a
 * translation that applies, an approved review, a restored version): the save notes it on the
 * context it was given, so every route and tool that reaches a save gets the same detail without
 * passing anything back. Only paths are kept, so a long import holds no bodies in memory.
 */
export interface ChangeLog {
  /** Records a committed change; `summarize` only runs while the log has room for the entry. */
  note(entryId: string, summarize: () => EntryChange): void;
  /** What has been noted, or undefined when nothing was. */
  detail(): AuditDetail | undefined;
  clear(): void;
}

/** Two saves of one entry in one request read as one change: the first's kind, the last's version. */
function merged(first: EntryChange, next: EntryChange): EntryChange {
  const undeclaredFields = (first.undeclaredFields ?? 0) + (next.undeclaredFields ?? 0);
  return {
    ...next,
    kind: first.kind,
    paths: [...new Set([...first.paths, ...next.paths])],
    locales: [...new Set([...first.locales, ...next.locales])].sort(),
    ...(undeclaredFields > 0 ? { undeclaredFields } : {}),
  };
}

export function createChangeLog(): ChangeLog {
  const entries = new Map<string, EntryChange>();
  let incomplete = false;
  return {
    note(entryId, summarize) {
      const seen = entries.get(entryId);
      if (!seen && entries.size >= MAX_AUDIT_DETAIL_ENTRIES) {
        incomplete = true;
        return;
      }
      try {
        const change = summarize();
        entries.set(entryId, seen ? merged(seen, change) : change);
      } catch {
        // Auditing never breaks a save that has already committed; the row says it is partial.
        incomplete = true;
      }
    },
    detail() {
      if (entries.size === 0 && !incomplete) return undefined;
      return { entries: [...entries.values()], ...(incomplete ? { truncated: true } : {}) };
    },
    clear() {
      entries.clear();
      incomplete = false;
    },
  };
}

/** `ctx` noting its entry saves on `changes`; `ctx` itself when there is no log to note on. */
export function withChanges(ctx: AppContext, changes: ChangeLog | undefined): AppContext {
  return changes ? { ...ctx, changes } : ctx;
}

/** The entry a write created, when that is all it did: a create's request can't name it. */
export function createdEntryOf(detail: AuditDetail | undefined): EntryChange | undefined {
  const [entry, ...others] = detail?.entries ?? [];
  return entry?.kind === 'created' && others.length === 0 && !detail?.truncated ? entry : undefined;
}

/** Notes a save, once it has committed, for whoever is collecting. No log, no diff. */
export function noteEntryChange(
  ctx: AppContext,
  input: {
    readonly entry: Entry;
    readonly contentType: ContentType;
    readonly before: EntryFields;
    readonly after: EntryFields;
    readonly locales: readonly string[];
  },
): void {
  const { entry, contentType, before, after, locales } = input;
  ctx.changes?.note(entry.id, () => ({
    entryId: entry.id,
    contentType: entry.contentTypeApiId,
    kind: entry.currentVersion === 1 ? 'created' : 'updated',
    version: entry.currentVersion,
    ...changedPaths(before, after, contentType, locales),
  }));
}

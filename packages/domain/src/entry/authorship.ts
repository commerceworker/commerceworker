import type { Entry } from './entry';

/**
 * Who wrote an entry, as its authorship records it. A request's actor is its principal's audit
 * identity (`principalActorId`: a person's subject, `admin-token`, or the API key's kind); work
 * nobody asked for in that request names what did it instead. Kept as plain strings so an id the
 * store holds never has to be parsed back.
 */
export type EntryActor = string;

/** Engine work no principal asked for in the moment: a scheduled publish, a release's schedule. */
export const SYSTEM_ACTOR: EntryActor = 'system';

/** An editorial agent's writes (`enrich`, `curate`, `moderate`). */
export const agentActor = (agent: string): EntryActor => `agent:${agent}`;

/** A workflow node's writes, named for the workflow rather than the person it acts for. */
export const workflowActor = (workflowId: string): EntryActor => `workflow:${workflowId}`;

/** A plugin's writes through its capabilities, as the audit log names a plugin. */
export const pluginActor = (pluginId: string): EntryActor => `plugin:${pluginId}`;

/**
 * A new entry's authorship: created (and last changed) by `actor` at `at`. An entry carried over
 * from elsewhere (an environment clone, a promotion) keeps the authorship it brings.
 */
export function stampCreated(entry: Entry, actor: EntryActor | null, at: string): Entry {
  return {
    ...entry,
    createdAt: entry.createdAt ?? at,
    createdBy: entry.createdBy !== undefined ? entry.createdBy : actor,
    updatedBy: actor,
    firstPublishedAt: entry.firstPublishedAt ?? null,
  };
}

/** Any later change (a save, an unpublish, the trash): `actor` made it. */
export function stampChanged(entry: Entry, actor: EntryActor | null): Entry {
  return { ...entry, updatedBy: actor };
}

/**
 * A publish of `before` (the entry as it was read): `actor` made it, and it is the first unless
 * one is recorded. An entry already live with none recorded went live before first publishes were
 * recorded, so its first stays unknown rather than becoming this one.
 */
export function stampPublished(
  before: Entry,
  published: Entry,
  actor: EntryActor | null,
  at: string,
): Entry {
  const first = before.firstPublishedAt ?? (before.publishedVersion === null ? at : null);
  return { ...published, updatedBy: actor, firstPublishedAt: first };
}

/** The longest actor id authorship keeps: a person's subject or email, or `kind:<id>`. */
export const MAX_ENTRY_ACTOR_LENGTH = 320;

/** An ISO-8601 UTC instant as the server writes one (`2026-11-03T15:07:02.000Z`). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * What is wrong with authorship an entry brings from elsewhere (a snapshot): each instant an
 * ISO-8601 UTC timestamp that parses, the creator a non-empty string of at most
 * {@link MAX_ENTRY_ACTOR_LENGTH}. Empty when it holds (or carries none).
 */
export function carriedAuthorshipIssues(carried: {
  readonly createdAt?: unknown;
  readonly createdBy?: unknown;
  readonly firstPublishedAt?: unknown;
}): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  for (const field of ['createdAt', 'firstPublishedAt'] as const) {
    const v = carried[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
      issues.push({ field, message: 'an ISO-8601 UTC timestamp, like 2026-01-31T09:00:00.000Z' });
    }
  }
  const by = carried.createdBy;
  if (
    by !== undefined &&
    (typeof by !== 'string' || by.length === 0 || by.length > MAX_ENTRY_ACTOR_LENGTH)
  ) {
    issues.push({
      field: 'createdBy',
      message: `a non-empty string of at most ${MAX_ENTRY_ACTOR_LENGTH} characters`,
    });
  }
  return issues;
}

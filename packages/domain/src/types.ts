/**
 * Shared scalar and value types for the domain core.
 * Nothing here imports any infrastructure.
 */

/** Identifier of a space, the isolation boundary inside a deployment. A space holds many environments. */
export type SpaceId = string;

/**
 * The shape a new space's id must have. It sits in every URL path, cache key and object key under
 * the space, so: ASCII letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most
 * 64 characters. That also keeps out `*`, which the deployment's root tokens use for "every space".
 */
export const SPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when `value` can be a space's id. */
export function isSpaceId(value: string): boolean {
  return SPACE_ID_PATTERN.test(value);
}

/**
 * The shape an entry id brought from elsewhere must have. Minted ids are UUIDv7s, but a snapshot
 * carries its own, and an id is repeated into audit rows, URLs and object keys, where prose
 * doesn't belong: ASCII letters, digits, `_` and `-`, at most 64 characters.
 */
export const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** What {@link ENTRY_ID_PATTERN} asks for, in words. Doesn't repeat the refused id. */
export const ENTRY_ID_RULE = 'an entry id is 1 to 64 ASCII letters, digits, underscores or hyphens';

/** True when `value` can be an entry's id. */
export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value);
}

/**
 * The media bucket's top-level prefixes that aren't a space: archived entry version bodies
 * (`versions/`), staged import and snapshot chunks (`imports/`), plugin bundles (`plugins/`), dead
 * letters (`dlq/`, with its own lifecycle rule) and zip downloads (`zips/`, with one too). A
 * space's asset files sit at `<space>/<environment>/…` in the same bucket, so a space named like one of these would reach
 * that data when its files are deleted. No space may take one of these ids, in any case.
 */
export const RESERVED_SPACE_IDS = ['versions', 'imports', 'plugins', 'dlq', 'zips'] as const;

const RESERVED = new Set<string>(RESERVED_SPACE_IDS);

/** True when `value` names one of the bucket's shared prefixes ({@link RESERVED_SPACE_IDS}). */
export function isReservedSpaceId(value: string): boolean {
  return RESERVED.has(value.toLowerCase());
}
/** An environment is a branch within a space (e.g. "main", "staging"). */
export type EnvironmentId = string;

/**
 * The scope every domain operation is performed within. Carrying this through
 * every use-case is what keeps spaces isolated from each other by construction.
 */
export interface Scope {
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
}

/** BCP-47 locale code, e.g. "en-US". */
export type LocaleCode = string;

/**
 * A field value keyed by locale. Non-localized fields still use this shape with
 * a single entry under the space's default locale, keeping the read/write paths
 * uniform.
 *
 * Example: { "en-US": "Hello", "de-DE": "Hallo" }
 */
export type LocalizedValue = Record<LocaleCode, unknown>;

/** The full set of field values for an entry: fieldApiId -> locale -> value. */
export type EntryFields = Record<string, LocalizedValue>;

/** Lifecycle status of an entry. */
export type EntryStatus = 'draft' | 'changed' | 'published' | 'archived';

/** Lifecycle status of a content type definition. */
export type ContentTypeStatus = 'draft' | 'published';

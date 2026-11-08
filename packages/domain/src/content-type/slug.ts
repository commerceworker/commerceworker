/**
 * Slug values: URL-safe identifiers.
 *
 * Normalization is deliberately conservative — lowercase ASCII letters, digits
 * and single hyphens. Anything else is transliterated where there is an obvious
 * ASCII equivalent (accents) and otherwise dropped, because a slug ends up in a
 * URL, a filename and a cache key, and "mostly works" in those places is worse
 * than plainly refusing the character.
 */

/** The shape a stored slug must have. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug we store. Comfortably inside every CDN and filesystem limit. */
export const SLUG_MAX_LENGTH = 200;

/**
 * Converts arbitrary text into a slug. Idempotent: normalizing a slug returns
 * it unchanged, so this is safe to apply on every write.
 *
 * Returns `''` when nothing survives (e.g. a title that is entirely emoji);
 * callers decide whether that is an error or a cue to fall back to an id.
 */
export function normalizeSlug(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Strip the combining marks NFKD just split off, turning "é" into "e"
      // rather than dropping the character wholesale. Matched by Unicode
      // property so the class holds no literal combining characters.
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LENGTH)
      // A trailing hyphen can reappear after slicing.
      .replace(/-+$/, '')
  );
}

/** True when `value` is already a well-formed slug. */
export function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/**
 * Appends a numeric discriminator: `post` → `post-2` → `post-3`. Used when
 * duplicating an entry whose slug must stay unique.
 *
 * The counter replaces an existing one rather than stacking, so duplicating a
 * duplicate gives `post-3`, not `post-2-2`.
 */
export function nextSlugCandidate(slug: string, attempt: number): string {
  const base = slug.replace(/-\d+$/, '');
  const suffix = `-${attempt}`;
  const room = SLUG_MAX_LENGTH - suffix.length;
  return `${base.slice(0, room).replace(/-+$/, '')}${suffix}`;
}

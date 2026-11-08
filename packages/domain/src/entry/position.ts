/**
 * Manual entry order: every entry of a content type has a place in one order, a string key that
 * sorts by plain character comparison (in JavaScript and in SQLite's BINARY collation alike).
 *
 * Keys are base-64 fractions over {@link POSITION_DIGITS}, read as `0.d1d2d3…`: a key between two
 * others always exists unless they are adjacent strings, so moving an entry rewrites that entry's
 * key alone. An entry that has never been moved has no key of its own and sorts by its id
 * ({@link effectivePosition}): ids use the same characters, and UUIDv7 ids sort by creation time,
 * so every type starts in creation order and a new entry lands at the end without writing a key.
 */

/**
 * The digits of a key, in ASCII order: the characters an entry id may use
 * (`ENTRY_ID_PATTERN`), so every id is already a key.
 */
export const POSITION_DIGITS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** Longest key a move writes; past it, a move re-keys its neighbours instead (`evenlySpaced`). */
export const MAX_POSITION_LENGTH = 96;

const BASE = POSITION_DIGITS.length;
const ZERO = POSITION_DIGITS[0] as string;
const MIDDLE = POSITION_DIGITS[BASE / 2] as string;

const digit = (c: string | undefined): number => (c === undefined ? 0 : POSITION_DIGITS.indexOf(c));

/** True when `key` is a non-empty string of position digits. */
export function isPosition(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 128) return false;
  for (const c of key) if (POSITION_DIGITS.indexOf(c) < 0) return false;
  return true;
}

/** An entry's place in its type's order: its own key once it has been moved, else its id. */
export function effectivePosition(entry: {
  readonly id: string;
  readonly position?: string | null;
}): string {
  return entry.position ?? entry.id;
}

/**
 * A key strictly between `lo` and `hi` (`''` for no lower bound, `null` for no upper one), or
 * null when none exists: `lo` is `hi` with trailing zero digits removed, as `"ab"` and `"ab-"`.
 * The midpoint of the two read as fractions, as short as it can be. It never ends in a zero digit,
 * so it can always be split again.
 */
function midpoint(lo: string, hi: string | null): string | null {
  if (hi !== null) {
    // The shared prefix, reading a missing digit of `lo` as zero.
    let n = 0;
    while (n < hi.length && (lo[n] ?? ZERO) === hi[n]) n++;
    if (n === hi.length) return null;
    if (n > 0) {
      const rest = midpoint(lo.slice(n), hi.slice(n));
      return rest === null ? null : hi.slice(0, n) + rest;
    }
  }
  const a = digit(lo[0]);
  const b = hi === null ? BASE : digit(hi[0]);
  if (b - a > 1) return POSITION_DIGITS[Math.round((a + b) / 2)] as string;
  // Adjacent first digits: `hi`'s first digit alone fits when `hi` goes on past it.
  if (hi !== null && hi.length > 1) return hi.slice(0, 1);
  const rest = midpoint(lo.slice(1), null);
  return rest === null ? null : (lo[0] ?? ZERO) + rest;
}

/**
 * A key for a place between two neighbours: `lo` the key before it (null for the first place),
 * `hi` the key after it (null for the last). Null when no key fits between them, which happens
 * only between two hand-chosen ids such as `"ab"` and `"ab-"`; the caller re-keys the neighbours.
 *
 * The last place is `lo` with one digit added, never a short key past it: it still sorts before
 * any id created later (an id greater than `lo` and as long differs from it within `lo`), so new
 * entries keep landing at the end after an entry has been moved there.
 */
export function positionBetween(lo: string | null, hi: string | null): string | null {
  if (lo !== null && hi !== null && !(lo < hi)) return null;
  if (hi === null) {
    if (lo === null) return MIDDLE;
    // Trailing zero digits add nothing to a fraction: append after the last one that counts.
    return lo.replace(/-+$/, '') + MIDDLE;
  }
  return midpoint(lo ?? '', hi);
}

/**
 * `count` keys in order strictly between `lo` and `hi` (null bounds as {@link positionBetween}),
 * spread by halving so each is at most a few digits longer than its bounds: what a move writes to
 * a run of neighbours when the gap it needs has run out. Null when the bounds leave no room.
 */
export function evenlySpaced(lo: string | null, hi: string | null, count: number): string[] | null {
  if (count <= 0) return [];
  const mid = positionBetween(lo, hi);
  if (mid === null) return null;
  const before = Math.floor((count - 1) / 2);
  const left = evenlySpaced(lo, mid, before);
  const right = evenlySpaced(mid, hi, count - 1 - before);
  if (left === null || right === null) return null;
  return [...left, mid, ...right];
}

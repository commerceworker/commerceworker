import { describe, expect, it } from 'vitest';
import {
  effectivePosition,
  evenlySpaced,
  isEntryId,
  isPosition,
  MAX_POSITION_LENGTH,
  POSITION_DIGITS,
  positionBetween,
} from '../src/index';

/** A deterministic generator, so a failure replays. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A UUIDv7-shaped id for millisecond `ms`: what `ctx.ids.newId()` mints. */
function uuidv7(ms: number, rand: () => number): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const t = ms.toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${hex(3)}-${'89ab'[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
}

describe('position keys', () => {
  it('lists its digits in the order strings compare', () => {
    const digits = [...POSITION_DIGITS];
    expect(digits.length).toBe(64);
    expect([...digits].sort()).toEqual(digits);
    expect(new Set(digits).size).toBe(64);
  });

  it('accepts every entry id as a key, and an entry without one sorts by its id', () => {
    const rand = seeded(7);
    for (let i = 0; i < 50; i++) {
      const id = uuidv7(1_700_000_000_000 + i, rand);
      expect(isEntryId(id)).toBe(true);
      expect(isPosition(id)).toBe(true);
    }
    expect(effectivePosition({ id: 'abc' })).toBe('abc');
    expect(effectivePosition({ id: 'abc', position: null })).toBe('abc');
    expect(effectivePosition({ id: 'abc', position: 'U' })).toBe('U');
    expect(isPosition('a b')).toBe(false);
    expect(isPosition('')).toBe(false);
  });

  it('finds a key strictly between any two, never ending in a zero digit', () => {
    const rand = seeded(42);
    const key = () => {
      const n = 1 + Math.floor(rand() * 8);
      let k = '';
      for (let i = 0; i < n; i++) k += POSITION_DIGITS[Math.floor(rand() * 64)];
      return k;
    };
    for (let i = 0; i < 5000; i++) {
      const [lo, hi] = [key(), key()].sort();
      if (lo === undefined || hi === undefined || lo === hi) continue;
      const mid = positionBetween(lo, hi);
      if (mid === null) {
        // Only when nothing fits: `hi` is `lo` followed by zero digits alone.
        expect(hi.startsWith(lo) && /^-+$/.test(hi.slice(lo.length))).toBe(true);
        continue;
      }
      expect(lo < mid && mid < hi, `${lo} < ${mid} < ${hi}`).toBe(true);
      expect(mid.endsWith('-')).toBe(false);
    }
  });

  it('places first and last past every key, and refuses bounds out of order', () => {
    expect(positionBetween(null, null)).toBe(POSITION_DIGITS[32]);
    const first = positionBetween(null, '0190');
    expect(first !== null && first < '0190').toBe(true);
    const last = positionBetween('0190', null);
    expect(last !== null && last > '0190').toBe(true);
    expect(positionBetween('b', 'a')).toBeNull();
    expect(positionBetween('a', 'a')).toBeNull();
    expect(positionBetween('ab', 'ab-')).toBeNull();
  });

  it('keeps entries created later after one moved to the end', () => {
    const rand = seeded(3);
    const ids = Array.from({ length: 20 }, (_, i) => uuidv7(1_700_000_000_000 + i * 1000, rand));
    const [newest] = ids.slice(-1);
    const moved = positionBetween(newest ?? null, null);
    for (let i = 0; i < 20; i++) {
      const later = uuidv7(1_700_000_100_000 + i, rand);
      expect(moved !== null && moved < later).toBe(true);
    }
  });

  it('keeps narrowing one gap until a move would need a re-key', () => {
    // Always moving into the same gap, the worst case: each key is a digit or so longer.
    let lo = 'a';
    const hi = 'b';
    let moves = 0;
    for (;;) {
      const mid = positionBetween(lo, hi);
      if (mid === null || mid.length > MAX_POSITION_LENGTH) break;
      expect(lo < mid && mid < hi).toBe(true);
      lo = mid;
      moves++;
    }
    expect(moves).toBeGreaterThan(300);
  });

  it('spreads a run of keys evenly and short between two bounds', () => {
    const keys = evenlySpaced('a', 'b', 33);
    expect(keys).toHaveLength(33);
    if (!keys) return;
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(33);
    expect(keys.every((k) => 'a' < k && k < 'b' && k.length <= 4)).toBe(true);
    expect(evenlySpaced('ab', 'ab-', 2)).toBeNull();
    expect(evenlySpaced(null, null, 0)).toEqual([]);
    const open = evenlySpaced('x', null, 5);
    expect(open && [...open].sort()).toEqual(open);
    expect(open?.every((k) => k > 'x')).toBe(true);
  });
});

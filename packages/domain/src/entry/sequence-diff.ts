/**
 * The sequence primitives the entry diff is built from: an edit script between two sequences
 * (Myers' O(ND) algorithm), a word-level text diff on top of it, and the two ways a list's
 * elements are paired across versions (by identity, or by content). Pure; no I/O.
 */

/** How one piece of a diff relates the two versions. */
export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** A run of text that both versions share, or that only one of them has. */
export interface TextSegment {
  readonly kind: 'added' | 'removed' | 'unchanged';
  readonly text: string;
}

/**
 * Past this many edits the diff stops looking for the shortest script and reports a replacement.
 * The search keeps one row per edit, so the cap bounds its memory (about 2·D² integers) on two
 * long values that share nothing, where a fine-grained diff would not be readable anyway.
 */
export const MAX_DIFF_EDITS = 1000;

/** One step of an edit script: an index into `a`, into `b`, or into both when they match. */
type Step = readonly [aIndex: number, bIndex: number];

/**
 * The shortest edit script from `a` to `b`, as matched index pairs in order (`-1` on the side an
 * element is missing from), or `null` when it needs more than `maxEdits` edits.
 */
export function editScript<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
  maxEdits = MAX_DIFF_EDITS,
): Step[] | null {
  // A shared head and tail are matched outright; Myers only sees what differs between them.
  let head = 0;
  while (head < a.length && head < b.length && same(a[head] as T, b[head] as T)) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail] as T, b[b.length - 1 - tail] as T)
  ) {
    tail++;
  }
  const middle = myers(
    a.slice(head, a.length - tail),
    b.slice(head, b.length - tail),
    same,
    maxEdits,
  );
  if (!middle) return null;
  const steps: Step[] = [];
  for (let i = 0; i < head; i++) steps.push([i, i]);
  for (const [x, y] of middle) steps.push([x < 0 ? -1 : x + head, y < 0 ? -1 : y + head]);
  for (let i = tail; i > 0; i--) steps.push([a.length - i, b.length - i]);
  return steps;
}

function myers<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
  maxEdits: number,
): Step[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => [-1, j] as const);
  if (m === 0) return a.map((_, i) => [i, -1] as const);
  // `rows[d]` holds the furthest x reached on each diagonal k ∈ [-d, d] after d edits.
  const rows: Int32Array[] = [];
  const max = Math.min(n + m, maxEdits);
  let prev = new Int32Array(1);
  for (let d = 0; d <= max; d++) {
    const row = new Int32Array(2 * d + 1);
    const at = (r: Int32Array, rd: number, k: number) => r[k + rd] as number;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && at(prev, d - 1, k - 1) < at(prev, d - 1, k + 1))) {
        x = at(prev, d - 1, k + 1);
      } else x = at(prev, d - 1, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x] as T, b[y] as T)) {
        x++;
        y++;
      }
      row[k + d] = x;
      if (x >= n && y >= m) {
        rows.push(row);
        return backtrack(rows, n, m);
      }
    }
    rows.push(row);
    prev = row;
  }
  return null;
}

function backtrack(rows: Int32Array[], n: number, m: number): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = rows.length - 1; d > 0; d--) {
    const prev = rows[d - 1] as Int32Array;
    const at = (k: number) => prev[k + d - 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // The diagonal run after the edit, then the edit itself.
    while (x > prevX && y > prevY) steps.push([--x, --y]);
    if (down) steps.push([-1, --y]);
    else steps.push([--x, -1]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) steps.push([--x, --y]);
  return steps.reverse();
}

/**
 * Words, runs of whitespace, and single punctuation marks: the units a reader sees change. A word
 * keeps its inner apostrophes and hyphens ("don't", "co-author").
 */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/**
 * A word-level diff of two strings, as segments that read `before` when the added ones are
 * dropped and `after` when the removed ones are. A space left alone between two edits joins
 * them, so "the quick fox" → "a slow fox" reads as one replaced phrase, not two.
 */
export function diffText(before: string, after: string): TextSegment[] {
  if (before === after) return before ? [{ kind: 'unchanged', text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  const steps = editScript(a, b, (x, y) => x === y);
  if (!steps) return replaced(before, after);
  const out: TextSegment[] = [];
  for (const [i, j] of steps) {
    if (i >= 0 && j >= 0) out.push({ kind: 'unchanged', text: a[i] as string });
    else if (i >= 0) out.push({ kind: 'removed', text: a[i] as string });
    else out.push({ kind: 'added', text: b[j] as string });
  }
  return merge(absorbLoneSpaces(merge(out)));
}

/** A whole-value replacement, for text too different to diff word by word. */
export function replaced(before: string, after: string): TextSegment[] {
  const out: TextSegment[] = [];
  if (before) out.push({ kind: 'removed', text: before });
  if (after) out.push({ kind: 'added', text: after });
  return out;
}

/** Joins neighbours of the same kind, and keeps removals ahead of additions within one edit. */
function merge(segments: readonly TextSegment[]): TextSegment[] {
  const out: TextSegment[] = [];
  let removed = '';
  let added = '';
  const flush = () => {
    if (removed) out.push({ kind: 'removed', text: removed });
    if (added) out.push({ kind: 'added', text: added });
    removed = '';
    added = '';
  };
  for (const s of segments) {
    if (s.kind === 'removed') removed += s.text;
    else if (s.kind === 'added') added += s.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === 'unchanged')
        out[out.length - 1] = { kind: 'unchanged', text: last.text + s.text };
      else out.push(s);
    }
  }
  flush();
  return out;
}

function absorbLoneSpaces(segments: readonly TextSegment[]): TextSegment[] {
  const out = [...segments];
  for (let i = 1; i < out.length - 1; i++) {
    const s = out[i] as TextSegment;
    if (s.kind !== 'unchanged' || /\S/.test(s.text)) continue;
    const edited = (x?: TextSegment) => x !== undefined && x.kind !== 'unchanged';
    if (!edited(out[i - 1]) || !edited(out[i + 1])) continue;
    // Both sides of the space are edits: it belongs to the removed phrase and to the added one.
    out.splice(i, 1, { kind: 'removed', text: s.text }, { kind: 'added', text: s.text });
    i++;
  }
  return out;
}

/** Equality of two JSON values regardless of object key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}

/** JSON with object keys sorted, so two stored copies of one value compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)),
        )
      : v,
  );
}

/** How an element of one version's list lines up with the other's. */
export interface Aligned {
  readonly beforeIndex: number | null;
  readonly afterIndex: number | null;
  /** Both sides hold it, but its place relative to the elements around it changed. */
  readonly moved: boolean;
}

/**
 * Pairs elements that carry an identity (a block's `_key`, a link's target, a tag's text). Pairs
 * share a key; the rest were added or removed. A pair is `moved` when it falls outside the
 * longest run of pairs that kept their relative order, which is the smallest set of moves that
 * explains the new order. Repeated keys pair by occurrence: the second "news" with the second.
 */
export function alignByKey<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T, index: number) => string,
): Aligned[] {
  const occurrences = (items: readonly T[]) => {
    const seen = new Map<string, number>();
    return items.map((item, i) => {
      const key = keyOf(item, i);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return `${n}\u0000${key}`;
    });
  };
  const beforeKeys = occurrences(before);
  const afterKeys = occurrences(after);
  const beforeAt = new Map(beforeKeys.map((k, i) => [k, i]));
  const pairs: { beforeIndex: number; afterIndex: number }[] = [];
  const out: Aligned[] = [];
  afterKeys.forEach((k, afterIndex) => {
    const beforeIndex = beforeAt.get(k);
    if (beforeIndex === undefined) out.push({ beforeIndex: null, afterIndex, moved: false });
    else pairs.push({ beforeIndex, afterIndex });
  });
  const kept = increasingRun(pairs.map((p) => p.beforeIndex));
  pairs.forEach((p, i) => {
    out.push({ ...p, moved: !kept.has(i) });
  });
  const paired = new Set(pairs.map((p) => p.beforeIndex));
  before.forEach((_, beforeIndex) => {
    if (!paired.has(beforeIndex)) out.push({ beforeIndex, afterIndex: null, moved: false });
  });
  return inReadingOrder(out);
}

/** Indexes (into `values`) of one longest strictly increasing subsequence. */
function increasingRun(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const parent: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((values[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const run = new Set<number>();
  for (
    let i = tails.length ? (tails[tails.length - 1] as number) : -1;
    i >= 0;
    i = parent[i] as number
  ) {
    run.add(i);
  }
  return run;
}

/**
 * Pairs elements that have no identity, by what they hold. Equal runs are matched by the edit
 * script; between two matched runs, a removed element and an added one that `pairable` accepts
 * are the same element, edited. A leftover removed element equal to a leftover added one moved.
 * Falls back to pairing by position when the lists share too little to diff.
 */
export function alignByContent<T>(
  before: readonly T[],
  after: readonly T[],
  same: (x: T, y: T) => boolean,
  pairable: (x: T, y: T) => boolean,
): Aligned[] {
  const steps =
    editScript(before, after, same) ??
    Array.from(
      { length: Math.max(before.length, after.length) },
      (_, i): Step => [i < before.length ? i : -1, i < after.length ? i : -1],
    );
  const out: Aligned[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  // Pairs a gap's removed and added elements in order: each removed one takes the first pairable
  // added one after the last pair, so pairs never cross.
  const settleGap = () => {
    const pairedAdded = new Set<number>();
    let from = 0;
    for (const r of removed) {
      let j = from;
      while (j < added.length && !pairable(before[r] as T, after[added[j] as number] as T)) j++;
      if (j < added.length) {
        out.push({ beforeIndex: r, afterIndex: added[j] as number, moved: false });
        pairedAdded.add(j);
        from = j + 1;
      } else out.push({ beforeIndex: r, afterIndex: null, moved: false });
    }
    added.forEach((a, j) => {
      if (!pairedAdded.has(j)) out.push({ beforeIndex: null, afterIndex: a, moved: false });
    });
    removed = [];
    added = [];
  };
  for (const [i, j] of steps) {
    if (i >= 0 && j >= 0 && same(before[i] as T, after[j] as T)) {
      settleGap();
      out.push({ beforeIndex: i, afterIndex: j, moved: false });
    } else {
      if (i >= 0) removed.push(i);
      if (j >= 0) added.push(j);
    }
  }
  settleGap();
  return inReadingOrder(detectMoves(out, before, after, same));
}

/** A removed element equal to an added one is one element that moved. */
function detectMoves<T>(
  aligned: Aligned[],
  before: readonly T[],
  after: readonly T[],
  same: (x: T, y: T) => boolean,
): Aligned[] {
  const out = [...aligned];
  for (let i = 0; i < out.length; i++) {
    const r = out[i] as Aligned;
    if (r.afterIndex !== null || r.beforeIndex === null) continue;
    const j = out.findIndex(
      (a) =>
        a.beforeIndex === null &&
        a.afterIndex !== null &&
        same(before[r.beforeIndex as number] as T, after[a.afterIndex] as T),
    );
    if (j < 0) continue;
    out[j] = {
      beforeIndex: r.beforeIndex,
      afterIndex: (out[j] as Aligned).afterIndex,
      moved: true,
    };
    out.splice(i, 1);
    i--;
  }
  return out;
}

/**
 * The order a reader follows: the new version's order, with each removed element just after
 * whatever preceded it in the old version.
 */
function inReadingOrder(aligned: readonly Aligned[]): Aligned[] {
  const afterOf = new Map<number, number>();
  for (const a of aligned) {
    if (a.beforeIndex !== null && a.afterIndex !== null) afterOf.set(a.beforeIndex, a.afterIndex);
  }
  const place = (a: Aligned): [number, number] => {
    if (a.afterIndex !== null) return [a.afterIndex, 0];
    const b = a.beforeIndex as number;
    // Anchor a removed element to the nearest earlier element that survived.
    for (let i = b - 1; i >= 0; i--) {
      const anchor = afterOf.get(i);
      if (anchor !== undefined) return [anchor + 0.5, b];
    }
    return [-0.5, b];
  };
  return [...aligned].sort((x, y) => {
    const [px, sx] = place(x);
    const [py, sy] = place(y);
    return px - py || sx - sy;
  });
}

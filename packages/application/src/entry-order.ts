import {
  ConflictError,
  effectivePosition,
  evenlySpaced,
  InvalidStateError,
  MAX_POSITION_LENGTH,
  NotFoundError,
  positionBetween,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import {
  type EntryPlaceKey,
  type PositionGuard,
  type PositionWrite,
  TransactionConflictError,
} from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * Manual entry order: moving an entry within its content type's one order (`order=sys.position`).
 * A move is live entry metadata, as a menu's order is: it makes no version, leaves the entry's
 * status and `updatedAt` alone, and Delivery serves the new order at once for a published entry.
 * It writes one key (`positionBetween`), or, when the gap it needs has run out, re-keys a run of
 * neighbours with it. The write and an `entry.moved` event commit in one unit; a lost race to
 * another move is read again and retried.
 */

/** Where to put an entry: right after one (`null`: first), or right before one (`null`: last). */
export type EntryPlace = { readonly after: string | null } | { readonly before: string | null };

export interface MovedEntry {
  readonly id: string;
  readonly contentTypeApiId: string;
  /** Its key now: what `order=sys.position` sorts by. */
  readonly position: string;
}

/** Times a move reads, computes and commits before giving up to a busier writer. */
const MOVE_ATTEMPTS = 3;

/** Neighbours on each side a re-key spreads over, when a gap has run out. */
const REKEY_SPAN = 16;

/**
 * Moves an entry in its type's manual order. The anchor must be another entry of the same type,
 * not in the trash; an entry in the trash can't be moved (it keeps its place, and returns to it
 * when restored). Moving an entry to where it already is writes nothing.
 */
export async function moveEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  place: EntryPlace,
): Promise<MovedEntry> {
  for (let attempt = 1; ; attempt++) {
    const plan = await planMove(ctx, scope, id, place);
    if (plan.unchanged) return plan.moved;
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.entries.setPositions(scope, plan.moved.contentTypeApiId, plan.writes, plan.guard);
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'entry.moved',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          entryId: id,
          contentTypeApiId: plan.moved.contentTypeApiId,
          position: plan.moved.position,
          published: plan.published,
        });
      });
      return plan.moved;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (attempt >= MOVE_ATTEMPTS) {
        throw new ConflictError('The order changed while moving this entry; try again');
      }
    }
  }
}

interface MovePlan {
  readonly moved: MovedEntry;
  readonly unchanged: boolean;
  readonly published: boolean;
  readonly writes: readonly PositionWrite[];
  readonly guard: PositionGuard;
}

async function planMove(
  ctx: AppContext,
  scope: Scope,
  id: string,
  place: EntryPlace,
): Promise<MovePlan> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const entry = found.entry;
  if (entry.status === 'archived') {
    throw new InvalidStateError('The entry is in the trash; restore it before moving it');
  }
  const type = entry.contentTypeApiId;
  const own = effectivePosition(entry);
  const neighbor = async (key: string | null, side: 'after' | 'before') =>
    (await ctx.store.entries.positionNeighbors(scope, type, key, side, 1, id))[0] ?? null;

  // The gap between two neighbours (lo, hi) the entry goes into, and the anchor that names it.
  const after = 'after' in place;
  const anchorId = after ? place.after : place.before;
  let anchor: EntryPlaceKey | undefined;
  if (anchorId !== null) {
    anchor = await anchorOf(ctx, scope, id, type, anchorId, after ? 'after' : 'before');
  }
  let lo: EntryPlaceKey | null;
  let hi: EntryPlaceKey | null;
  if (after) {
    lo = anchor ?? null;
    hi = await neighbor(anchor?.position ?? null, 'after');
  } else {
    hi = anchor ?? null;
    lo = await neighbor(anchor?.position ?? null, 'before');
  }
  const moved = (position: string): MovedEntry => ({ id, contentTypeApiId: type, position });
  const published = entry.publishedVersion !== null;
  // Already there: nothing else sits between its neighbours and it.
  if ((lo === null || lo.position < own) && (hi === null || own < hi.position)) {
    return {
      moved: moved(own),
      unchanged: true,
      published,
      writes: [],
      guard: { lo: null, hi: null },
    };
  }

  const key = positionBetween(lo?.position ?? null, hi?.position ?? null);
  if (key !== null && key.length <= MAX_POSITION_LENGTH) {
    return {
      moved: moved(key),
      unchanged: false,
      published,
      writes: [{ id, position: key, expected: own }],
      guard: { lo: lo?.position ?? null, hi: hi?.position ?? null, ...(anchor ? { anchor } : {}) },
    };
  }
  return rekey(ctx, scope, type, { id, own }, lo, hi, anchor, moved, published);
}

/** The anchor of a move: another live entry of the same type, as its key. */
async function anchorOf(
  ctx: AppContext,
  scope: Scope,
  id: string,
  type: string,
  anchorId: string,
  side: 'after' | 'before',
): Promise<EntryPlaceKey> {
  const field = side;
  if (anchorId === id) {
    throw new ValidationError([{ field, message: 'An entry can’t be placed beside itself' }]);
  }
  const found = await ctx.store.entries.get(scope, anchorId);
  if (!found || found.entry.contentTypeApiId !== type) {
    throw new ValidationError([{ field, message: `No "${type}" entry with this id` }]);
  }
  if (found.entry.status === 'archived') {
    throw new ValidationError([{ field, message: 'That entry is in the trash' }]);
  }
  return { id: anchorId, position: effectivePosition(found.entry) };
}

/**
 * The gap between `lo` and `hi` has run out (or would make too long a key): spread the entry and
 * up to {@link REKEY_SPAN} neighbours on each side evenly between the keys just outside them. All
 * are written in one unit, each only if it still has the key read here.
 */
async function rekey(
  ctx: AppContext,
  scope: Scope,
  type: string,
  self: { readonly id: string; readonly own: string },
  lo: EntryPlaceKey | null,
  hi: EntryPlaceKey | null,
  anchor: EntryPlaceKey | undefined,
  moved: (position: string) => MovedEntry,
  published: boolean,
): Promise<MovePlan> {
  const near = (key: string, side: 'after' | 'before') =>
    ctx.store.entries.positionNeighbors(scope, type, key, side, REKEY_SPAN, self.id);
  const before = lo ? [...(await near(lo.position, 'before')).reverse(), lo] : [];
  const after = hi ? [hi, ...(await near(hi.position, 'after'))] : [];
  // The keys just outside the run bound it; a full side has one more entry past it.
  const outside = async (edge: EntryPlaceKey | undefined, side: 'after' | 'before') =>
    edge ? ((await near(edge.position, side))[0]?.position ?? null) : null;
  const outerLo = before.length > REKEY_SPAN ? await outside(before[0], 'before') : null;
  const outerHi = after.length > REKEY_SPAN ? await outside(after.at(-1), 'after') : null;
  const run = [...before, { id: self.id, position: self.own }, ...after];
  // At the end of the type, stay below a freshly minted id: ids are UUIDv7s, so every entry
  // created later still lands after the run, as a move to the end leaves it.
  const keys = evenlySpaced(outerLo, outerHi ?? ctx.ids.newId(), run.length);
  if (keys === null || keys.some((k) => k.length > MAX_POSITION_LENGTH)) {
    throw new ConflictError('No room to move this entry here; move its neighbours first');
  }
  const writes = run.map((e, i) => ({
    id: e.id,
    position: keys[i] as string,
    expected: e.id === self.id ? self.own : e.position,
  }));
  const mine = writes.find((w) => w.id === self.id)?.position as string;
  return {
    moved: moved(mine),
    unchanged: false,
    published,
    writes,
    guard: { lo: outerLo, hi: outerHi, ...(anchor ? { anchor } : {}) },
  };
}

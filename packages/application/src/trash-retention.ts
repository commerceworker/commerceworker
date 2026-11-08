import {
  authorize,
  DomainError,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { BlobStore, ExpiredTrashEntry } from '@commerceworker/ports';
import type { AppContext } from './context';
import { purgeEntry } from './entries';

/**
 * Trash retention: a space may say how many days its trashed entries are kept, and the engine's
 * hourly sweep (`sweepExpiredTrash`) deletes the older ones permanently through `purgeEntry`, the
 * use-case "Delete permanently" calls. Off by default: a space that never sets it keeps its trash
 * until someone empties it, so turning this on is the only way existing data is ever swept.
 */

/** The longest retention a space can set: ten years. */
export const MAX_TRASH_RETENTION_DAYS = 3650;

/**
 * Entries one sweep purges at most, across every space and environment. A purge is about 10 D1
 * statements (`ENTRY_TRASH_CHUNK_SIZE` says how that was measured), and the sweep shares the
 * cron's invocation, and its query budget, with every other sweep of the tick.
 */
export const TRASH_SWEEP_LIMIT = 40;

/**
 * Refusals one environment may meet in a run on top of its share of purges. A refused entry (a
 * plugin's legal hold) doesn't use a purge slot, so the sweep reads on past it to the expired
 * entries behind; this bounds what a trash full of held entries can cost a run.
 */
export const TRASH_SWEEP_REFUSALS_PER_ENVIRONMENT = 10;

/** Entries read per page of one environment's expired trash. */
const PAGE = 20;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The space's trash settings: `retentionDays` null is off (trashed entries are kept). */
export interface TrashSettings {
  readonly retentionDays: number | null;
}

export async function getTrashSettings(ctx: AppContext, scope: Scope): Promise<TrashSettings> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { retentionDays: config.trashRetentionDays ?? null };
}

/**
 * Sets how many days the space keeps trashed entries (1 to {@link MAX_TRASH_RETENTION_DAYS}), or
 * null to turn retention off. It applies to every environment of the space, and to what is already
 * in the trash: an entry trashed longer ago than the new window goes on the next sweep. Needs
 * `space:admin`.
 */
export async function setTrashRetention(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  retentionDays: number | null,
): Promise<TrashSettings> {
  authorize(principal, SCOPES.spaceAdmin, scope.spaceId);
  if (
    retentionDays !== null &&
    (!Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > MAX_TRASH_RETENTION_DAYS)
  ) {
    throw new ValidationError([
      {
        field: 'retentionDays',
        message: `A whole number of days from 1 to ${MAX_TRASH_RETENTION_DAYS}, or null for off`,
      },
    ]);
  }
  if (!(await ctx.store.spaces.getConfig(scope))) throw new NotFoundError('Space', scope.spaceId);
  await ctx.store.spaces.setTrashRetentionDays(scope.spaceId, retentionDays);
  return { retentionDays };
}

export interface TrashSweepResult {
  readonly purged: number;
  /** Entries a rule refused (a plugin's veto, a link published since the read), kept for now. */
  readonly refused: number;
}

/**
 * The retention sweep: in every space with retention on, purges the entries each environment has
 * held in the trash longer than the space's window, through `purgeEntry`, so a sweep deletes only
 * what a person pressing "Delete permanently" could: an entry still in the trash, with no
 * published entry linking to it (never forced; linked ones are left out of the read and stay).
 *
 * Bounded: at most `limit` purges a run, each its own small unit of work, one after another (the
 * database has one writer), and at most twice that many refusals in all. The environments take
 * turns going first, hour by hour; first pages are read only until they hold the run's budget,
 * which is then shared evenly between the environments that have expired trash.
 *
 * Fair to what is behind a refusal: a refused entry (a plugin's legal hold, a race) uses no purge
 * slot, and each environment resumes where its last run stopped (a keyset cursor stored on the
 * environment), so entries held for good never stop the ones behind them. Once an environment's
 * expired trash has been read to its end, the next run starts from the oldest again and retries
 * what was refused. Idempotent: a re-run starts from what is left.
 */
export async function sweepExpiredTrash(
  ctx: AppContext,
  opts: { readonly blob?: BlobStore; readonly limit?: number } = {},
): Promise<TrashSweepResult> {
  const now = ctx.clock.now().getTime();
  const limit = opts.limit ?? TRASH_SWEEP_LIMIT;
  const maxRefused = 2 * limit;

  const environments: { scope: Scope; before: Date }[] = [];
  for (const space of await ctx.store.spaces.list()) {
    if (!space.trashRetentionDays) continue;
    const before = new Date(now - space.trashRetentionDays * DAY_MS);
    for (const env of await ctx.store.spaces.listEnvironments(space.spaceId)) {
      environments.push({ scope: { spaceId: space.spaceId, environmentId: env.id }, before });
    }
  }
  if (environments.length === 0 || limit <= 0) return { purged: 0, refused: 0 };

  // Turn by turn: which environment goes first moves on each hour.
  const first = Math.floor(now / HOUR_MS) % environments.length;
  const turn = [...environments.slice(first), ...environments.slice(0, first)];

  // The environments with expired trash, each with its first page from where it resumes, read
  // only until they hold the run's budget.
  const due: {
    scope: Scope;
    before: Date;
    page: ExpiredTrashEntry[];
    stored: ExpiredTrashEntry | null;
  }[] = [];
  let found = 0;
  for (const { scope, before } of turn) {
    if (found >= limit) break;
    const stored = await ctx.store.spaces.getTrashSweepCursor(scope);
    let page = await ctx.store.entries.listExpiredTrash(scope, before, PAGE, stored ?? undefined);
    // Nothing after the cursor: wrap round to the oldest, retrying what was refused.
    if (page.length === 0 && stored) {
      page = await ctx.store.entries.listExpiredTrash(scope, before, PAGE);
    }
    if (page.length === 0) {
      if (stored) await ctx.store.spaces.setTrashSweepCursor(scope, null);
      continue;
    }
    due.push({ scope, before, page, stored });
    found += page.length;
  }

  let budget = limit;
  let purged = 0;
  let refused = 0;
  for (const [i, { scope, before, page: firstPage, stored }] of due.entries()) {
    if (budget <= 0 || refused >= maxRefused) break;
    // An even share of what is left, so what one environment doesn't use goes to the rest.
    let quota = Math.ceil(budget / (due.length - i));
    let refusals = 0;
    const more = () =>
      quota > 0 && refusals < TRASH_SWEEP_REFUSALS_PER_ENVIRONMENT && refused < maxRefused;
    let page = firstPage;
    let last: ExpiredTrashEntry | undefined;
    let exhausted = false;
    for (;;) {
      for (const row of page) {
        if (!more()) break;
        last = row;
        try {
          await purgeEntry(ctx, scope, row.id, opts.blob ? { blob: opts.blob } : {});
          purged++;
          quota--;
          budget--;
        } catch (err) {
          // A rule said no: the entry stays, and is tried again once this environment's sweep
          // comes round to it. Anything else is the database's, and fails the sweep.
          if (!(err instanceof DomainError)) throw err;
          refused++;
          refusals++;
        }
      }
      if (last === page.at(-1) && page.length < PAGE) {
        exhausted = true;
        break;
      }
      if (!more() || !last) break;
      page = await ctx.store.entries.listExpiredTrash(scope, before, PAGE, last);
      if (page.length === 0) {
        exhausted = true;
        break;
      }
    }
    // Where the next run starts here: after the last entry looked at, or from the oldest again
    // once the expired trash has been read to its end.
    const next = exhausted ? null : (last ?? stored);
    if (next?.id !== stored?.id || next?.trashedAt !== stored?.trashedAt) {
      await ctx.store.spaces.setTrashSweepCursor(scope, next ?? null);
    }
  }
  return { purged, refused };
}

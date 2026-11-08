import {
  analyzeRedirects,
  type ContentType,
  checkRedirect,
  collapseRedirectChains,
  createRedirectMatcher,
  deliveredContentType,
  type EntryFields,
  MAX_REDIRECT_IMPORT,
  MAX_REDIRECTS,
  NotFoundError,
  planSlugRedirects,
  type Redirect,
  type RedirectChain,
  type RedirectInput,
  type RedirectMatch,
  type RedirectSetReport,
  type RedirectStatus,
  redirectKey,
  redirectSetError,
  redirectsFromCsv,
  redirectsToCsv,
  type Scope,
  type SlugMove,
  slugMoves,
  ValidationError,
} from '@commerceworker/domain';
import {
  type ContentStoreTx,
  type RedirectPage,
  type RedirectQuery,
  type RedirectSetState,
  TransactionConflictError,
} from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * Redirects: an environment's set of source paths and where they send a reader. commerceworker
 * serves no site, so the set is delivery data: Delivery hands it (or one path's match) to the
 * front end or the edge Worker that answers the request.
 *
 * Every write checks the whole set it would leave behind (no source twice, no loop, at most
 * `MAX_REDIRECTS`) and commits with the set's compare-and-set and a `redirects.changed` event in
 * one unit. A writer that lost the race to another reads the set again and checks once more.
 */

/** Times a write reads, checks and commits the set before giving up to a busier writer. */
const WRITE_ATTEMPTS = 3;

/** A written redirect and the chains it now takes part in (allowed, but one hop slower). */
export interface RedirectWrite {
  readonly redirect: Redirect;
  readonly chains: readonly RedirectChain[];
}

interface SetChange {
  readonly save: readonly Redirect[];
  readonly remove: readonly string[];
}

/**
 * Reads the set, asks `change` what to write, checks the result and commits it with the
 * compare-and-set. Retries a lost race; `change` may run more than once.
 */
async function writeSet<T>(
  ctx: AppContext,
  scope: Scope,
  change: (current: readonly Redirect[], state: RedirectSetState) => SetChange & { result: T },
  opts: { readonly dryRun?: boolean } = {},
): Promise<{ result: T; next: readonly Redirect[] }> {
  for (let attempt = 1; ; attempt++) {
    // Reads first: the unit below only writes.
    const [current, state] = await Promise.all([
      ctx.store.redirects.all(scope),
      ctx.store.redirects.state(scope),
    ]);
    const { save, remove, result } = change(current, state);
    const removed = new Set(remove);
    const saved = new Map(save.map((r) => [r.id, r]));
    const next = [
      ...current.filter((r) => !removed.has(r.id) && !saved.has(r.id)),
      ...saved.values(),
    ];
    if (next.length > MAX_REDIRECTS && next.length > current.length) {
      throw new ValidationError([
        {
          field: 'redirects',
          message: `An environment holds at most ${MAX_REDIRECTS} redirects (this would make ${next.length})`,
        },
      ]);
    }
    const refused = redirectSetError(analyzeRedirects(next));
    if (refused) throw refused;
    if (opts.dryRun || (save.length === 0 && remove.length === 0)) return { result, next };
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.redirects.removeMany(scope, remove);
        await tx.redirects.saveMany(scope, save);
        await tx.redirects.advance(scope, state.revision);
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'redirects.changed',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          count: save.length + remove.length,
        });
      });
      return { result, next };
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < WRITE_ATTEMPTS) continue;
      throw err;
    }
  }
}

const chainsOf = (set: readonly Redirect[], id: string): RedirectChain[] =>
  analyzeRedirects(set).chains.filter((c) => c.id === id || c.via.includes(id));

async function localesOf(ctx: AppContext, scope: Scope): Promise<readonly string[]> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config.locales;
}

// --- reads ----------------------------------------------------------------

export const listRedirects = (
  ctx: AppContext,
  scope: Scope,
  query: RedirectQuery = {},
): Promise<RedirectPage> => ctx.store.redirects.list(scope, query);

export async function getRedirect(ctx: AppContext, scope: Scope, id: string): Promise<Redirect> {
  const redirect = await ctx.store.redirects.get(scope, id);
  if (!redirect) throw new NotFoundError('Redirect', id);
  return redirect;
}

/** The set read whole: loops, chains (each collapsible) and duplicates, with its size. */
export interface RedirectAnalysis extends RedirectSetReport {
  readonly count: number;
  readonly max: number;
}

export async function analyzeRedirectSet(ctx: AppContext, scope: Scope): Promise<RedirectAnalysis> {
  const set = await ctx.store.redirects.all(scope);
  return { ...analyzeRedirects(set), count: set.length, max: MAX_REDIRECTS };
}

/** The whole set as CSV (`source,destination,status,locale,enabled,note`): what an import reads. */
export async function exportRedirectsCsv(ctx: AppContext, scope: Scope): Promise<string> {
  return redirectsToCsv(await ctx.store.redirects.all(scope));
}

/**
 * What a path resolves to among the environment's enabled redirects, or null. The same answer
 * Delivery's `…/redirects/resolve` gives a front end; here for checking a set while editing it.
 */
export async function resolveRedirect(
  ctx: AppContext,
  scope: Scope,
  path: string,
  locale?: string,
): Promise<RedirectMatch | null> {
  const set = await ctx.store.redirects.all(scope, { enabledOnly: true });
  return createRedirectMatcher(set).match(path, locale);
}

// --- writes ---------------------------------------------------------------

export async function createRedirect(
  ctx: AppContext,
  scope: Scope,
  input: RedirectInput,
): Promise<RedirectWrite> {
  const fields = checkRedirect(input, await localesOf(ctx, scope));
  const at = ctx.clock.now().toISOString();
  const redirect: Redirect = {
    id: ctx.ids.newId(),
    ...fields,
    origin: 'manual',
    createdAt: at,
    updatedAt: at,
  };
  const { next } = await writeSet(ctx, scope, () => ({
    save: [redirect],
    remove: [],
    result: undefined,
  }));
  return { redirect, chains: chainsOf(next, redirect.id) };
}

/** Changes a redirect; a field left out keeps its value, `null` clears `locale` or `note`. */
export async function updateRedirect(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: Partial<RedirectInput>,
): Promise<RedirectWrite> {
  const locales = await localesOf(ctx, scope);
  const at = ctx.clock.now().toISOString();
  const { result, next } = await writeSet(ctx, scope, (current) => {
    const existing = current.find((r) => r.id === id);
    if (!existing) throw new NotFoundError('Redirect', id);
    const fields = checkRedirect(
      {
        source: patch.source ?? existing.source,
        destination: patch.destination ?? existing.destination,
        status: patch.status ?? existing.status,
        locale: patch.locale === undefined ? existing.locale : patch.locale,
        enabled: patch.enabled ?? existing.enabled,
        note: patch.note === undefined ? existing.note : patch.note,
      },
      locales,
    );
    const { locale: _l, note: _n, ...kept } = existing;
    const updated: Redirect = { ...kept, ...fields, updatedAt: at };
    return { save: [updated], remove: [], result: updated };
  });
  return { redirect: result, chains: chainsOf(next, id) };
}

export async function deleteRedirect(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await writeSet(ctx, scope, (current) => {
    if (!current.some((r) => r.id === id)) throw new NotFoundError('Redirect', id);
    return { save: [], remove: [id], result: undefined };
  });
}

/** Points every redirect that ends a chain straight at where its chain ends. */
export async function collapseRedirects(
  ctx: AppContext,
  scope: Scope,
): Promise<{ readonly updated: number }> {
  const at = ctx.clock.now().toISOString();
  const { result } = await writeSet(ctx, scope, (current) => {
    const byId = new Map(current.map((r) => [r.id, r]));
    const save = collapseRedirectChains(current).flatMap(({ id, destination }) => {
      const r = byId.get(id);
      return r ? [{ ...r, destination, updatedAt: at }] : [];
    });
    return { save, remove: [], result: save.length };
  });
  return { updated: result };
}

export interface RedirectImport {
  readonly format: 'csv' | 'json';
  /** CSV text with a header row, or (JSON) an array of redirects. */
  readonly data: string | readonly RedirectInput[];
  /** Check everything and report, writing nothing. */
  readonly dryRun?: boolean;
}

export interface RedirectImportReport {
  readonly dryRun: boolean;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Chains the imported set holds: it imports, and `collapseRedirects` straightens them. */
  readonly chains: readonly RedirectChain[];
}

/** Reads an import's rows, refusing data that isn't rows of redirects. */
function importRows(input: RedirectImport): readonly RedirectInput[] {
  if (input.format === 'csv') {
    if (typeof input.data !== 'string') {
      throw new ValidationError([{ field: 'data', message: 'CSV data is the file text' }]);
    }
    return redirectsFromCsv(input.data);
  }
  const rows = typeof input.data === 'string' ? safeJson(input.data) : input.data;
  if (!Array.isArray(rows) || rows.some((r) => typeof r !== 'object' || r === null)) {
    throw new ValidationError([{ field: 'data', message: 'JSON data is an array of redirects' }]);
  }
  return rows as RedirectInput[];
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError([{ field: 'data', message: 'The data is not JSON' }]);
  }
};

/**
 * Imports redirects from CSV or JSON, all or nothing: every row is checked (and the set it would
 * leave) before anything is written, and a refusal names each bad row. A row whose source (and
 * locale) is already redirected replaces that redirect's destination, status, enabled flag and
 * note; the rest are added.
 */
export async function importRedirects(
  ctx: AppContext,
  scope: Scope,
  input: RedirectImport,
): Promise<RedirectImportReport> {
  const rows = importRows(input);
  if (rows.length > MAX_REDIRECT_IMPORT) {
    throw new ValidationError([
      {
        field: 'data',
        message: `An import takes at most ${MAX_REDIRECT_IMPORT} rows (this has ${rows.length})`,
      },
    ]);
  }
  const locales = await localesOf(ctx, scope);
  const issues: { field: string; message: string }[] = [];
  const checked = rows.flatMap((row, i) => {
    try {
      return [checkRedirect(row, locales)];
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      issues.push(
        ...err.issues.map((x) => ({ field: `rows[${i}].${x.field}`, message: x.message })),
      );
      return [];
    }
  });
  const firstRow = new Map<string, number>();
  // Row numbers line up only when every row was read.
  for (const [i, r] of issues.length === 0 ? checked.entries() : []) {
    const key = redirectKey(r);
    const seen = firstRow.get(key);
    if (seen !== undefined) {
      issues.push({ field: `rows[${i}].source`, message: `${r.source} is also in row ${seen}` });
    } else firstRow.set(key, i);
  }
  if (issues.length > 0) throw new ValidationError(issues);

  const at = ctx.clock.now().toISOString();
  const dryRun = input.dryRun === true;
  const { result, next } = await writeSet(
    ctx,
    scope,
    (current) => {
      const held = new Map(current.map((r) => [redirectKey(r), r]));
      const save: Redirect[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const fields of checked) {
        const existing = held.get(redirectKey(fields));
        if (!existing) {
          created++;
          save.push({
            id: ctx.ids.newId(),
            ...fields,
            origin: 'import',
            createdAt: at,
            updatedAt: at,
          });
          continue;
        }
        const same =
          existing.destination === fields.destination &&
          existing.status === fields.status &&
          existing.enabled === fields.enabled &&
          (existing.note ?? undefined) === fields.note;
        if (same) {
          unchanged++;
          continue;
        }
        updated++;
        const { note: _n, ...kept } = existing;
        save.push({ ...kept, ...fields, updatedAt: at });
      }
      return { save, remove: [], result: { created, updated, unchanged } };
    },
    { dryRun },
  );
  return {
    dryRun,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    chains: analyzeRedirects(next).chains,
  };
}

// --- delivery -------------------------------------------------------------

/** A redirect as Delivery serves it: what a front end needs to apply it, nothing more. */
export interface DeliveredRedirect {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  readonly status: RedirectStatus;
  readonly locale?: string;
}

const delivered = (r: Redirect): DeliveredRedirect => ({
  id: r.id,
  source: r.source,
  destination: r.destination,
  status: r.status,
  ...(r.locale ? { locale: r.locale } : {}),
});

/** Every enabled redirect, by source: the set a front end or edge Worker applies itself. */
export async function listDeliveredRedirects(
  ctx: AppContext,
  scope: Scope,
): Promise<DeliveredRedirect[]> {
  return (await ctx.store.redirects.all(scope, { enabledOnly: true })).map(delivered);
}

/** One path's match among the enabled redirects; a path nothing redirects is a NotFoundError. */
export async function resolveDeliveredRedirect(
  ctx: AppContext,
  scope: Scope,
  path: string,
  locale?: string,
): Promise<{
  readonly redirect: DeliveredRedirect;
  readonly status: RedirectStatus;
  readonly location: string;
}> {
  const match = await resolveRedirect(ctx, scope, path, locale);
  if (!match) throw new NotFoundError('Redirect', path);
  return { redirect: delivered(match.redirect), status: match.status, location: match.location };
}

// --- slug changes ---------------------------------------------------------

/** An entry a unit is publishing: its type and the fields going live. */
export interface PublishingEntry {
  readonly entryId: string;
  readonly contentType: ContentType;
  readonly fields: EntryFields;
}

/**
 * Reads what the redirects of a publish need, and returns the writes to make once the publish's
 * own are queued (reads first, then writes, in one unit). An entry moves when its type's URL
 * pattern names a slug that the publish changes: its old path is redirected to its new one, with
 * the publish. Costs nothing for a type without a pattern, nor for a first publish (no old path).
 *
 * The set moves on unconditionally: a publish never fails over a concurrent edit to the
 * redirects, and that edit, having read the set before, checks it again.
 */
export async function slugRedirectWrites(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  publishing: readonly PublishingEntry[],
  previouslyPublished: ReadonlySet<string>,
): Promise<() => Promise<void>> {
  const none = async () => {};
  // Paths move by the URL pattern Delivery serves: a type with a draft revision moves its entries
  // by the definition last published, not a pattern no front end routes by yet. Read only then.
  const kept = publishing.some((p) => p.contentType.status !== 'published')
    ? await tx.contentTypes.publishedDefinitions(scope)
    : null;
  const candidates = publishing
    .map((p) => {
      const live = kept?.get(p.contentType.apiId);
      return live ? { ...p, contentType: deliveredContentType(p.contentType, live, false) } : p;
    })
    .filter((p) => p.contentType.urlPattern?.includes('{') && previouslyPublished.has(p.entryId));
  if (candidates.length === 0) return none;
  const previous = new Map(
    (
      await tx.entries.getPublishedMany(
        scope,
        candidates.map((c) => c.entryId),
      )
    ).map((p) => [p.entryId, p.fields]),
  );
  const moves: { entryId: string; moves: SlugMove[] }[] = [];
  for (const c of candidates) {
    const before = previous.get(c.entryId);
    if (!before) continue;
    const m = slugMoves(c.contentType, c.entryId, before, c.fields);
    if (m.length > 0) moves.push({ entryId: c.entryId, moves: m });
  }
  if (moves.length === 0) return none;
  const paths = [
    ...new Set(moves.flatMap((m) => m.moves.flatMap((x) => [x.source, x.destination]))),
  ];
  const [involved, state] = await Promise.all([
    tx.redirects.involving(scope, paths),
    tx.redirects.state(scope),
  ]);
  const at = ctx.clock.now().toISOString();
  const byId = new Map(involved.map((r) => [r.id, r]));
  const removed = new Set<string>();
  let count = state.count;
  for (const { entryId, moves: entryMoves } of moves) {
    const plan = planSlugRedirects([...byId.values()], entryMoves, {
      entryId,
      at,
      newId: () => ctx.ids.newId(),
      count,
    });
    for (const id of plan.remove) {
      byId.delete(id);
      removed.add(id);
      count--;
    }
    for (const r of plan.save) {
      if (!byId.has(r.id)) count++;
      byId.set(r.id, r);
    }
  }
  const original = new Map(involved.map((r) => [r.id, r]));
  const save = [...byId.values()].filter((r) => original.get(r.id) !== r);
  const remove = [...removed].filter((id) => original.has(id));
  if (save.length === 0 && remove.length === 0) return none;
  return async () => {
    await tx.redirects.removeMany(scope, remove);
    await tx.redirects.saveMany(scope, save);
    await tx.redirects.advance(scope);
  };
}

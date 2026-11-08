import {
  ANY_FIELD,
  ENTRY_FILTER_KEY,
  type FilterOp,
  isSavedViewExtraKey,
  type QueryFilter,
  type SavedView,
  type SavedViewQuery,
} from '@commerceworker/domain';
import type { EntryFilter, EntryListQuery } from './management';

/**
 * The entries list's state as its URL: the same query string the Preview API reads
 * (`fields.title[match]=cat`, `sys.status=draft`, `order=-sys.updatedAt`, `query=…`, `where=…`),
 * plus the open saved view (`view`) and the columns (`columns`). A link and a view therefore
 * agree: opening a view writes its query into the URL, and saving reads the URL back.
 *
 * Any other parameter is kept as it came (`extra`): a link from a newer client survives a round
 * trip through this one and is saved with a view, but is never sent with the list request. Only a
 * key nothing here reads is kept (`isSavedViewExtraKey`), on the way in and on the way out: written
 * back into the URL, a saved `where` or `fields.x[gt]` would come alive as a filter, and `space` or
 * `limit` as a connection or a page size. A control parameter of the Preview API's this list has no
 * use for (`limit`, `select`, …) goes the same way.
 */

export interface EntryListState {
  readonly query: EntryListQuery;
  /** The saved view this list was opened from, if any. */
  readonly viewId?: string;
  /** Columns besides the title; absent is the default (status, then updated). */
  readonly columns?: readonly string[];
}

/** The ops a filter key may carry in brackets, as the API reads them. */
const OPS: ReadonlySet<string> = new Set<FilterOp>([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'exists',
  'match',
  'startsWith',
  'ref',
  'refIn',
]);
const LIST_OPS: ReadonlySet<string> = new Set(['in', 'nin', 'between', 'refIn']);

/** The Mine toggle as a filter: the API's own spelling, each reader's own entries in a view. */
const MINE: QueryFilter = { field: 'sys.createdBy', op: 'eq', value: 'me' };
const isMine = (f: Pick<QueryFilter, 'field' | 'op' | 'value'>) =>
  f.field === MINE.field && f.op === MINE.op && f.value === MINE.value;

/**
 * The connection's parameters (any CMS URL may carry them): they belong to the client, not the
 * list, and are never saved with a view.
 */
export const CONNECTION_PARAMS: readonly string[] = ['space', 'env', 'locale'];

const list = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads the list's state from its URL's search parameters. */
export function listStateFromParams(params: URLSearchParams): EntryListState {
  const filters: EntryFilter[] = [];
  const extra: Record<string, string> = {};
  let order: EntryListQuery['order'];
  let search: string | undefined;
  let where: unknown;
  let linksToEntry: string[] | undefined;
  let mine = false;
  for (const [key, value] of params) {
    if (key === 'order') {
      order = list(value).map((token) => ({
        field: token.replace(/^-/, '').replace(/^fields\./, ''),
        direction: token.startsWith('-') ? 'desc' : 'asc',
      }));
      continue;
    }
    if (key === 'query') {
      search = value || undefined;
      continue;
    }
    if (key === 'where') {
      try {
        where = JSON.parse(value);
      } catch {
        // A link with a broken tree lists without it, as one without a tree would.
      }
      continue;
    }
    if (key === 'links_to_entry') {
      linksToEntry = list(value);
      continue;
    }
    if (key === MINE.field && value === MINE.value) {
      mine = true;
      continue;
    }
    const m = ENTRY_FILTER_KEY.exec(key);
    const op = m ? (m[2] ?? 'eq') : undefined;
    // By id only: a view can't hold a slug filter, so this list doesn't apply one it can't save.
    if (m && op && OPS.has(op) && !(m[1] as string).endsWith('.slug')) {
      filters.push({
        field: (m[1] as string).replace(/^fields\./, ''),
        op: op as FilterOp,
        value: LIST_OPS.has(op) ? list(value) : op === 'exists' ? value !== 'false' : value,
      });
    } else if (isSavedViewExtraKey(key)) {
      extra[key] = value;
    }
  }
  const view = params.get('view');
  const columns = params.get('columns');
  return {
    query: {
      ...(filters.length ? { filters } : {}),
      ...(order?.length ? { order } : {}),
      ...(search ? { search } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(linksToEntry?.length ? { linksToEntry } : {}),
      ...(mine ? { mine } : {}),
      ...(params.get('trashed') === 'true' ? { trashed: true } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ...(view ? { viewId: view } : {}),
    ...(columns !== null ? { columns: list(columns) } : {}),
  };
}

/** Namespaces a field for the query string: `sys.*` and `metadata.*` stay, else `fields.*`. */
const keyOf = (field: string) =>
  field.startsWith('sys.') || field.startsWith('metadata.') ? field : `fields.${field}`;

/** Writes the list's state as URL search parameters (the inverse of {@link listStateFromParams}). */
export function listStateToParams(state: EntryListState): URLSearchParams {
  const params = new URLSearchParams();
  const { query } = state;
  if (state.viewId) params.set('view', state.viewId);
  for (const f of query.filters ?? []) {
    const path = keyOf(f.field);
    const key = f.op === 'eq' ? path : `${path}[${f.op}]`;
    params.append(key, Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? ''));
  }
  if (query.where !== undefined) params.set('where', JSON.stringify(query.where));
  if (query.linksToEntry?.length) params.set('links_to_entry', query.linksToEntry.join(','));
  if (query.mine) params.set(MINE.field, MINE.value as string);
  if (query.order?.length) {
    params.set(
      'order',
      query.order.map((o) => `${o.direction === 'desc' ? '-' : ''}${keyOf(o.field)}`).join(','),
    );
  }
  if (query.search) params.set('query', query.search);
  if (query.trashed) params.set('trashed', 'true');
  for (const [k, v] of Object.entries(query.extra ?? {})) {
    if (isSavedViewExtraKey(k)) params.set(k, v);
  }
  if (state.columns) params.set('columns', state.columns.join(','));
  return params;
}

/** A filter's comparand as the filter bar holds it: text, a list of text, or a boolean. */
function barValue(op: string, value: unknown): EntryFilter['value'] {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return op === 'exists' ? true : '';
  return String(value);
}

/** A view's reference filters over every field. */
const anyFieldFilters = (q: SavedViewQuery) =>
  (q.filters ?? []).filter((f) => f.field === ANY_FIELD);

/**
 * The tree a view opens with. `links_to_entry` is one any-of condition, so it can stand in for a
 * single any-field filter only; several are ANDed, and no filter key can spell them, so they ride
 * in `where`, which a list sends as it is.
 */
function openedWhere(q: SavedViewQuery): SavedViewQuery['where'] {
  const refs = anyFieldFilters(q);
  if (refs.length < 2) return q.where;
  const rest = q.where === undefined ? [] : 'and' in q.where ? q.where.and : [q.where];
  return { and: [...refs, ...rest] };
}

/** The list a saved view opens: its query, in the bar's terms, and its columns. */
export function viewToListState(view: SavedView): EntryListState {
  const q = view.query;
  const where = openedWhere(q);
  const extra = Object.fromEntries(
    Object.entries(q.extra ?? {})
      .filter(([k]) => isSavedViewExtraKey(k))
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]),
  );
  const filters = (q.filters ?? []).filter((f) => f.field !== ANY_FIELD && !isMine(f));
  const anyField = anyFieldFilters(q);
  const linksToEntry =
    anyField.length === 1 ? anyField.flatMap((f) => barValue(f.op, f.value)).map(String) : [];
  return {
    viewId: view.id,
    query: {
      ...(filters.length
        ? {
            filters: filters.map((f) => ({
              field: f.field,
              op: f.op,
              value: barValue(f.op, f.value),
            })),
          }
        : {}),
      ...(q.order?.length ? { order: q.order } : {}),
      ...(q.search ? { search: q.search } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(linksToEntry.length ? { linksToEntry } : {}),
      ...(q.filters?.some(isMine) ? { mine: true } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ...(view.columns ? { columns: view.columns } : {}),
  };
}

/** A comparand as the URL spells it, whatever its type. */
const spelled = (value: unknown) => (Array.isArray(value) ? value.join(',') : String(value ?? ''));

/**
 * What saving the list as a view stores: its query in the structured form (the trash flag isn't
 * part of a view). A half-typed filter (no value yet) isn't saved; it would be refused.
 *
 * The URL holds every comparand as text, so a filter that still reads as one of `saved`'s (the
 * query the list was opened from) is stored as that one, typed as it was: `rank > 3` stays the
 * number, and `match ''` or `eq null` aren't taken for a filter nobody finished typing. A kept
 * `extra` value that still reads as `saved`'s stays verbatim the same way, and the tree a view
 * opened with goes back to the filters and tree it was saved as.
 */
export function listQueryToViewQuery(
  query: EntryListQuery,
  saved?: SavedViewQuery,
): SavedViewQuery {
  const unclaimed = [...(saved?.filters ?? [])];
  const asSaved = (field: string, op: FilterOp, value: unknown): QueryFilter | undefined => {
    const at = unclaimed.findIndex(
      (s) =>
        s.field === field && s.op === op && spelled(barValue(s.op, s.value)) === spelled(value),
    );
    return at < 0 ? undefined : unclaimed.splice(at, 1)[0];
  };
  const filters = (query.filters ?? []).flatMap((f): QueryFilter[] => {
    const kept = asSaved(f.field, f.op, f.value);
    if (kept) return [kept];
    const typed =
      f.op === 'exists' || (Array.isArray(f.value) ? f.value.length > 0 : f.value !== '');
    if (!typed) return [];
    return [{ field: f.field, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) }];
  });
  const links = query.linksToEntry ?? [];
  if (links.length) {
    const [one] = links;
    const op = links.length === 1 ? 'ref' : 'refIn';
    const value = links.length === 1 ? one : links;
    filters.push(asSaved(ANY_FIELD, op, value) ?? { field: ANY_FIELD, op, value });
  }
  if (query.mine) filters.push(MINE);
  const reopened =
    saved !== undefined &&
    anyFieldFilters(saved).length > 1 &&
    JSON.stringify(query.where) === JSON.stringify(openedWhere(saved));
  if (reopened) filters.push(...anyFieldFilters(saved));
  const where = reopened ? saved.where : (query.where as SavedViewQuery['where']);
  const extra = Object.fromEntries(
    Object.entries(query.extra ?? {}).map(([k, v]) => {
      const kept = saved?.extra && Object.hasOwn(saved.extra, k) ? saved.extra[k] : undefined;
      return [k, kept !== undefined && spelled(kept) === v ? kept : v];
    }),
  );
  return {
    ...(filters.length ? { filters } : {}),
    ...(where !== undefined ? { where } : {}),
    ...(query.order?.length ? { order: query.order } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** Whether the list still shows exactly what `view` saved (its query and its columns). */
export function matchesView(state: EntryListState, view: SavedView): boolean {
  const canonical = (s: EntryListState) => {
    const p = listStateToParams({ ...s, viewId: undefined, query: { ...s.query, trashed: false } });
    p.sort();
    return p.toString();
  };
  return canonical(state) === canonical(viewToListState(view));
}

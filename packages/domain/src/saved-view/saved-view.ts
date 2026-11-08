import {
  assertAuthorIdQuery,
  assertQueryRespectsFieldRules,
  canAccessContentType,
  deniedFieldsFor,
  type Principal,
  withAuthorIdsFor,
} from '../auth/auth';
import type { ContentType } from '../content-type/content-type';
import { type FieldIssue, ValidationError } from '../errors';
import {
  ENTRY_FILTER_KEY,
  ENTRY_QUERY_PARAMS,
  fieldPath,
  isQueryField,
  MAX_PATH_FILTERS,
  MAX_WHERE_CONDITIONS,
  MAX_WHERE_DEPTH,
  parseQueryWhere,
  type QueryFilter,
  type QueryNode,
  type QueryOrder,
  queryFilterIssues,
  queryNodeFilters,
} from '../query/query';
import { isPersonPrincipal } from '../workflow/runs';

/**
 * Saved views: a named entries-list query (filters, a `where` tree, a sort, a search) and the
 * columns to show, for one content type or for all of them. A personal view is its creator's
 * alone; a shared view is everyone's in the space who can read its content type.
 *
 * A view lives in a space, not in one environment: it is how people work through the content,
 * not content, so a branch environment opens with the same views and nothing about a view rides
 * a snapshot, a clone or a merge. It is run in whichever environment is asked for, where a field
 * that environment's type doesn't have simply matches nothing, and where the type itself may be
 * missing: deleting a type leaves its views alone (another environment may still have it), a run
 * there says so, and the view can still be changed or deleted.
 *
 * The query is stored in the domain's structured form (the `QueryFilter`s and `QueryNode` tree a
 * live query parses into), never as a query string, and checked by the same validators a live
 * query is, strictly: what a view stores is new input, so every check the `where` tree gets
 * applies to its top-level filters too.
 *
 * A view never widens what anyone sees. Running one is an ordinary entries query made by the
 * caller, with the caller's grants and field rules; a view whose query names a field the caller's
 * role hides isn't shown to them at all ({@link canSeeSavedView}).
 */

/** Most personal views one person holds in a space. */
export const MAX_PERSONAL_VIEWS = 50;
/** Most shared views a space holds. */
export const MAX_SHARED_VIEWS = 100;
export const MAX_VIEW_NAME_LENGTH = 80;
/** Most top-level filters a view holds (its `where` tree has its own cap). */
export const MAX_VIEW_FILTERS = MAX_WHERE_CONDITIONS;
/** Most sort keys a view holds. */
export const MAX_VIEW_ORDER = 3;
export const MAX_VIEW_SEARCH_LENGTH = 200;
/** Most columns a view shows besides the display field, which always shows. */
export const MAX_VIEW_COLUMNS = 20;
/** Most query keys a view keeps from a newer client, and their size together as JSON. */
export const MAX_VIEW_EXTRA_KEYS = 10;
export const MAX_VIEW_EXTRA_LENGTH = 2048;
/** The JSON a stored `where` tree may take, as a live query's `where` parameter may. */
export const MAX_VIEW_WHERE_LENGTH = 8192;

/** The `sys.*` columns an entries list can show; any other column is a field of the type. */
export const VIEW_SYS_COLUMNS = ['sys.status', 'sys.updatedAt'] as const;
/** What a view without its own columns shows: the status, then when it last changed. */
export const DEFAULT_VIEW_COLUMNS: readonly string[] = VIEW_SYS_COLUMNS;

export type SavedViewVisibility = 'personal' | 'shared';

/** A view's query, in the structured form a live entries query parses into. */
export interface SavedViewQuery {
  /** ANDed field predicates (`fields.` prefix stripped). */
  readonly filters?: readonly QueryFilter[];
  /** AND/OR groups of predicates, ANDed with `filters`. */
  readonly where?: QueryNode;
  readonly order?: readonly QueryOrder[];
  /** Full-text search over the type's text fields. */
  readonly search?: string;
  /**
   * Query keys a newer client sent that this version doesn't apply (a filter it lacks, say), kept
   * verbatim so a save made here doesn't drop them. Never applied when the view runs: a run says
   * which it left out. Never a key anything here reads ({@link isSavedViewExtraKey}).
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  /** The content type whose entries it lists, or null for every type's. */
  readonly contentTypeApiId: string | null;
  readonly visibility: SavedViewVisibility;
  /** Who created it, as the audit trail names them; a personal view's owner. */
  readonly createdBy: string;
  readonly query: SavedViewQuery;
  /** Columns in order besides the display field; absent is {@link DEFAULT_VIEW_COLUMNS}. */
  readonly columns?: readonly string[];
  /** Bumped by every write: a write naming an older one is refused (someone saved since). */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A view as a caller is served it: `createdBy` only to who is served author ids. */
export type ServedSavedView = Omit<SavedView, 'createdBy'> & { readonly createdBy?: string };

const CONTROL = /\p{Cc}/u;
const EXTRA_KEY = /^[A-Za-z0-9_.[\]-]{1,64}$/;
const FIELD_ID = /^[A-Za-z0-9_]+$/;
/** The admin list's own URL keys beside the entries query's: the open view, the columns, the connection. */
const LIST_URL_PARAMS = ['view', 'columns', 'space', 'env'];
const KNOWN_KEYS: ReadonlySet<string> = new Set([...ENTRY_QUERY_PARAMS, ...LIST_URL_PARAMS]);
/**
 * Deeper than any tree `parseQueryWhere` accepts (each group is an object and an array, a leaf an
 * object and a value list): past this it is refused unread, so nothing recurses down a hostile one.
 */
const MAX_WHERE_JSON_DEPTH = MAX_WHERE_DEPTH * 2 + 3;

/**
 * Whether a query key may be kept in `extra`: one nothing here reads. A filter key or a list or
 * connection parameter never is, so `extra` can't turn into a live filter, a page size or another
 * space once a client writes it back into a URL.
 */
export function isSavedViewExtraKey(key: string): boolean {
  return EXTRA_KEY.test(key) && !KNOWN_KEYS.has(key) && !ENTRY_FILTER_KEY.test(key);
}

const isScalar = (v: unknown) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** A comparand or a kept value: a JSON scalar, or a list of them. Never an object. */
const isPlainValue = (v: unknown) =>
  v === undefined || isScalar(v) || (Array.isArray(v) && v.every(isScalar));

/** Whether JSON nests past `limit`, walked with a stack: this runs on untrusted depth. */
function nestsPast(root: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[root, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [value, depth] = next;
    if (!value || typeof value !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  return false;
}

const fail = (field: string, message: string): never => {
  throw new ValidationError([{ field, message }]);
};

export function checkSavedViewName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name === '' || name.length > MAX_VIEW_NAME_LENGTH || CONTROL.test(name)) {
    fail('name', `A name is 1 to ${MAX_VIEW_NAME_LENGTH} characters`);
  }
  return name;
}

export function checkSavedViewVisibility(input: unknown): SavedViewVisibility {
  if (input !== 'personal' && input !== 'shared') {
    return fail('visibility', 'visibility is personal or shared');
  }
  return input;
}

/** One stored filter: a predicate a live `where` accepts, its comparand plain JSON. */
function checkFilter(raw: unknown, at: string, issues: FieldIssue[]): QueryFilter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field: at, message: 'expected a filter: { field, op, value }' });
    return null;
  }
  const v = raw as Record<string, unknown>;
  const field =
    typeof v.field === 'string' && v.field.startsWith('fields.')
      ? v.field.slice('fields.'.length)
      : v.field;
  // Before anything spells it: a list nested deep enough overflows the stack as a string.
  if (typeof field !== 'string') {
    issues.push({ field: at, message: 'a filter names its field as a string' });
    return null;
  }
  const filter = {
    field,
    op: v.op === undefined ? 'eq' : v.op,
    ...(v.value !== undefined ? { value: v.value } : {}),
  } as QueryFilter;
  if (typeof field === 'string' && field.startsWith('metadata.') && field.endsWith('.slug')) {
    issues.push({ field: at, message: 'filter tags and concepts by id in a saved view' });
    return null;
  }
  const problems = queryFilterIssues(filter, at, { strict: true });
  if (!problems.length && !isPlainValue(filter.value)) {
    problems.push({ field: at, message: 'a value is a string, number, boolean or a list of them' });
  }
  issues.push(...problems);
  return problems.length ? null : filter;
}

/**
 * Reads a view's query from untrusted JSON (a request body, an MCP tool's input) into its stored
 * form, with the checks a live `where` gets applied to every part. Throws a `ValidationError`
 * naming each problem.
 */
export function checkSavedViewQuery(raw: unknown): SavedViewQuery {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('query', 'query is an object');
  const q = raw as Record<string, unknown>;
  const known = new Set(['filters', 'where', 'order', 'search', 'extra']);
  const unknown = Object.keys(q).filter((k) => !known.has(k));
  if (unknown.length) {
    // A misspelt key is refused, not kept: what a newer client wants kept goes in `extra`.
    fail('query', `query holds only ${[...known].join(', ')}; not ${unknown.join(', ')}`);
  }
  const issues: FieldIssue[] = [];

  let filters: QueryFilter[] | undefined;
  if (q.filters !== undefined) {
    if (!Array.isArray(q.filters)) {
      issues.push({ field: 'query.filters', message: 'expected an array of filters' });
    } else if (q.filters.length > MAX_VIEW_FILTERS) {
      issues.push({
        field: 'query.filters',
        message: `a view holds at most ${MAX_VIEW_FILTERS} filters`,
      });
    } else {
      const read = q.filters.map((f, i) => checkFilter(f, `query.filters[${i}]`, issues));
      filters = read.filter((f): f is QueryFilter => f !== null);
    }
  }

  let where: QueryNode | undefined;
  if (q.where !== undefined && q.where !== null) {
    if (nestsPast(q.where, MAX_WHERE_JSON_DEPTH)) {
      issues.push({
        field: 'query.where',
        message: `groups nest at most ${MAX_WHERE_DEPTH} deep`,
      });
    } else if (JSON.stringify(q.where).length > MAX_VIEW_WHERE_LENGTH) {
      issues.push({
        field: 'query.where',
        message: `where is at most ${MAX_VIEW_WHERE_LENGTH} characters of JSON`,
      });
    } else {
      try {
        where = parseQueryWhere(q.where);
        const bad = queryNodeFilters(where).find((f) => !isPlainValue(f.value));
        if (bad) {
          issues.push({
            field: 'query.where',
            message: `${bad.field}: a value is a string, number, boolean or a list of them`,
          });
        }
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        issues.push(...err.issues.map((i) => ({ ...i, field: `query.${i.field}` })));
      }
    }
  }

  // Component paths cost a JSON walk per row: a view's filters and tree share one budget.
  const paths = [...(filters ?? []), ...queryNodeFilters(where)].filter(
    (f) => fieldPath(f.field).length > 1,
  ).length;
  if (paths > MAX_PATH_FILTERS) {
    issues.push({
      field: 'query',
      message: `a view names at most ${MAX_PATH_FILTERS} component paths (seo.title)`,
    });
  }

  let order: QueryOrder[] | undefined;
  if (q.order !== undefined) {
    if (!Array.isArray(q.order) || q.order.length > MAX_VIEW_ORDER) {
      issues.push({
        field: 'query.order',
        message: `expected at most ${MAX_VIEW_ORDER} sort keys: { field, direction }`,
      });
    } else {
      order = [];
      q.order.forEach((o, i) => {
        const at = `query.order[${i}]`;
        const key = (o ?? {}) as { field?: unknown; direction?: unknown };
        const field =
          typeof key.field === 'string' && key.field.startsWith('fields.')
            ? key.field.slice('fields.'.length)
            : key.field;
        if (!isQueryField(field) || field === '*') {
          issues.push({ field: at, message: `"${String(field)}" is not a field a sort can name` });
        } else if (key.direction !== 'asc' && key.direction !== 'desc') {
          issues.push({ field: at, message: 'direction is asc or desc' });
        } else {
          order?.push({ field, direction: key.direction });
        }
      });
    }
  }

  let search: string | undefined;
  if (q.search !== undefined && q.search !== null) {
    const text = typeof q.search === 'string' ? q.search.trim() : null;
    if (text === null || text.length > MAX_VIEW_SEARCH_LENGTH || CONTROL.test(text)) {
      issues.push({
        field: 'query.search',
        message: `search is text of at most ${MAX_VIEW_SEARCH_LENGTH} characters`,
      });
    } else if (text) search = text;
  }

  let extra: Record<string, unknown> | undefined;
  if (q.extra !== undefined && q.extra !== null) {
    const e = q.extra;
    if (typeof e !== 'object' || Array.isArray(e)) {
      issues.push({ field: 'query.extra', message: 'extra is an object of query keys' });
    } else {
      const entries = Object.entries(e as Record<string, unknown>);
      const read = entries
        .map(([k]) => k)
        .filter((k) => EXTRA_KEY.test(k) && !isSavedViewExtraKey(k));
      if (read.length) {
        issues.push({
          field: 'query.extra',
          message: `extra keeps keys this version doesn't read; not ${read.join(', ')}: use filters, where, order or search`,
        });
      } else if (
        entries.length > MAX_VIEW_EXTRA_KEYS ||
        // Values first: only plain ones are short enough to stringify unchecked.
        entries.some(([k, v]) => !EXTRA_KEY.test(k) || !isPlainValue(v)) ||
        JSON.stringify(e).length > MAX_VIEW_EXTRA_LENGTH
      ) {
        issues.push({
          field: 'query.extra',
          message: `extra holds at most ${MAX_VIEW_EXTRA_KEYS} query keys with plain values, ${MAX_VIEW_EXTRA_LENGTH} characters of JSON`,
        });
      } else if (entries.length) extra = Object.fromEntries(entries);
    }
  }

  if (issues.length) throw new ValidationError(issues);
  return {
    ...(filters?.length ? { filters } : {}),
    ...(where ? { where } : {}),
    ...(order?.length ? { order } : {}),
    ...(search ? { search } : {}),
    ...(extra ? { extra } : {}),
  };
}

/**
 * Reads a view's columns: unique, at most {@link MAX_VIEW_COLUMNS}, each a {@link
 * VIEW_SYS_COLUMNS} name or a top-level field the type declares. A view over every type shows
 * `sys.*` columns only (no one field means the same thing in every type). `null` is the default.
 */
export function checkSavedViewColumns(
  raw: unknown,
  type: ContentType | null,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_VIEW_COLUMNS) {
    return fail('columns', `columns is a list of at most ${MAX_VIEW_COLUMNS} column names`);
  }
  const sys = new Set<string>(VIEW_SYS_COLUMNS);
  const fields = new Set(type?.fields.map((f) => f.apiId) ?? []);
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  raw.forEach((c, i) => {
    const at = `columns[${i}]`;
    const name = typeof c === 'string' && c.startsWith('fields.') ? c.slice('fields.'.length) : c;
    if (typeof name !== 'string') issues.push({ field: at, message: 'a column is a name' });
    else if (seen.has(name)) issues.push({ field: at, message: `"${name}" is listed twice` });
    else if (sys.has(name)) seen.add(name);
    else if (!type) {
      issues.push({
        field: at,
        message: `a view over every type shows only ${VIEW_SYS_COLUMNS.join(', ')}`,
      });
    } else if (!FIELD_ID.test(name) || !fields.has(name)) {
      issues.push({ field: at, message: `${type.apiId} has no field "${name}"` });
    } else seen.add(name);
  });
  if (issues.length) throw new ValidationError(issues);
  return [...seen];
}

/**
 * The columns a save stores, given the ones the caller sent (`undefined`: back to the default).
 * What `principal` is shown leaves out the columns their role hides ({@link savedViewFor}), so
 * what they send can't name them: those stay where they stood, for everyone else's sake. A column
 * they send that their role hides and the view doesn't hold isn't added.
 */
export function savedViewColumnsAfter(
  principal: Principal,
  view: Pick<SavedView, 'contentTypeApiId' | 'columns'>,
  given: readonly string[] | undefined,
): readonly string[] | undefined {
  const denied = new Set(
    view.contentTypeApiId ? deniedFieldsFor(principal, view.contentTypeApiId) : [],
  );
  const stored = view.columns ?? [];
  if (denied.size === 0 || (!given && !stored.some((c) => denied.has(c)))) return given;
  const next = (given ?? DEFAULT_VIEW_COLUMNS).filter((c) => !denied.has(c));
  stored.forEach((c, i) => {
    if (denied.has(c)) next.splice(Math.min(i, next.length), 0, c);
  });
  if (next.length > MAX_VIEW_COLUMNS) {
    fail('columns', `A view holds at most ${MAX_VIEW_COLUMNS} columns, those your role hides too`);
  }
  return next;
}

/** The entries query a view runs: its type and its applied query parts (never `extra`). */
export function savedViewEntryQuery(view: Pick<SavedView, 'contentTypeApiId' | 'query'>): {
  readonly contentTypeApiId?: string;
  readonly filters?: readonly QueryFilter[];
  readonly where?: QueryNode;
  readonly order?: readonly QueryOrder[];
  readonly search?: string;
} {
  const { extra: _extra, ...applied } = view.query;
  return {
    ...(view.contentTypeApiId ? { contentTypeApiId: view.contentTypeApiId } : {}),
    ...applied,
  };
}

/** True when `principal` is the person a personal view belongs to. */
export function ownsSavedView(principal: Principal, view: Pick<SavedView, 'createdBy'>): boolean {
  return isPersonPrincipal(principal) && principal.subject === view.createdBy;
}

/**
 * Whether `principal` may see a view at all: a personal view only its owner; any view only who
 * can read its content type; and a view whose query names a field the principal's role hides
 * (a filter, a `where` predicate, a sort key) or searches a type with hidden fields, nobody under
 * that role. The query alone answers questions about the field, whatever is masked, so such a
 * view is skipped rather than shown and refused. The same goes for a view naming who wrote an
 * entry, for a key that isn't served author ids.
 */
export function canSeeSavedView(principal: Principal, view: SavedView): boolean {
  if (view.visibility === 'personal' && !ownsSavedView(principal, view)) return false;
  if (view.contentTypeApiId && !canAccessContentType(principal, 'read', view.contentTypeApiId)) {
    return false;
  }
  try {
    const query = savedViewEntryQuery(view);
    assertQueryRespectsFieldRules(principal, query);
    assertAuthorIdQuery(principal, query);
    return true;
  } catch {
    return false;
  }
}

/**
 * A view as `principal` is shown it: columns naming a field their role hides are left out (the
 * column would only ever be empty for them, and its values are masked anyway), and so is who
 * created it for a key that isn't served author ids, as an entry's author is.
 */
export function savedViewFor(principal: Principal, view: SavedView): ServedSavedView {
  const shown = withAuthorIdsFor(principal, view);
  if (!shown.columns || !shown.contentTypeApiId) return shown;
  const denied = new Set(deniedFieldsFor(principal, shown.contentTypeApiId));
  if (denied.size === 0) return shown;
  return { ...shown, columns: shown.columns.filter((c) => !denied.has(c)) };
}

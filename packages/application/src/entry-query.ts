/**
 * Parses field-level query parameters into a port `EntryQuery`. Shared by
 * the Delivery, Preview, and GraphQL surfaces (the GraphQL `where`/`order`
 * arguments are this syntax too, see `deliveryGraphResolvers`) so the query
 * language is identical everywhere.
 *
 * Supported syntax:
 *   - `fields.<apiId>=v`                 → equals
 *   - `fields.<apiId>[op]=v`             → op ∈ ne|in|nin|gt|gte|lt|lte|between|exists|match|startsWith
 *   - `fields.seo.title[op]=v`           → a component's member (a path of up to 4 segments)
 *   - `fields.<link>[ref]=<id>`          → the field links to that entry (`[refIn]=<id>,<id>`: any)
 *   - `links_to_entry=<id>`              → any field links to that entry (`<id>,<id>`: any)
 *   - `where=<json>`                     → AND/OR groups of predicates (`parseQueryWhere`)
 *   - `sys.publishedAt[gt]=<iso>`        → `sys.*` pseudo-fields
 *   - `sys.createdBy=me`                 → authorship; `me` is the caller (see `resolveMe`)
 *   - `metadata.tags[in]=<id>,<id>`      → taxonomy associations by id (also `metadata.concepts`)
 *   - `metadata.tags.slug=news`          → by slug (eq|ne|in|nin; also `metadata.concepts.slug`)
 *   - `order=fields.title,-sys.publishedAt`  → sort keys (`-` = descending)
 *   - `select=fields.title,fields.body`  → projection (field apiIds)
 *   - `query=foo`                        → full-text search over string fields
 *   - `content_type`, `limit`, `skip`, `since`, `locale`  → as before
 */

import {
  ANY_FIELD,
  assertPathFilterBudget,
  ENTRY_FILTER_KEY,
  FILTER_OPS,
  type FilterOp,
  parseQueryWhere,
  type QueryFilter,
  type QueryOrder,
  queryFilterIssues,
  queryNodeFilters,
  ValidationError,
} from '@commerceworker/domain';
import type { EntryQuery } from '@commerceworker/ports';

const OPS: ReadonlySet<string> = new Set(FILTER_OPS);

/** The longest `where` parameter read, in characters: a bounded tree is far shorter. */
export const MAX_WHERE_LENGTH = 8192;

/** Largest page a client may request; caps memory/DB work per request. */
export const MAX_PAGE_LIMIT = 100;

/**
 * Coerces a raw `limit`/`skip`/`top_k` string to a bounded non-negative integer,
 * defending the store from `NaN`, negative, `Infinity`, or absurd values that
 * would otherwise reach `LIMIT`/`OFFSET`. Returns `undefined` for an absent
 * value so callers keep their own default.
 */
export function clampCount(
  raw: string | number | undefined,
  max: number,
  { min = 0 }: { min?: number } = {},
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) return min;
  // ±Infinity clamps naturally: Math.max(Infinity, min) → Infinity → Math.min → max.
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Strips the leading `fields.` namespace; leaves `sys.*` keys intact. */
function fieldName(path: string): string {
  return path.startsWith('fields.') ? path.slice('fields.'.length) : path;
}

const list = (raw: string) => raw.split(',').map((s) => s.trim());

function toFilter(path: string, op: string, raw: string): QueryFilter | null {
  if (!OPS.has(op)) return null;
  const field = fieldName(path);
  if (op === 'in' || op === 'nin' || op === 'between' || op === 'refIn') {
    return { field, op: op as FilterOp, value: list(raw) };
  }
  if (op === 'exists') {
    return { field, op: 'exists', value: raw !== 'false' };
  }
  return { field, op: op as FilterOp, value: raw };
}

/** Throws the filter's problems, if it has any, naming the query-string key it came from. */
function checked(filter: QueryFilter, key: string): QueryFilter {
  const issues = queryFilterIssues(filter, key);
  if (issues.length) throw new ValidationError(issues);
  return filter;
}

/** Reads one `where` parameter as JSON; the domain checks the tree once they are merged. */
function whereJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError([{ field: 'where', message: 'where must be JSON' }]);
  }
}

const isAndGroup = (v: unknown): v is { and: unknown[] } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  Array.isArray((v as { and?: unknown }).and);

/**
 * ANDs several `where` trees (raw JSON, unchecked) into one without adding a level: an AND
 * group's conditions join the root's, anything else becomes one of them. One tree comes back as
 * it is. The result is what `parseQueryWhere` then checks, so repeated `where` parameters (or
 * GraphQL's `and` and `or` keys) share one depth and size budget.
 */
export function mergeWhereJson(trees: readonly unknown[]): unknown {
  if (trees.length === 1) return trees[0];
  return { and: trees.flatMap((t) => (isAndGroup(t) ? t.and : [t])) };
}

function parseOrder(raw: string): QueryOrder[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const direction = token.startsWith('-') ? 'desc' : 'asc';
      const path = token.replace(/^-/, '');
      return { field: fieldName(path), direction };
    });
}

/** Builds an `EntryQuery` from raw query-string entries (key/value pairs). */
export function entryQueryFrom(entries: Iterable<[string, string]>): EntryQuery {
  const filters: QueryFilter[] = [];
  let order: QueryOrder[] | undefined;
  let select: string[] | undefined;
  let search: string | undefined;
  let contentTypeApiId: string | undefined;
  let limit: number | undefined;
  let skip: number | undefined;
  let since: string | undefined;
  let locale: string | undefined;
  let archived: boolean | undefined;
  const whereTrees: unknown[] = [];
  let whereLength = 0;

  for (const [key, value] of entries) {
    if (key === 'order') {
      order = parseOrder(value);
      continue;
    }
    if (key === 'select') {
      select = value
        .split(',')
        .map((s) => fieldName(s.trim()))
        .filter((s) => s && !s.startsWith('sys.'));
      continue;
    }
    if (key === 'query') {
      search = value;
      continue;
    }
    if (key === 'content_type') {
      contentTypeApiId = value;
      continue;
    }
    if (key === 'limit') {
      limit = clampCount(value, MAX_PAGE_LIMIT, { min: 1 });
      continue;
    }
    if (key === 'skip') {
      skip = clampCount(value, Number.MAX_SAFE_INTEGER, { min: 0 });
      continue;
    }
    if (key === 'since') {
      since = value;
      continue;
    }
    if (key === 'locale') {
      locale = value;
      continue;
    }
    // `?trashed=true` switches a list to the trash view. Anything else — absent,
    // "false", a typo — means the normal list, so a malformed value can never
    // silently hide live content.
    if (key === 'trashed') {
      archived = value === 'true';
      continue;
    }
    if (key === 'where') {
      // Empty is absent, as it was before `where` existed.
      if (value.trim() === '') continue;
      // Repeated `where` parameters AND together, within one length budget.
      whereLength += value.length;
      if (whereLength > MAX_WHERE_LENGTH) {
        throw new ValidationError([
          { field: 'where', message: `where is at most ${MAX_WHERE_LENGTH} characters` },
        ]);
      }
      whereTrees.push(whereJson(value));
      continue;
    }
    if (key === 'links_to_entry') {
      const ids = list(value).filter(Boolean);
      // Empty is absent, as an MCP call without `linksToEntry` is.
      if (ids.length === 0) continue;
      filters.push(
        checked(
          ids.length === 1
            ? { field: ANY_FIELD, op: 'ref', value: ids[0] }
            : { field: ANY_FIELD, op: 'refIn', value: ids },
          key,
        ),
      );
      continue;
    }
    const m = ENTRY_FILTER_KEY.exec(key);
    if (m) {
      const filter = toFilter(m[1] as string, m[2] ?? 'eq', value);
      if (filter) filters.push(checked(filter, key));
    }
  }

  const where = whereTrees.length ? parseQueryWhere(mergeWhereJson(whereTrees)) : undefined;
  assertPathFilterBudget({ ...(where ? { where } : {}) });

  return {
    contentTypeApiId,
    limit,
    skip,
    since,
    locale,
    archived,
    filters: filters.length ? filters : undefined,
    ...(where ? { where } : {}),
    order,
    select,
    search,
  };
}

/**
 * Whether a query filters by referenced entry: the stores then need the content model
 * (`EntryQuery.contentTypes`) to read links the way the reference edges record them.
 */
export function usesReferenceFilters(query: Pick<EntryQuery, 'filters' | 'where'>): boolean {
  return [...(query.filters ?? []), ...queryNodeFilters(query.where)].some(
    (f) => f.op === 'ref' || f.op === 'refIn',
  );
}

/** Convenience: parse straight from a `URLSearchParams`. */
export function parseEntryQuery(params: URLSearchParams): EntryQuery {
  return entryQueryFrom(params.entries());
}

/** The `sys.*` fields that name an actor, where `me` stands for the caller. */
const ACTOR_FIELDS: ReadonlySet<string> = new Set(['sys.createdBy', 'sys.updatedBy']);

/** The value that stands for the caller in an actor filter: `sys.createdBy=me`. */
export const ME = 'me';

/**
 * Replaces `me` in the query's actor filters (`sys.createdBy`, `sys.updatedBy`, any operator) with
 * the caller's actor id, so "my entries" is one query parameter on every surface. Without a caller
 * to name (`actor` null), `me` matches nothing rather than an actor literally called "me".
 */
export function resolveMe(query: EntryQuery, actor: string | null): EntryQuery {
  if (!query.filters?.some((f) => ACTOR_FIELDS.has(f.field))) return query;
  // No actor id is empty, so an unnamed caller's `me` matches no entry.
  const me = actor ?? '';
  const swap = (v: unknown) => (v === ME ? me : v);
  return {
    ...query,
    filters: query.filters.map((f) =>
      ACTOR_FIELDS.has(f.field)
        ? { ...f, value: Array.isArray(f.value) ? f.value.map(swap) : swap(f.value) }
        : f,
    ),
  };
}

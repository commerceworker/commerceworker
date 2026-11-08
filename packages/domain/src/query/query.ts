/**
 * Field-level query primitives shared by every store adapter (D1 and the
 * in-memory test store) so filtering/ordering/search behave identically across
 * surfaces. Pure domain logic: no infrastructure, no port types.
 *
 * Field values are localized (`locale -> value`); a query compares against a
 * single comparable scalar resolved from the requested locale, falling back to
 * the field's first (default-locale) value — keeping localized and
 * non-localized fields uniform.
 */

import type { ContentType } from '../content-type/content-type';
import type { Entry } from '../entry/entry';
import { ValidationError } from '../errors';
import { extractReferences } from '../reference/references';
import type { EntryFields, LocaleCode, LocalizedValue } from '../types';

/** The comparison operators a field filter may use, in the order the docs list them. */
export const FILTER_OPS = [
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
] as const;

/**
 * The comparison operators a field filter may use. `match` is a case-insensitive substring and
 * `startsWith` a case-insensitive prefix; `between` takes `[low, high]`, both inclusive; `ref`
 * (one entry id) and `refIn` (several) match a field that links to one of those entries.
 */
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * The `field` of a reference filter that looks in every field: `links_to_entry`. Only `ref` and
 * `refIn` take it.
 */
export const ANY_FIELD = '*';

/**
 * A filter's query-string key: `fields.<apiId>` (with up to three component segments after it),
 * `sys.<name>`, or a taxonomy association, `metadata.tags` / `metadata.concepts` (ids) and
 * `metadata.tags.slug` / `metadata.concepts.slug` (slugs), each with an optional `[op]`.
 */
export const ENTRY_FILTER_KEY =
  /^(fields\.[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*){0,3}|sys\.[A-Za-z0-9_]+|metadata\.(?:tags|concepts)(?:\.slug)?)(?:\[(\w+)\])?$/;

/** The query-string keys an entries list reads beside its filters. */
export const ENTRY_QUERY_PARAMS = [
  'content_type',
  'cursor',
  'limit',
  'links_to_entry',
  'locale',
  'order',
  'preview_token',
  'query',
  'select',
  'since',
  'skip',
  'trashed',
  'where',
] as const;

/** A single field-level predicate. `field` may be a content field apiId, a path into a
 *  component (`seo.title`), a `sys.*` pseudo-field (e.g. `sys.publishedAt`), a `metadata.*`
 *  association, or {@link ANY_FIELD} for a reference filter over every field. */
export interface QueryFilter {
  readonly field: string;
  readonly op: FilterOp;
  /** Comparand: scalar for eq/ne/gt…; array for in/nin/refIn; `[low, high]` for between;
   *  boolean for exists; an entry id for ref. */
  readonly value?: unknown;
}

/** All of its conditions match. */
export interface QueryAnd {
  readonly and: readonly QueryNode[];
}

/** At least one of its conditions matches. */
export interface QueryOr {
  readonly or: readonly QueryNode[];
}

/** A condition of a `where` tree: a field predicate, or an AND or OR group of conditions. */
export type QueryNode = QueryFilter | QueryAnd | QueryOr;

/** Groups nest at most this deep (the root group is depth 1). */
export const MAX_WHERE_DEPTH = 4;
/** A `where` tree holds at most this many field predicates, however they are grouped. */
export const MAX_WHERE_CONDITIONS = 20;
/** An `in`, `nin` or `refIn` list holds at most this many values. */
export const MAX_FILTER_VALUES = 100;
/** A component path (`seo.title`, `blocks.card.heading`) has at most this many segments. */
export const MAX_FIELD_PATH_SEGMENTS = 4;
/**
 * Component paths: each is a JSON tree walk per candidate row in the store, so their number is
 * the cost to bound. A `where` tree names at most this many; the store pushes at most this many
 * of a query's paths into SQL, and the engine evaluates the rest.
 */
export const MAX_PATH_FILTERS = 4;

/** The operators the query language gained with `where`: always checked strictly. */
const NEW_OPS: ReadonlySet<string> = new Set(['between', 'startsWith', 'ref', 'refIn']);

/**
 * An entry id a reference filter may carry: printable ASCII with no `"` or `\`, so its JSON form
 * is the id in quotes, which the store looks for in the stored JSON before walking it.
 */
const REF_ID = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

/**
 * A field a filter may name, once any `fields.` prefix is stripped: a content field apiId with up
 * to three component segments after it (each an identifier, so a path can never read as an array
 * index), a `sys.*` pseudo-field, a taxonomy association, or {@link ANY_FIELD}.
 */
const FILTER_FIELD =
  /^(?:\*|sys\.[A-Za-z0-9_]+|metadata\.(?:tags|concepts)(?:\.slug)?|[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*){0,3})$/;

/** True when `field` is a name a filter or an order may use ({@link FILTER_FIELD}'s forms). */
export function isQueryField(field: unknown): field is string {
  return typeof field === 'string' && FILTER_FIELD.test(field);
}

/** True for an AND or OR group, false for a field predicate. */
export function isQueryGroup(node: QueryNode): node is QueryAnd | QueryOr {
  return 'and' in node || 'or' in node;
}

/** Every field predicate in a `where` tree, however it is grouped. */
export function queryNodeFilters(node: QueryNode | undefined): QueryFilter[] {
  if (!node) return [];
  if ('and' in node) return node.and.flatMap(queryNodeFilters);
  if ('or' in node) return node.or.flatMap(queryNodeFilters);
  return [node];
}

/** A content field's path segments (`seo.title` → `['seo', 'title']`); `sys.*`/`metadata.*` are
 *  not content paths and come back whole. */
export function fieldPath(field: string): readonly string[] {
  if (field.startsWith('sys.') || field.startsWith('metadata.')) return [field];
  return field.split('.');
}

type Issue = { readonly field: string; readonly message: string };

/**
 * Checks one field predicate: a field the query language knows, an operator it supports, and a
 * comparand of the operator's shape. Returns the problems, empty when it is valid. `at` names the
 * predicate in the issues (`where.or[1]`, `fields.title[between]`).
 *
 * `strict` is for input that is new with this query language (a `where` tree): every check
 * applies, `in`/`nin` lists are capped and `match` needs a needle. Otherwise only the new
 * operators and {@link ANY_FIELD} are checked, so a filter the API always accepted (an empty
 * `match`, which means "has a value"; a long `in` list, which travels as one JSON parameter)
 * keeps working as it did.
 */
export function queryFilterIssues(
  f: QueryFilter,
  at: string,
  { strict = false }: { strict?: boolean } = {},
): Issue[] {
  const op = f.op as string;
  if (!strict && !NEW_OPS.has(op) && f.field !== ANY_FIELD) return [];
  const issues: Issue[] = [];
  if (!(FILTER_OPS as readonly string[]).includes(op)) {
    return [{ field: at, message: `op must be one of ${FILTER_OPS.join(', ')}` }];
  }
  if (typeof f.field !== 'string' || !FILTER_FIELD.test(f.field)) {
    return [{ field: at, message: `"${String(f.field)}" is not a field a query can name` }];
  }
  const isRef = op === 'ref' || op === 'refIn';
  const content = !f.field.startsWith('sys.') && !f.field.startsWith('metadata.');
  if (f.field === ANY_FIELD && !isRef) {
    issues.push({ field: at, message: `"${ANY_FIELD}" takes only ref and refIn` });
  }
  if (isRef && (!content || f.field.includes('.'))) {
    issues.push({ field: at, message: `${op} filters a top-level content field, not ${f.field}` });
  }
  const isId = (v: unknown) => typeof v === 'string' && REF_ID.test(v);
  const list = (min: number) =>
    Array.isArray(f.value) && f.value.length >= min && f.value.length <= MAX_FILTER_VALUES;
  switch (op) {
    case 'ref':
      if (!isId(f.value)) issues.push({ field: at, message: 'ref takes one entry id' });
      break;
    case 'refIn':
      if (!list(1) || !(f.value as unknown[]).every(isId))
        issues.push({
          field: at,
          message: `refIn takes 1 to ${MAX_FILTER_VALUES} entry ids`,
        });
      break;
    case 'in':
    case 'nin':
      if (!list(1))
        issues.push({ field: at, message: `${op} takes 1 to ${MAX_FILTER_VALUES} values` });
      break;
    case 'between':
      if (!Array.isArray(f.value) || f.value.length !== 2)
        issues.push({ field: at, message: 'between takes two values: [low, high]' });
      break;
    case 'match':
    case 'startsWith':
      if (typeof f.value !== 'string' || f.value === '')
        issues.push({ field: at, message: `${op} takes a non-empty string` });
      break;
  }
  return issues;
}

/**
 * Refuses a `where` tree naming more than {@link MAX_PATH_FILTERS} component paths. Only `where`,
 * which is new: top-level path filters were accepted before (and ignored), so any number of them
 * still is; the store pushes at most {@link MAX_PATH_FILTERS} paths into SQL and leaves the rest
 * to the engine.
 */
export function assertPathFilterBudget(query: { readonly where?: QueryNode }): void {
  const paths = queryNodeFilters(query.where).filter((f) => fieldPath(f.field).length > 1).length;
  if (paths > MAX_PATH_FILTERS) {
    throw new ValidationError([
      {
        field: 'where',
        message: `where names at most ${MAX_PATH_FILTERS} component paths (seo.title)`,
      },
    ]);
  }
}

/**
 * Reads a `where` tree from untrusted JSON (a query-string parameter, a GraphQL argument, an MCP
 * tool's input): AND and OR groups (`{"and": [...]}`, `{"or": [...]}`) of field predicates
 * (`{"field": "fields.title", "op": "startsWith", "value": "A"}`), nested at most
 * {@link MAX_WHERE_DEPTH} deep and holding at most {@link MAX_WHERE_CONDITIONS} predicates. A
 * field may carry the query string's `fields.` prefix. Throws a `ValidationError` naming every
 * problem; a tree it returns is safe to hand any store.
 *
 * Slug filters (`metadata.tags.slug`) are refused inside a tree: Delivery turns them into ids
 * before the query runs, which it does for top-level filters only.
 */
export function parseQueryWhere(raw: unknown): QueryNode {
  const tooMany = () =>
    new ValidationError([
      { field: 'where', message: `where holds at most ${MAX_WHERE_CONDITIONS} conditions` },
    ]);
  const issues: Issue[] = [];
  let conditions = 0;
  const walk = (value: unknown, at: string, depth: number): QueryNode | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ field: at, message: 'expected an object: a field predicate, and or or' });
      return null;
    }
    const v = value as Record<string, unknown>;
    const groupKey = 'and' in v ? 'and' : 'or' in v ? 'or' : null;
    if (groupKey) {
      if (Object.keys(v).length !== 1) {
        issues.push({ field: at, message: `a group holds only "${groupKey}"` });
        return null;
      }
      if (depth >= MAX_WHERE_DEPTH) {
        issues.push({ field: at, message: `groups nest at most ${MAX_WHERE_DEPTH} deep` });
        return null;
      }
      const children = v[groupKey];
      if (!Array.isArray(children) || children.length === 0) {
        issues.push({ field: `${at}.${groupKey}`, message: 'expected a non-empty array' });
        return null;
      }
      // A group with more children than the whole tree may hold is refused before it is read.
      if (children.length > MAX_WHERE_CONDITIONS) throw tooMany();
      const nodes = children.map((c, i) => walk(c, `${at}.${groupKey}[${i}]`, depth + 1));
      if (nodes.some((n) => n === null)) return null;
      return groupKey === 'and' ? { and: nodes as QueryNode[] } : { or: nodes as QueryNode[] };
    }
    conditions += 1;
    // Past the cap there is no answer worth computing: stop rather than walk a huge tree.
    if (conditions > MAX_WHERE_CONDITIONS) throw tooMany();
    const field =
      typeof v.field === 'string' && v.field.startsWith('fields.')
        ? v.field.slice('fields.'.length)
        : v.field;
    const filter = {
      field,
      op: v.op === undefined ? 'eq' : v.op,
      ...(v.value !== undefined ? { value: v.value } : {}),
    } as QueryFilter;
    if (typeof field === 'string' && field.endsWith('.slug') && field.startsWith('metadata.')) {
      issues.push({ field: at, message: 'filter tags and concepts by id inside where' });
      return null;
    }
    const problems = queryFilterIssues(filter, at, { strict: true });
    issues.push(...problems);
    return problems.length ? null : filter;
  };
  const root = walk(raw, 'where', 0);
  if (issues.length || !root) throw new ValidationError(issues);
  return root;
}

/** A sort key. `field` may be a content field apiId or a `sys.*` pseudo-field. */
export interface QueryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * Resolves the comparable scalar for a localized value: the requested locale,
 * then each locale in `fallbacks` (the space's default-locale chain), then any
 * remaining locale in SORTED key order.
 *
 * The sort matters for correctness, not tidiness: a store need not preserve the
 * key insertion order of a localized JSON value (a database's JSON type may
 * reorder keys), while the in-memory store keeps insertion order.
 * Iterating raw key order would therefore resolve a different locale per
 * backend for any field missing the requested locale — the same query
 * returning different rows depending on the store. Sorting makes the fallback
 * deterministic everywhere; `fallbacks` makes it semantically right.
 *
 * `hidden`, when set, names locales the value may never come from (Delivery's: the ones the space
 * doesn't deliver), so neither the chain nor the any-locale tail reaches one of them.
 */
export function comparableValue(
  lv: LocalizedValue | undefined,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
  hidden?: readonly LocaleCode[],
): unknown {
  if (!lv) return undefined;
  const present = (loc: string) =>
    lv[loc] !== undefined && lv[loc] !== null && !hidden?.includes(loc);
  if (locale && present(locale)) return lv[locale];
  for (const f of fallbacks ?? []) {
    if (present(f)) return lv[f];
  }
  // Non-localized fields hold a single (default-locale) value; localized fields
  // missing every preferred locale degrade to the first value in sorted key
  // order — arbitrary but identical across stores.
  for (const k of Object.keys(lv).sort()) {
    if (present(k)) return lv[k];
  }
  return undefined;
}

/** Coerces a string comparand to the runtime type of the field value it is
 *  compared against (query strings are untyped; field values are not). */
function coerce(filterValue: unknown, fieldValue: unknown): unknown {
  if (typeof filterValue !== 'string') return filterValue;
  if (typeof fieldValue === 'number') {
    const n = Number(filterValue);
    return Number.isNaN(n) ? filterValue : n;
  }
  if (typeof fieldValue === 'boolean') {
    if (filterValue === 'true') return true;
    if (filterValue === 'false') return false;
  }
  return filterValue;
}

/** Orders two comparable scalars; numbers numerically, otherwise lexically.
 *  `undefined`/`null` sort last. */
export function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Case-insensitive text tests: a substring (`match`) or a prefix (`startsWith`). */
function textMatches(op: 'match' | 'startsWith', fieldValue: unknown, needle: unknown): boolean {
  if (fieldValue === undefined || fieldValue === null) return false;
  const hay = String(fieldValue).toLowerCase();
  const n = String(needle).toLowerCase();
  return op === 'match' ? hay.includes(n) : hay.startsWith(n);
}

/** Evaluates a single operator against a resolved field value. */
export function matchOp(op: FilterOp, fieldValue: unknown, filterValue: unknown): boolean {
  // Array-valued fields (e.g. metadata.tags) match by membership/intersection.
  if (Array.isArray(fieldValue)) {
    const wanted = Array.isArray(filterValue) ? filterValue : [filterValue];
    switch (op) {
      // A text test on a list (a Symbol list, or a component path through a blocks field)
      // matches when one of its values does.
      case 'match':
      case 'startsWith':
        return fieldValue.some(
          (v) => (typeof v !== 'object' || v === null) && textMatches(op, v, filterValue),
        );
      case 'exists': {
        const want = filterValue === undefined ? true : Boolean(filterValue);
        const present = fieldValue.length > 0;
        return want === present;
      }
      case 'eq':
      case 'in':
        return wanted.some((w) => fieldValue.includes(w));
      case 'ne':
      case 'nin':
        return !wanted.some((w) => fieldValue.includes(w));
      default:
        return false;
    }
  }
  switch (op) {
    case 'exists': {
      const present = fieldValue !== undefined && fieldValue !== null;
      // A bare `exists` (no comparand) asserts presence.
      const want = filterValue === undefined ? true : Boolean(filterValue);
      return present === want;
    }
    case 'in':
    case 'nin': {
      const arr = (Array.isArray(filterValue) ? filterValue : [filterValue]).map((v) =>
        coerce(v, fieldValue),
      );
      const found = arr.some((v) => v === fieldValue);
      return op === 'in' ? found : !found;
    }
    case 'match':
    case 'startsWith':
      return textMatches(op, fieldValue, filterValue);
    case 'between': {
      if (!Array.isArray(filterValue) || filterValue.length !== 2) return false;
      if (fieldValue === undefined || fieldValue === null) return false;
      const [low, high] = filterValue;
      return (
        compareValues(fieldValue, coerce(low, fieldValue)) >= 0 &&
        compareValues(fieldValue, coerce(high, fieldValue)) <= 0
      );
    }
    default: {
      const fv = coerce(filterValue, fieldValue);
      switch (op) {
        case 'eq':
          return fieldValue === fv;
        case 'ne':
          return fieldValue !== fv;
        case 'gt':
          return compareValues(fieldValue, fv) > 0;
        case 'gte':
          return compareValues(fieldValue, fv) >= 0;
        case 'lt':
          return compareValues(fieldValue, fv) < 0;
        case 'lte':
          return compareValues(fieldValue, fv) <= 0;
        default:
          return false;
      }
    }
  }
}

/**
 * One step down a component path: a component's member, or, through a list (a blocks field, a
 * list of components), every element's member, flattened. Anything else has no such member.
 */
function pluck(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((el) => {
      const v = pluck(el, segment);
      return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
    });
  }
  if (value && typeof value === 'object') return (value as Record<string, unknown>)[segment];
  return undefined;
}

/**
 * The `sys.*` record of a draft (current) entry, as Preview and Management filter and sort it:
 * `sys.createdBy=…`, `order=-sys.firstPublishedAt`. Every store builds it here, so the names are
 * the same on every backend. Unknown authorship is undefined (it matches no comparison).
 */
export function entrySysOf(entry: Entry, updatedAt: string | undefined): Record<string, unknown> {
  return {
    id: entry.id,
    contentType: entry.contentTypeApiId,
    status: entry.status,
    updatedAt,
    createdAt: entry.createdAt ?? undefined,
    createdBy: entry.createdBy ?? undefined,
    updatedBy: entry.updatedBy ?? undefined,
    firstPublishedAt: entry.firstPublishedAt ?? undefined,
    // The manual order: the entry's own key, or its id until it is moved.
    position: entry.position ?? entry.id,
  };
}

/** Resolves a filter/order field name to its comparable value, honoring the
 *  `sys.*` namespace (backed by the row's sys record) and component paths
 *  (`seo.title`), which read the resolved locale's value and walk into it. */
function resolveField(
  field: string,
  fields: EntryFields,
  sys: Record<string, unknown>,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
  hidden?: readonly LocaleCode[],
): unknown {
  // `sys.*` and `metadata.*` are pseudo-fields backed by the row's sys record
  // (which carries both, keyed by the bare name / the full `metadata.*` key).
  if (field.startsWith('sys.')) return sys[field.slice(4)];
  if (field.startsWith('metadata.')) return sys[field];
  const [top, ...rest] = field.split('.');
  let value = comparableValue(fields[top as string], locale, fallbacks, hidden);
  for (const segment of rest) value = pluck(value, segment);
  return value;
}

/** Deepest a link search descends into one value; a real field is far shallower. */
const MAX_LINK_DEPTH = 32;

/**
 * Does `value` hold a link to one of `ids`? A link is a `{ id, linkType: 'Entry' }` object,
 * wherever it sits. Only the fallback for a query that carries no content model: with one, links
 * are read the way the reference edges are ({@link linksToEntries}).
 */
function linksTo(value: unknown, ids: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_LINK_DEPTH || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => linksTo(v, ids, depth + 1));
  const o = value as Record<string, unknown>;
  if (o.linkType === 'Entry' && typeof o.id === 'string' && ids.has(o.id)) return true;
  return Object.values(o).some((v) => linksTo(v, ids, depth + 1));
}

/** What evaluating a predicate needs beyond the row: the locale chain and the content model. */
interface MatchContext {
  readonly locale?: LocaleCode;
  readonly fallbacks?: readonly LocaleCode[];
  /** The content types by apiId, when the query carries them ({@link EntryQueryInput.contentTypes}). */
  readonly types?: ReadonlyMap<string, ContentType>;
  /** Locales a value may never come from (Delivery's undelivered ones). */
  readonly hidden?: readonly LocaleCode[];
}

/**
 * `ref`/`refIn`: does the entry link to one of the ids through `f.field` (any field for
 * {@link ANY_FIELD}), in any locale? With the content model, the links are exactly the ones
 * {@link extractReferences} records as the reference edges, so a link-shaped value in a JSON
 * field, or in a field the type no longer declares, is not a link, and the store's edge pushdown
 * agrees with this answer. Without it, any `{ id, linkType: 'Entry' }` in the field counts.
 */
function linksToEntries(
  f: QueryFilter,
  fields: EntryFields,
  sys: Record<string, unknown>,
  ctx: MatchContext,
): boolean {
  const wanted = f.op === 'ref' ? [f.value] : Array.isArray(f.value) ? f.value : [];
  const ids = new Set(wanted.filter((v): v is string => typeof v === 'string'));
  if (ctx.types) {
    const type = ctx.types.get(String(sys.contentType));
    if (!type) return false;
    return extractReferences(String(sys.id ?? ''), fields, type).some(
      (e) =>
        e.toType === 'Entry' &&
        ids.has(e.toId) &&
        (f.field === ANY_FIELD || e.fromField === f.field),
    );
  }
  const values = f.field === ANY_FIELD ? Object.values(fields) : [fields[f.field]];
  return values.some((lv) => !!lv && Object.values(lv).some((v) => linksTo(v, ids)));
}

/** True if one field predicate matches the entry. */
function matchesFilter(
  f: QueryFilter,
  fields: EntryFields,
  sys: Record<string, unknown>,
  ctx: MatchContext,
): boolean {
  if (f.op === 'ref' || f.op === 'refIn') return linksToEntries(f, fields, sys, ctx);
  return matchOp(
    f.op,
    resolveField(f.field, fields, sys, ctx.locale, ctx.fallbacks, ctx.hidden),
    f.value,
  );
}

/** True if a `where` condition (a predicate or a group of them) matches the entry. */
function matchesNode(
  node: QueryNode,
  fields: EntryFields,
  sys: Record<string, unknown>,
  ctx: MatchContext,
): boolean {
  if ('and' in node) return node.and.every((n) => matchesNode(n, fields, sys, ctx));
  if ('or' in node) return node.or.some((n) => matchesNode(n, fields, sys, ctx));
  return matchesFilter(node, fields, sys, ctx);
}

/** True if `search` (case-insensitive) appears in any string field value. */
function matchesSearch(
  fields: EntryFields,
  search: string,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
  hidden?: readonly LocaleCode[],
): boolean {
  const needle = search.toLowerCase();
  for (const lv of Object.values(fields)) {
    const v = comparableValue(lv, locale, fallbacks, hidden);
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Projects an entry's fields down to `select` (field apiIds). */
export function projectFields(fields: EntryFields, select: readonly string[]): EntryFields {
  const keep = new Set(select);
  const out: EntryFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}

/**
 * A row's place in a query's order, for keyset paging: its value for each key of the order
 * ({@link keysetOrder}), then its id, which breaks every tie.
 */
export interface EntryKeyset {
  readonly values: readonly unknown[];
  readonly id: string;
}

/** The order an entries list has when the query names none: least recently changed first. */
export const DEFAULT_ENTRY_ORDER: readonly QueryOrder[] = [
  { field: 'sys.updatedAt', direction: 'asc' },
];

/** The order keyset paging walks: the query's own, or the store's default when it has none. */
export function keysetOrder(order: readonly QueryOrder[] | undefined): readonly QueryOrder[] {
  return order?.length ? order : DEFAULT_ENTRY_ORDER;
}

/** Where `fields` + `sys` sit in {@link keysetOrder}`(order)`: what a page's next cursor holds. */
export function entryKeysetOf(
  order: readonly QueryOrder[] | undefined,
  fields: EntryFields,
  sys: Record<string, unknown>,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
  hidden?: readonly LocaleCode[],
): EntryKeyset {
  return {
    values: keysetOrder(order).map((o) =>
      resolveField(o.field, fields, sys, locale, fallbacks, hidden),
    ),
    id: String(sys.id ?? ''),
  };
}

/** Compares two keysets in `order`: each key in its direction, then the ids ascending. */
function compareKeysets(order: readonly QueryOrder[], a: EntryKeyset, b: EntryKeyset): number {
  for (const [i, o] of order.entries()) {
    const cmp = compareValues(a.values[i], b.values[i]);
    if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a row must expose for {@link runEntryQuery} to filter/order it. */
export interface EntryQueryInput {
  readonly filters?: readonly QueryFilter[];
  /** AND and OR groups of predicates ({@link parseQueryWhere}); ANDed with `filters`. */
  readonly where?: QueryNode;
  /**
   * The content model, for reference filters: with it, `ref`/`refIn` read a row's links as the
   * reference edges record them (its type's declared link-bearing fields). Rows expose their
   * type as `sys.contentType` and their id as `sys.id`.
   */
  readonly contentTypes?: readonly ContentType[];
  readonly order?: readonly QueryOrder[];
  readonly search?: string;
  readonly skip?: number;
  readonly limit?: number;
  /**
   * Keyset paging: only rows strictly after this one in {@link keysetOrder}, ties broken by id.
   * `'start'` reads the first page in that same total order. Unset keeps the plain order (a
   * stable sort on `order`, the rows' own order without one), so existing lists are unchanged.
   */
  readonly afterRow?: EntryKeyset | 'start';
  /** Locale used to resolve field values for comparison. */
  readonly locale?: LocaleCode;
  /** Ordered fallback locales (the space's default-locale chain) tried when
   *  `locale` has no value for a field — keeps resolution deterministic and
   *  identical across stores. */
  readonly fallbackLocales?: readonly LocaleCode[];
  /**
   * Locales a comparison never reads (Delivery: the ones the space doesn't deliver). Without it a
   * field missing the preferred locales could compare an undelivered locale's value.
   */
  readonly hiddenLocales?: readonly LocaleCode[];
}

/**
 * Filters, orders and paginates `rows` by a field-level query. `fieldsOf` and
 * `sysOf` adapt each row to its localized fields and `sys.*` values, so the same
 * engine drives both the published and the draft/preview read paths.
 *
 * Projection (`select`) is applied by the caller, since it reshapes the returned
 * row's `fields` and the row type varies per surface.
 */
export function runEntryQuery<T>(
  rows: readonly T[],
  query: EntryQueryInput,
  fieldsOf: (row: T) => EntryFields,
  sysOf: (row: T) => Record<string, unknown>,
): T[] {
  let result = [...rows];

  const ctx: MatchContext = {
    locale: query.locale,
    fallbacks: query.fallbackLocales,
    hidden: query.hiddenLocales,
    ...(query.contentTypes ? { types: new Map(query.contentTypes.map((t) => [t.apiId, t])) } : {}),
  };
  const filters = query.filters ?? [];
  if (filters.length) {
    result = result.filter((r) =>
      filters.every((f) => matchesFilter(f, fieldsOf(r), sysOf(r), ctx)),
    );
  }
  if (query.where) {
    const where = query.where;
    result = result.filter((r) => matchesNode(where, fieldsOf(r), sysOf(r), ctx));
  }
  if (query.search) {
    result = result.filter((r) =>
      matchesSearch(
        fieldsOf(r),
        query.search as string,
        query.locale,
        query.fallbackLocales,
        query.hiddenLocales,
      ),
    );
  }
  if (query.afterRow !== undefined) {
    // A total order, so a page boundary is exact: the next page starts strictly after the
    // last row, whatever was edited between the two reads.
    const order = keysetOrder(query.order);
    const keyOf = (r: T) =>
      entryKeysetOf(
        order,
        fieldsOf(r),
        sysOf(r),
        query.locale,
        query.fallbackLocales,
        query.hiddenLocales,
      );
    const keyed = result.map((r) => ({ r, key: keyOf(r) }));
    keyed.sort((a, b) => compareKeysets(order, a.key, b.key));
    const after = query.afterRow;
    result = (
      after === 'start' ? keyed : keyed.filter((k) => compareKeysets(order, k.key, after) > 0)
    ).map((k) => k.r);
  } else if (query.order?.length) {
    const order = query.order;
    result.sort((a, b) => {
      for (const o of order) {
        const av = resolveField(
          o.field,
          fieldsOf(a),
          sysOf(a),
          query.locale,
          query.fallbackLocales,
          query.hiddenLocales,
        );
        const bv = resolveField(
          o.field,
          fieldsOf(b),
          sysOf(b),
          query.locale,
          query.fallbackLocales,
          query.hiddenLocales,
        );
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  const skip = query.skip ?? 0;
  const limit = query.limit ?? 100;
  return result.slice(skip, skip + limit);
}

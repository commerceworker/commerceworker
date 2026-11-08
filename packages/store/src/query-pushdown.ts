import {
  ANY_FIELD,
  fieldPath,
  isQueryGroup,
  MAX_PATH_FILTERS,
  type QueryFilter,
  type QueryNode,
  type Scope,
} from '@commerceworker/domain';
import { and, or, type SQL, sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

/**
 * SQL prefilters for field-level entry queries (SQLite JSON1).
 *
 * The domain engine (`runEntryQuery`) is the single source of truth for query
 * SEMANTICS — locale resolution order, string→field-type coercion, array
 * membership, numeric-vs-lexical comparison. Reproducing all of that in SQL
 * would risk silent divergence on the busiest read path, so this module never
 * tries to. Instead every predicate it emits is a **superset**: it may admit
 * rows the engine will later reject, but it must never exclude a row the
 * engine would have kept. The engine then runs over the (bounded) candidate
 * set and produces the exact answer.
 *
 * That turns "load the entire scoped published set into memory" into "load the
 * rows that could plausibly match", which is the actual scaling problem, while
 * keeping D1 and the in-memory store bit-identical in behavior.
 *
 * Ops with no superset-safe translation (negations, comparisons on JSON field
 * values whose ordering depends on runtime type) are simply not pushed down —
 * omitting a predicate only widens the candidate set, which is always safe.
 *
 * Field names are never spliced into JSON paths (SQLite's quoted path labels
 * cannot escape `"`); every lookup walks `json_each(fields)` and compares the
 * key as a bound parameter. A component path (`seo.title`) walks the locale
 * value with `json_tree` and compares the LAST segment's key, also bound: a
 * superset of the engine's walk down the exact path. Comparand lists travel as
 * ONE JSON-array parameter (`json_each(?)`), and the predicates as a whole stay
 * inside {@link PREFILTER_PARAM_BUDGET} (a predicate past it is left to the
 * engine), so no query can push a statement past D1's 100-parameter cap.
 *
 * OR groups push down only when every branch does: a branch left to the engine
 * could match a row the other branches' SQL would exclude.
 *
 * LINKS: `ref`/`refIn` on the published path are an `IN` over the reference
 * edges table (driven by its `(space, environment, to_id)` index), which every
 * publish rewrites in the same unit as the snapshot. Given the content model
 * (`EntryQuery.contentTypes`, which the use-cases pass), the engine reads links
 * exactly as the edges were extracted, so the two agree. The draft path has no
 * edges for drafts: there a link filter first looks for the quoted id in the
 * stored JSON (`instr`), and only then walks it for an `id` member holding it.
 *
 * CASE FOLDING: SQLite's LIKE folds ASCII only, while the engine uses JS
 * Unicode `toLowerCase`. {@link likePattern} therefore turns every needle
 * character whose folding SQLite cannot reproduce into a `%` wildcard, which
 * only widens the match. The cross-store equivalence suite carries non-ASCII
 * cases precisely to catch a regression here.
 */

/** A field value can live under any locale key; these are the JSON forms a
 *  comparand could equal once the engine coerces it to the field's type. */
function comparandForms(value: unknown): unknown[] | null {
  const forms: unknown[] = [value];
  if (typeof value === 'string') {
    // Mirror domain `coerce` EXACTLY: it converts a string comparand to a
    // number whenever `Number(s)` is not NaN, so both forms must be admitted.
    // The condition must not be "tightened" — `Number('')` is 0, not NaN, so
    // an `eq ''` filter really does match a numeric 0 field in the engine, and
    // skipping that form here would drop the row (a superset violation caught
    // by the adversarial probe in query-equivalence.test.ts).
    const n = Number(value);
    if (!Number.isNaN(n)) forms.push(n);
    if (value === 'true') forms.push(true);
    if (value === 'false') forms.push(false);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    forms.push(String(value));
  } else if (value !== null) {
    // Objects/arrays/undefined: no scalar form to match on. Not pushing the
    // predicate down is always safe.
    return null;
  }
  return forms;
}

/**
 * Does the JSON value `c` (a `json_each` row) equal one of the forms in the
 * `json_each` row `f`? Numbers compare numerically across integer/real (as in
 * the engine, where `5 === 5.0`); strings exactly; booleans and null by type.
 */
const sameScalar = (c: string, f: string) =>
  sql.raw(`((${c}.type = ${f}.type OR (${c}.type IN ('integer','real') AND ${f}.type IN ('integer','real')))
    AND (${c}.atom = ${f}.atom OR ${c}.type IN ('true','false','null')))`);

/**
 * Superset for "some value of the field passes `test`": the field exists and SOME locale's value
 * passes, or, for a component path (`seo.title`), some member named the path's last segment
 * anywhere inside the field does. `test` reads a `json_each`/`json_tree` row aliased `kv`.
 *
 * CASE, not AND: a malformed/imported (non-object) field value must widen the scan, never be
 * excluded. A path's walk starts from `fld.fullkey`, the path SQLite itself wrote for the field,
 * so the field name is only ever compared as a bound value.
 */
function fieldHas(fieldsCol: SQL, field: string, test: SQL): SQL {
  const [top, ...rest] = fieldPath(field);
  const leaf = rest.at(-1);
  const values =
    leaf === undefined
      ? sql`SELECT 1 FROM json_each(fld.value) AS kv WHERE ${test}`
      : sql`SELECT 1 FROM json_tree(${fieldsCol}, fld.fullkey) AS kv
          WHERE kv.key = ${leaf} AND ${test}`;
  // A key holding `"` widens the scan rather than being walked by its path (see {@link walkable}).
  return sql`EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE fld.key = ${top}
      AND CASE WHEN fld.type = 'object' AND ${walkable} THEN EXISTS (${values}) ELSE 1 END
  )`;
}

/**
 * True when the field's key has no `"`. A walk from `fld.fullkey` reads that key back as a path;
 * the SQLite in workerd today escapes a quote there, but a field written straight to the store
 * with one is no reason to bet a statement on it: such a field widens the scan instead.
 */
const walkable = sql.raw(`instr(fld.key, '"') = 0`);

/**
 * Superset predicate for `eq`/`in` on a content field: SOME locale's value (or, on a path, some
 * member) equals one of the comparand forms, or is an array that contains one (the engine's
 * array-field membership semantics).
 */
function fieldValueMatches(fieldsCol: SQL, field: string, values: readonly unknown[]): SQL | null {
  const forms: unknown[] = [];
  for (const v of values) {
    const f = comparandForms(v);
    if (!f) return null;
    forms.push(...f);
  }
  if (forms.length === 0) return null;
  const formsJson = JSON.stringify(forms);
  return fieldHas(
    fieldsCol,
    field,
    sql`EXISTS (
      SELECT 1 FROM json_each(${formsJson}) AS f
      WHERE ${sameScalar('kv', 'f')}
        OR (kv.type = 'array' AND EXISTS (
          SELECT 1 FROM json_each(kv.value) AS el WHERE ${sameScalar('el', 'f')}
        ))
    )`,
  );
}

/** ASCII letters that a non-ASCII character lowercases onto (İ→i̇, K→k). */
const FOLDS_FROM_NON_ASCII = new Set(['i', 'I', 'k', 'K']);

/**
 * Wraps a literal needle as a case-insensitive LIKE pattern that is a superset
 * of the engine's `haystack.toLowerCase().includes(needle.toLowerCase())`.
 *
 * - Characters SQLite cannot fold like JS does (non-ASCII, plus `i`/`k`, which
 *   `İ` and the Kelvin sign lowercase onto) and control characters become `%`.
 *   A wildcard matches any run, so differing folded lengths can't drop a row.
 * - `%` and `_` are left as wildcards on purpose: they only WIDEN the match.
 * - No ESCAPE clause is used, so a backslash is an ordinary literal character.
 */
export function likePattern(needle: string): string {
  return `%${foldSafe(needle)}%`.replace(/%{2,}/g, '%');
}

/**
 * {@link likePattern} anchored at the start: a superset of the engine's case-insensitive
 * `startsWith`. The same characters widen to `%` (a first character among them unanchors the
 * pattern, which only widens it).
 */
export function prefixPattern(needle: string): string {
  return `${foldSafe(needle)}%`.replace(/%{2,}/g, '%');
}

/** The needle with every character SQLite's LIKE cannot fold as JS does turned into `%`. */
function foldSafe(needle: string): string {
  let out = '';
  for (const ch of needle) {
    const code = ch.codePointAt(0) ?? 0;
    const safe = code >= 0x20 && code < 0x7f && !FOLDS_FROM_NON_ASCII.has(ch);
    out += safe ? ch : '%';
  }
  return out;
}

/**
 * The text the engine's `String(value)` would produce for a decoded locale
 * value, or a match-anything for value types whose rendering SQLite cannot
 * reproduce exactly (numbers: exponent formats differ; arrays/objects: JS joins
 * them, JSON text does not). Null never matches (`match` rejects null).
 */
const matchText = (kv: string, pattern: string) =>
  sql`(CASE ${sql.raw(kv)}.type
    WHEN 'text' THEN ${sql.raw(kv)}.atom WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' END
    LIKE ${pattern} OR ${sql.raw(kv)}.type NOT IN ('text', 'true', 'false', 'null'))`;

/**
 * Superset for a case-insensitive text test on a field (`pattern` from {@link likePattern} or
 * {@link prefixPattern}): does any LOCALE value of the field (or member, on a path) match? Matches
 * decoded values (`json_each` atoms), never the JSON-encoded text, where `\` and `"` appear
 * escaped.
 */
function fieldTextLike(fieldsCol: SQL, field: string, pattern: string): SQL {
  return fieldHas(fieldsCol, field, matchText('kv', pattern));
}

/**
 * Superset for `ref`/`refIn`: the row links to one of `ids` through `field` (every field for
 * {@link ANY_FIELD}). With `edges` (the published path) it reads the reference edges: rows whose
 * entry has an edge to one of the ids, found from the target's side of the index. Without them it
 * looks for an `id` member holding one of the ids anywhere inside the field's JSON, which every
 * link the engine finds has. One parameter carries the ids, as a JSON array.
 */
function linksToPredicate(
  fieldsCol: SQL,
  sys: SysColumns,
  field: string,
  ids: readonly string[],
): SQL | null {
  if (ids.length === 0) return null;
  const top = field === ANY_FIELD ? null : field;
  const idList = JSON.stringify(ids);
  if (sys.edges) {
    const r = schema.references;
    return sql`${sys.entryId} IN (
      SELECT ${r.fromEntryId} FROM ${r}
      WHERE ${r.spaceId} = ${sys.edges.spaceId} AND ${r.environmentId} = ${sys.edges.environmentId}
        AND ${r.toId} IN (SELECT value FROM json_each(${idList})) AND ${r.toType} = 'Entry'
        ${top === null ? sql`` : sql`AND ${r.fromField} = ${top}`}
    )`;
  }
  // A cheap test first: the stored JSON holds one of the ids, quoted (the domain admits only ids
  // whose JSON form is the id in quotes). Only a row that passes is walked.
  const mentions = sql`EXISTS (
    SELECT 1 FROM json_each(${idList}) AS w WHERE instr(${fieldsCol}, json_quote(w.value)) > 0
  )`;
  const idMember = sql`kv.key = 'id' AND kv.type = 'text'
    AND kv.atom IN (SELECT value FROM json_each(${idList}))`;
  if (top === null) {
    return sql`(${mentions} AND EXISTS (SELECT 1 FROM json_tree(${fieldsCol}) AS kv WHERE ${idMember}))`;
  }
  return sql`(${mentions} AND EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE fld.key = ${top} AND CASE WHEN ${walkable} THEN EXISTS (
      SELECT 1 FROM json_tree(${fieldsCol}, fld.fullkey) AS kv WHERE ${idMember}
    ) ELSE 1 END
  ))`;
}

/** Columns a `sys.*` pseudo-field maps to, when the row has a real column. */
export interface SysColumns {
  readonly entryId: SQL;
  readonly contentTypeApiId: SQL;
  /** Epoch-millisecond column (the engine sees it as an ISO string). */
  readonly publishedAt?: SQL;
  /** The published snapshot's `{ tags, concepts }` JSON, for `metadata.*` membership. */
  readonly metadata?: SQL;
  /**
   * The scope whose reference edges describe these rows' links: the published path, whose edges
   * every publish rewrites with the snapshot. Absent on the draft path (edges follow publishes,
   * not drafts), where a link filter reads the fields instead.
   */
  readonly edges?: Scope;
  /** Who created and last changed a draft entry (`sys.createdBy`, `sys.updatedBy`). */
  readonly createdBy?: SQL;
  readonly updatedBy?: SQL;
}

/** The epoch ms for an ISO comparand the engine could equal, or null if none can. */
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString() === v ? d.getTime() : null;
};

/**
 * Bound parameters the prefilter may spend in one statement. The rest of a list statement
 * (scope, content type, cursors, limit) takes well under 20 of D1's 100, so this leaves room
 * with a margin; a predicate that would cross it is left to the engine.
 */
export const PREFILTER_PARAM_BUDGET = 64;

const dialect = new SQLiteAsyncDialect();
/** How many bound parameters `q` spends. */
const paramsOf = (q: SQL): number => dialect.sqlToQuery(q).params.length;

/** The superset predicate for one field predicate, or null when it has none. */
function filterPredicate(f: QueryFilter, fieldsCol: SQL, sys: SysColumns): SQL | null {
  // `sys.*`/`metadata.*` resolve from the row's sys record. Only the ones
  // backed by real columns are pushed; metadata arrays stay in JS.
  if (f.field.startsWith('sys.')) {
    const name = f.field.slice(4);
    if (name === 'publishedAt') {
      // Stored as epoch ms; the engine compares the ISO string exactly, so
      // only a canonical ISO comparand can match — anything else is left to JS.
      if (!sys.publishedAt || f.op !== 'eq') return null;
      const ms = isoMs(f.value);
      return ms === null ? null : sql`${sys.publishedAt} = ${ms}`;
    }
    const col =
      name === 'id'
        ? sys.entryId
        : name === 'contentType'
          ? sys.contentTypeApiId
          : name === 'createdBy'
            ? sys.createdBy
            : name === 'updatedBy'
              ? sys.updatedBy
              : undefined;
    if (!col) return null;
    if (f.op === 'eq' && typeof f.value === 'string') return sql`${col} = ${f.value}`;
    if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 0) {
      const list = JSON.stringify(f.value.map((v) => String(v)));
      return sql`${col} IN (SELECT value FROM json_each(${list}))`;
    }
    // Ranges on sys columns are left to the engine (ISO-string comparison).
    return null;
  }
  if (f.field.startsWith('metadata.')) {
    // Membership (`eq`/`in`) in the tags or concepts array: a tag archive narrows to the
    // entries carrying the tag in SQL rather than pulling every candidate into the scan.
    const path =
      f.field === 'metadata.tags'
        ? '$.tags'
        : f.field === 'metadata.concepts'
          ? '$.concepts'
          : null;
    const wanted =
      f.op === 'eq' ? [f.value] : f.op === 'in' && Array.isArray(f.value) ? f.value : null;
    if (!sys.metadata || !path || !wanted || wanted.length === 0) return null;
    const list = JSON.stringify(wanted.map((v) => String(v)));
    return sql`EXISTS (SELECT 1 FROM json_each(${sys.metadata}, ${path}) m WHERE m.value IN (SELECT value FROM json_each(${list})))`;
  }

  switch (f.op) {
    case 'eq':
      return fieldValueMatches(fieldsCol, f.field, [f.value]);
    case 'in':
      if (!Array.isArray(f.value) || f.value.length === 0) return null;
      return fieldValueMatches(fieldsCol, f.field, f.value);
    case 'match':
      if (typeof f.value !== 'string' || f.value === '') return null;
      return fieldTextLike(fieldsCol, f.field, likePattern(f.value));
    case 'startsWith':
      if (typeof f.value !== 'string' || f.value === '') return null;
      return fieldTextLike(fieldsCol, f.field, prefixPattern(f.value));
    case 'ref':
      return typeof f.value === 'string'
        ? linksToPredicate(fieldsCol, sys, f.field, [f.value])
        : null;
    case 'refIn':
      if (!Array.isArray(f.value) || !f.value.every((v) => typeof v === 'string')) return null;
      return linksToPredicate(fieldsCol, sys, f.field, f.value as string[]);
    case 'exists': {
      // Only the positive form is superset-safe: `exists:false` matches rows
      // where the key is absent OR present-but-null.
      const want = f.value === undefined ? true : Boolean(f.value);
      if (!want) return null;
      const [top, ...rest] = fieldPath(f.field);
      return rest.length === 0
        ? sql`EXISTS (SELECT 1 FROM json_each(${fieldsCol}) AS fld WHERE fld.key = ${top})`
        : fieldHas(fieldsCol, f.field, sql`1`);
    }
    // ne / nin / gt / gte / lt / lte / between: no superset-safe form (negation
    // can exclude; ordering depends on the field's runtime type). Left to JS.
    default:
      return null;
  }
}

/**
 * Builds the superset prefilter for a query's top-level predicates (`filters`, all must match)
 * and its `where` tree. Returns null when nothing could be pushed down (caller scans unfiltered).
 *
 * Predicates are taken in order while they fit {@link PREFILTER_PARAM_BUDGET}; one that does not
 * fit is skipped (a wider scan), so a query with many predicates can never build a statement
 * past D1's parameter cap.
 *
 * `decided` collects the top-level reference filters pushed as edge lookups (with `sys.edges`):
 * those are exact, not a superset, so the caller may leave them out of the engine's pass.
 */
export function buildFilterPrefilter(
  query: { readonly filters?: readonly QueryFilter[]; readonly where?: QueryNode },
  fieldsCol: SQL,
  sys: SysColumns,
  decided?: Set<QueryFilter>,
): SQL | null {
  let budget = PREFILTER_PARAM_BUDGET;
  // Component paths each walk a JSON tree per row: at most MAX_PATH_FILTERS go into SQL, the
  // rest stay with the engine (a wider scan, never a refused query).
  let paths = 0;
  const predicate = (f: QueryFilter): SQL | null => {
    const isPath = fieldPath(f.field).length > 1;
    if (isPath && paths >= MAX_PATH_FILTERS) return null;
    const p = filterPredicate(f, fieldsCol, sys);
    if (p && isPath) paths += 1;
    return p;
  };
  const spend = (p: SQL | null): SQL | null => {
    if (!p) return null;
    const n = paramsOf(p);
    if (n > budget) return null;
    budget -= n;
    return p;
  };
  // A group's predicate: AND keeps what pushes down; OR only when every branch does. Built whole
  // first, then spent, so an OR that does not fit is dropped as one.
  const nodePredicate = (node: QueryNode): SQL | null => {
    if (!isQueryGroup(node)) return predicate(node);
    if ('and' in node) {
      const parts = node.and.map(nodePredicate).filter((p): p is SQL => p !== null);
      return parts.length ? (and(...parts) as SQL) : null;
    }
    const parts = node.or.map(nodePredicate);
    if (parts.some((p) => p === null)) return null;
    return or(...(parts as SQL[])) as SQL;
  };
  const conds: SQL[] = [];
  for (const f of query.filters ?? []) {
    const p = spend(predicate(f));
    if (!p) continue;
    conds.push(p);
    if (sys.edges && (f.op === 'ref' || f.op === 'refIn')) decided?.add(f);
  }
  if (query.where) {
    // The root AND's branches are spent one by one, like `filters`.
    const top = 'and' in query.where ? query.where.and : [query.where];
    for (const node of top) {
      const p = spend(nodePredicate(node));
      if (p) conds.push(p);
    }
  }
  return conds.length > 0 ? (and(...conds) as SQL) : null;
}

/**
 * Superset for free-text `search`: the engine matches a case-insensitive
 * SUBSTRING of any string field value. Tokenizing full-text search would MISS
 * substrings (`ell` in `hello`), so it cannot be used as a prefilter here — a
 * LIKE over every decoded locale value is the correct superset.
 */
export function buildSearchPrefilter(search: string, fieldsCol: SQL): SQL | null {
  if (!search.trim()) return null;
  const pattern = likePattern(search);
  return sql`EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE CASE WHEN fld.type = 'object' THEN EXISTS (
      SELECT 1 FROM json_each(fld.value) AS kv
      WHERE kv.type = 'text' AND kv.atom LIKE ${pattern}
    ) ELSE 1 END
  )`;
}

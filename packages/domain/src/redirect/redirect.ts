import type { ContentType } from '../content-type/content-type';
import { urlPath, urlPatternSlugFields } from '../content-type/content-type';
import { type FieldIssue, ValidationError } from '../errors';
import type { EntryFields } from '../types';

/**
 * Redirects: data a front end (or an edge Worker in front of it) applies. CommerceWorker does not
 * serve the site, so a redirect is never answered here; Delivery hands the set to whoever does.
 *
 * A redirect's `source` is a path: exact (`/old-page`) or a pattern of whole segments, where
 * `[name]` captures one segment and a trailing `[...name]` one or more. Its `destination` is a
 * path (with an optional query and fragment) or an absolute `https://` URL, and may use the
 * source's captures by the same names. Matching is deterministic: an exact source beats any
 * pattern, a more specific pattern beats a less specific one, and a tie goes to a locale's own
 * redirect, then the source, then the id.
 */

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

/** Most redirects an environment holds: Delivery serves the whole set in one response. */
export const MAX_REDIRECTS = 10_000;
/** Most rows one import takes. */
export const MAX_REDIRECT_IMPORT = 1_000;
/** Longest source or destination. */
export const MAX_REDIRECT_LENGTH = 2048;
export const MAX_REDIRECT_NOTE_LENGTH = 500;

/** Where a redirect came from: written by someone, imported, or made by a slug change. */
export type RedirectOrigin = 'manual' | 'import' | 'slug';

export interface Redirect {
  readonly id: string;
  /** The normalized path it matches. */
  readonly source: string;
  readonly destination: string;
  readonly status: RedirectStatus;
  /** Applies only to requests in this locale; absent, to every request. */
  readonly locale?: string;
  readonly enabled: boolean;
  readonly note?: string;
  readonly origin: RedirectOrigin;
  /** The entry whose slug change made it (`origin: 'slug'`). */
  readonly entryId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a person (or an import row) gives for a redirect. */
export interface RedirectInput {
  readonly source: string;
  readonly destination: string;
  readonly status?: number;
  readonly locale?: string | null;
  readonly enabled?: boolean;
  readonly note?: string | null;
}

/** The checked, normalized fields of a redirect. */
export interface RedirectFields {
  readonly source: string;
  readonly destination: string;
  readonly status: RedirectStatus;
  readonly locale?: string;
  readonly enabled: boolean;
  readonly note?: string;
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Whitespace, controls and backslashes have no place in a path a browser sends.
const FORBIDDEN = /[\s\p{Cc}\\]/u;
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

type Segment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'splat'; readonly name: string };

/** Collapses repeated slashes and drops a trailing one (but keeps the root). */
const tidy = (path: string): string => {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
};

/**
 * A path as a browser sends it: percent-encoded the way the URL parser encodes a pathname (spaces,
 * controls, `"#<>?\`{}` and anything past ASCII, as UTF-8; an existing `%XX` is kept), so a source
 * typed as `/über` matches the `/%C3%BCber` a request carries. Brackets survive (they are outside
 * the path's encode set), so patterns parse after this.
 */
const encodePath = (path: string): string => {
  let out = '';
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0x20 || code >= 0x7f || '"#<>?`{}'.includes(ch) ? encodeURIComponent(ch) : ch;
  }
  return out;
};

function parseSegments(source: string): Segment[] {
  if (source === '/') return [];
  return source
    .slice(1)
    .split('/')
    .map((value) => {
      const m = /^\[(\.\.\.)?([^\]]*)\]$/.exec(value);
      if (!m) return { kind: 'static', value };
      return m[1] ? { kind: 'splat', name: m[2] ?? '' } : { kind: 'param', name: m[2] ?? '' };
    });
}

function sourceIssues(source: string, segments: readonly Segment[]): string | null {
  const names = new Set<string>();
  for (const [i, seg] of segments.entries()) {
    if (seg.kind === 'static') {
      if (seg.value.includes('[') || seg.value.includes(']')) {
        return 'A parameter takes a whole segment: write /blog/[slug], not /blog/post-[slug]';
      }
      continue;
    }
    if (!PARAM_NAME.test(seg.name)) return `"${seg.name}" is not a parameter name`;
    if (names.has(seg.name)) return `The parameter "${seg.name}" appears twice`;
    names.add(seg.name);
    if (seg.kind === 'splat' && i !== segments.length - 1) {
      return `[...${seg.name}] must be the last segment of ${source}`;
    }
  }
  return null;
}

/**
 * Normalizes a redirect source, or throws `ValidationError`. A source is a path only (no query or
 * fragment, no `.` or `..` segments), percent-encoded as a request's path is, with repeated and
 * trailing slashes removed.
 */
export function normalizeRedirectSource(input: string, field = 'source'): string {
  const refuse = (message: string): never => {
    throw new ValidationError([{ field, message }]);
  };
  const raw = input.trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) refuse('A source is a path starting with /');
  if (FORBIDDEN.test(raw)) refuse('A source cannot hold spaces, control characters or \\');
  if (raw.includes('?') || raw.includes('#')) {
    refuse('A source is a path only: no query string or fragment');
  }
  if (raw.split('/').some((s) => s === '.' || s === '..')) {
    refuse('A source cannot hold . or .. segments');
  }
  const source = tidy(encodePath(tidy(raw)));
  if (source.length > MAX_REDIRECT_LENGTH) {
    refuse(`A source is at most ${MAX_REDIRECT_LENGTH} characters`);
  }
  const problem = sourceIssues(source, parseSegments(source));
  if (problem) refuse(problem);
  return source;
}

/** True when the source captures anything (a pattern), false for an exact path. */
export const isRedirectPattern = (source: string): boolean =>
  parseSegments(source).some((s) => s.kind !== 'static');

const PLACEHOLDER = /\[(\.\.\.)?([^\]]*)\]/g;

/**
 * Checks a destination against its source's captures, or throws `ValidationError`. A destination
 * is a path (`/new`, with an optional query and fragment) or an absolute `https://` URL with no
 * credentials; anything else (another scheme, `//host`, a relative path) is refused, since a front
 * end would send a reader there. `[name]` and `[...name]` insert what the source captured.
 */
export function normalizeRedirectDestination(
  input: string,
  source: string,
  field = 'destination',
): string {
  const refuse = (message: string): never => {
    throw new ValidationError([{ field, message }]);
  };
  const destination = input.trim();
  if (destination.length === 0) refuse('A destination is required');
  if (destination.length > MAX_REDIRECT_LENGTH) {
    refuse(`A destination is at most ${MAX_REDIRECT_LENGTH} characters`);
  }
  if (FORBIDDEN.test(destination)) {
    refuse('A destination cannot hold spaces, control characters or \\');
  }
  if (/^https:\/\//i.test(destination)) {
    const authority = /^https:\/\/([^/?#]*)/i.exec(destination)?.[1] ?? '';
    if (authority.includes('@')) refuse('The destination URL cannot carry credentials');
    if (
      !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(authority) &&
      !/^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/.test(authority)
    ) {
      refuse('The destination URL has no host');
    }
  } else if (!destination.startsWith('/') || destination.startsWith('//')) {
    refuse('A destination is a path starting with / or an https:// URL');
  }
  const captures = new Map(
    parseSegments(source)
      .filter((s) => s.kind !== 'static')
      .map((s) => [s.name, s.kind]),
  );
  for (const m of destination.matchAll(PLACEHOLDER)) {
    const name = m[2] ?? '';
    const kind = m[1] ? 'splat' : 'param';
    const captured = captures.get(name);
    if (!captured) refuse(`The source captures no "${name}"`);
    if (captured !== kind) {
      refuse(
        captured === 'splat'
          ? `Write [...${name}]: the source captures several segments there`
          : `Write [${name}]: the source captures one segment there`,
      );
    }
  }
  return destination;
}

/** Checks the rest of a redirect's fields; `locales` are the space's, for `locale`. */
export function checkRedirect(
  input: RedirectInput,
  locales: readonly string[] | undefined = undefined,
): RedirectFields {
  const issues: FieldIssue[] = [];
  let source = '';
  let destination = '';
  // An import row or a snapshot is anyone's JSON: every field is checked for its type too.
  if (typeof input.source !== 'string')
    issues.push({ field: 'source', message: 'A source is required' });
  if (typeof input.destination !== 'string') {
    issues.push({ field: 'destination', message: 'A destination is required' });
  }
  if (issues.length === 0) {
    try {
      source = normalizeRedirectSource(input.source);
      destination = normalizeRedirectDestination(input.destination, source);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      issues.push(...err.issues);
    }
  }
  const status = input.status ?? 301;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    issues.push({ field: 'enabled', message: 'enabled is true or false' });
  }
  if (input.locale != null && typeof input.locale !== 'string') {
    issues.push({ field: 'locale', message: 'Not a locale code' });
  }
  if (input.note != null && typeof input.note !== 'string') {
    issues.push({ field: 'note', message: 'A note is text' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  if (!(REDIRECT_STATUSES as readonly number[]).includes(status)) {
    issues.push({ field: 'status', message: 'A status is 301, 302, 307 or 308' });
  }
  const locale = input.locale?.trim() || undefined;
  if (locale !== undefined) {
    if (!LOCALE.test(locale)) issues.push({ field: 'locale', message: 'Not a locale code' });
    else if (locales && !locales.includes(locale)) {
      issues.push({ field: 'locale', message: `"${locale}" is not one of the space's locales` });
    }
  }
  const note = input.note?.trim() || undefined;
  if (note && note.length > MAX_REDIRECT_NOTE_LENGTH) {
    issues.push({
      field: 'note',
      message: `A note is at most ${MAX_REDIRECT_NOTE_LENGTH} characters`,
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return {
    source,
    destination,
    status: status as RedirectStatus,
    ...(locale ? { locale } : {}),
    enabled: input.enabled ?? true,
    ...(note ? { note } : {}),
  };
}

/** The key a source is unique by: one redirect per source per locale (or for every locale). */
export const redirectKey = (r: { readonly source: string; readonly locale?: string }): string =>
  `${r.locale ?? ''}\u0000${r.source}`;

// --- matching -------------------------------------------------------------

/** What a path resolved to: the redirect, and where it sends the reader. */
export interface RedirectMatch {
  readonly redirect: Redirect;
  readonly status: RedirectStatus;
  /** The destination with the captures filled in (and the request's query, when it has none). */
  readonly location: string;
}

interface Compiled {
  readonly redirect: Redirect;
  readonly segments: readonly Segment[];
  /** Per segment: 0 static, 1 one-segment capture, 2 multi-segment capture. */
  readonly rank: readonly number[];
}

const RANK = { static: 0, param: 1, splat: 2 } as const;

/** Orders two patterns: the more specific first, then a locale's own, then source and id. */
function compare(a: Compiled, b: Compiled): number {
  const n = Math.max(a.rank.length, b.rank.length);
  for (let i = 0; i < n; i++) {
    const d = (a.rank[i] ?? 3) - (b.rank[i] ?? 3);
    if (d !== 0) return d;
  }
  const local = (b.redirect.locale ? 1 : 0) - (a.redirect.locale ? 1 : 0);
  if (local !== 0) return local;
  if (a.redirect.source !== b.redirect.source)
    return a.redirect.source < b.redirect.source ? -1 : 1;
  return a.redirect.id < b.redirect.id ? -1 : a.redirect.id > b.redirect.id ? 1 : 0;
}

/**
 * A placeholder segment the set analysis puts where a destination inserts a capture: `\uE000name`
 * for one segment, `\uE000...name` for several. No source can hold one (it is past ASCII, so encoded), so
 * it matches only a capture, of its own kind.
 */
const SENTINEL = '\uE000';
const isSplatSentinel = (s: string) => s.startsWith(`${SENTINEL}...`);

function capture(
  segments: readonly Segment[],
  parts: readonly string[],
): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const [i, seg] of segments.entries()) {
    if (seg.kind === 'splat') {
      const rest = parts.slice(i);
      if (rest.length === 0) return null;
      out.set(seg.name, rest.join('/'));
      return out;
    }
    const part = parts[i];
    if (part === undefined || part === '') return null;
    if (seg.kind === 'static') {
      if (part !== seg.value) return null;
    } else {
      // A one-segment capture never takes what stands for several.
      if (isSplatSentinel(part)) return null;
      out.set(seg.name, part);
    }
  }
  return parts.length === segments.length ? out : null;
}

/** The destination with `[name]`/`[...name]` filled from `captures`. */
const fill = (destination: string, captures: ReadonlyMap<string, string>): string =>
  destination.replace(PLACEHOLDER, (whole, _splat, name: string) => captures.get(name) ?? whole);

/** Splits a request path from its query, normalizing the path as sources are. */
function splitRequest(input: string): { path: string; query: string } {
  const hash = input.indexOf('#');
  const noHash = hash >= 0 ? input.slice(0, hash) : input;
  const q = noHash.indexOf('?');
  const rawPath = q >= 0 ? noHash.slice(0, q) : noHash;
  const query = q >= 0 ? noHash.slice(q) : '';
  const prefixed = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  // Sentinels must survive: encoding would turn them into %EE%80%80.
  const path = prefixed.includes(SENTINEL) ? tidy(prefixed) : tidy(encodePath(tidy(prefixed)));
  return { path, query: query === '?' ? '' : query };
}

/** Appends the request's query when the destination has none of its own. */
const withQuery = (location: string, query: string): string => {
  if (!query || location.includes('?')) return location;
  const hash = location.indexOf('#');
  return hash >= 0 ? `${location.slice(0, hash)}${query}${location.slice(hash)}` : location + query;
};

export interface RedirectMatcher {
  /**
   * The redirect for `path` (a request path, with or without a query), or null. With a `locale`,
   * that locale's redirects and the ones for every locale apply; without, only the latter.
   */
  match(path: string, locale?: string): RedirectMatch | null;
}

/**
 * Compiles a set for matching. Disabled redirects never match. Exact sources are a map lookup;
 * patterns are bucketed by their first segment and ordered by specificity once, here.
 */
export function createRedirectMatcher(redirects: readonly Redirect[]): RedirectMatcher {
  const exact = new Map<string, Redirect>();
  const byFirst = new Map<string, Compiled[]>();
  const wild: Compiled[] = [];
  for (const redirect of redirects) {
    if (!redirect.enabled) continue;
    const segments = parseSegments(redirect.source);
    if (segments.every((s) => s.kind === 'static')) {
      const key = redirectKey(redirect);
      const held = exact.get(key);
      // Duplicates are refused on write; should any arrive, the lowest id wins, as for patterns.
      if (!held || redirect.id < held.id) exact.set(key, redirect);
      continue;
    }
    const compiled: Compiled = { redirect, segments, rank: segments.map((s) => RANK[s.kind]) };
    const first = segments[0];
    if (first?.kind === 'static') {
      const bucket = byFirst.get(first.value) ?? [];
      bucket.push(compiled);
      byFirst.set(first.value, bucket);
    } else {
      wild.push(compiled);
    }
  }
  for (const bucket of byFirst.values()) bucket.sort(compare);
  wild.sort(compare);

  return {
    match(input, locale) {
      const { path, query } = splitRequest(input);
      const applies = (r: Redirect) => r.locale === undefined || r.locale === locale;
      const hit =
        (locale !== undefined ? exact.get(redirectKey({ source: path, locale })) : undefined) ??
        exact.get(redirectKey({ source: path }));
      if (hit)
        return { redirect: hit, status: hit.status, location: withQuery(hit.destination, query) };
      const parts = path === '/' ? [] : path.slice(1).split('/');
      let best: { c: Compiled; captures: Map<string, string> } | null = null;
      // Each list is in order already: its first match is its best.
      for (const list of [byFirst.get(parts[0] ?? '') ?? [], wild]) {
        for (const c of list) {
          if (!applies(c.redirect)) continue;
          const captures = capture(c.segments, parts);
          if (!captures) continue;
          if (!best || compare(c, best.c) < 0) best = { c, captures };
          break;
        }
      }
      if (!best) return null;
      const r = best.c.redirect;
      return {
        redirect: r,
        status: r.status,
        location: withQuery(fill(r.destination, best.captures), query),
      };
    },
  };
}

/** Matches one path against a set (compiles it each call: for many, use `createRedirectMatcher`). */
export const matchRedirect = (
  redirects: readonly Redirect[],
  path: string,
  locale?: string,
): RedirectMatch | null => createRedirectMatcher(redirects).match(path, locale);

// --- the set: duplicates, loops and chains ---------------------------------

/** A redirect whose destination is redirected again: `via` are the hops after it, in order. */
export interface RedirectChain {
  readonly id: string;
  readonly via: readonly string[];
  /** Where the last hop sends the reader: what `id` can point at directly. */
  readonly destination: string;
}

export interface RedirectSetReport {
  /** Sources held more than once for the same locale. */
  readonly duplicates: readonly { readonly key: string; readonly ids: readonly string[] }[];
  /** Cycles, each as the ids around it (A → B → A is `[A, B]`). */
  readonly loops: readonly (readonly string[])[];
  readonly chains: readonly RedirectChain[];
}

/** Most hops the analysis follows before calling a chain a loop. */
const MAX_HOPS = 32;

/**
 * The destination's path as a request would arrive, with each capture standing in as a sentinel
 * (so `/a/[x]` → `/b/[x]` is followed through `/b/[y]`), or null for an absolute URL, which leaves
 * the site.
 */
function hopInput(destination: string): string | null {
  if (!destination.startsWith('/')) return null;
  return destination.replace(
    PLACEHOLDER,
    (_w, splat: string | undefined, name: string) => `${SENTINEL}${splat ? '...' : ''}${name}`,
  );
}

/** A location with sentinels written back as placeholders. */
const unsentinel = (location: string): string =>
  location.replace(
    /\uE000(\.\.\.)?([A-Za-z0-9_]+)/g,
    (_w, splat: string | undefined, name: string) => `[${splat ?? ''}${name}]`,
  );

/**
 * Reads a set as a whole. Only enabled redirects can loop or chain (a disabled one never fires).
 * Patterns are followed symbolically, so `/[...p]` → `/new/[...p]` is a loop (every
 * `/new/...` would redirect again) and `/a/[x]` → `/b/[x]` with `/b/[y]` → `/c/[y]` a chain
 * whose collapse is `/a/[x]` → `/c/[x]`. A redirect for one locale follows that locale's
 * redirects and the ones for every locale; one for every locale, only the latter.
 */
export function analyzeRedirects(redirects: readonly Redirect[]): RedirectSetReport {
  const byKey = new Map<string, string[]>();
  for (const r of redirects) {
    const key = redirectKey(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r.id]);
  }
  const duplicates = [...byKey]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids: [...ids].sort() }));

  const matcher = createRedirectMatcher(redirects);
  const next = (r: Redirect, location: string): RedirectMatch | null => {
    const input = hopInput(location);
    return input === null ? null : matcher.match(input, r.locale);
  };

  const loops: string[][] = [];
  const seenLoops = new Set<string>();
  const chains: RedirectChain[] = [];
  const enabled = redirects.filter((r) => r.enabled);
  for (const r of [...enabled].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const path = [r.id];
    let location = hopInput(r.destination) === null ? null : r.destination;
    let looped = false;
    for (let hops = 0; location !== null && hops < MAX_HOPS; hops++) {
      const hit = next(r, location);
      if (!hit) break;
      const at = path.indexOf(hit.redirect.id);
      if (at >= 0) {
        const cycle = path.slice(at);
        // One report per cycle, however many redirects lead into it.
        const key = [...cycle].sort().join(',');
        if (!seenLoops.has(key)) {
          seenLoops.add(key);
          loops.push(cycle);
        }
        looped = true;
        break;
      }
      path.push(hit.redirect.id);
      location = hit.location;
    }
    if (path.length >= MAX_HOPS) looped = true;
    if (!looped && path.length > 1 && location !== null) {
      chains.push({ id: r.id, via: path.slice(1), destination: unsentinel(location) });
    }
  }
  return { duplicates, loops, chains };
}

/**
 * The refusal for a set that would loop or hold a source twice, or null when it can be stored.
 * Chains are allowed: they work, one hop slower, and `collapseRedirectChains` straightens them.
 */
export function redirectSetError(report: RedirectSetReport): ValidationError | null {
  const issues: FieldIssue[] = [
    ...report.duplicates.map((d) => ({
      field: 'source',
      message: `The source ${d.key.split('\u0000')[1]} is redirected more than once${
        d.key.startsWith('\u0000') ? '' : ` for ${d.key.split('\u0000')[0]}`
      }`,
    })),
    ...report.loops.map((ids) => ({
      field: 'destination',
      message: `These redirects send readers round in a loop: ${ids.join(' → ')} → ${ids[0]}`,
    })),
  ];
  return issues.length > 0 ? new ValidationError(issues) : null;
}

/**
 * The redirects that end a chain, each pointed straight at where its chain ends. A chain that
 * leaves the site ends at the absolute URL.
 */
export function collapseRedirectChains(
  redirects: readonly Redirect[],
  report: RedirectSetReport = analyzeRedirects(redirects),
): { readonly id: string; readonly destination: string }[] {
  const byId = new Map(redirects.map((r) => [r.id, r]));
  return report.chains
    .filter((c) => byId.get(c.id)?.destination !== c.destination)
    .map((c) => ({ id: c.id, destination: c.destination }));
}

// --- CSV --------------------------------------------------------------------

/** The columns a redirect CSV may carry, by header name; `source` and `destination` are required. */
export const REDIRECT_CSV_COLUMNS = [
  'source',
  'destination',
  'status',
  'locale',
  'enabled',
  'note',
] as const;

/** Splits CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const truthy = (value: string): boolean | undefined => {
  const v = value.trim().toLowerCase();
  if (v === '') return undefined;
  if (['true', 'yes', '1', 'y', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'n', 'off'].includes(v)) return false;
  return undefined;
};

/**
 * Reads redirect rows from CSV with a header row (column names as `REDIRECT_CSV_COLUMNS`, in any
 * order; unknown columns are ignored). Throws `ValidationError` for a missing header column or a
 * value that can't be read; whether each row is a valid redirect is the import's to check.
 */
export function redirectsFromCsv(text: string): RedirectInput[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  const at = (name: string) => names.indexOf(name);
  for (const required of ['source', 'destination']) {
    if (at(required) < 0) {
      throw new ValidationError([
        { field: 'data', message: `The CSV header has no "${required}" column` },
      ]);
    }
  }
  const issues: FieldIssue[] = [];
  const out = rows.map((cells, i) => {
    const get = (name: string) => (at(name) >= 0 ? (cells[at(name)] ?? '').trim() : '');
    const status = get('status');
    const enabled = get('enabled');
    if (status !== '' && !/^\d+$/.test(status)) {
      issues.push({ field: `rows[${i}].status`, message: `"${status}" is not a status code` });
    }
    if (enabled !== '' && truthy(enabled) === undefined) {
      issues.push({ field: `rows[${i}].enabled`, message: `"${enabled}" is not true or false` });
    }
    return {
      source: get('source'),
      destination: get('destination'),
      ...(status !== '' ? { status: Number(status) } : {}),
      ...(get('locale') !== '' ? { locale: get('locale') } : {}),
      ...(truthy(enabled) !== undefined ? { enabled: truthy(enabled) } : {}),
      ...(get('note') !== '' ? { note: get('note') } : {}),
    };
  });
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** The set as CSV, in `REDIRECT_CSV_COLUMNS` order: what an import reads back. */
export function redirectsToCsv(redirects: readonly Redirect[]): string {
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = redirects.map((r) =>
    [r.source, r.destination, String(r.status), r.locale ?? '', String(r.enabled), r.note ?? '']
      .map(quote)
      .join(','),
  );
  return `${[REDIRECT_CSV_COLUMNS.join(','), ...lines].join('\n')}\n`;
}

// --- slug changes ---------------------------------------------------------

/** An entry's old path and its new one, after a publish changed a slug its URL pattern names. */
export interface SlugMove {
  readonly source: string;
  readonly destination: string;
  readonly locale?: string;
}

/**
 * The paths a publish moves: for each locale the named slugs hold a value in, the entry's path
 * before (`previous`, the published fields it replaces) and after (`next`), where they differ. A
 * type without a URL pattern, or one naming no slug, moves nothing. When a named slug is
 * localized each move is that locale's; otherwise it applies to every locale.
 */
export function slugMoves(
  contentType: Pick<ContentType, 'urlPattern' | 'fields'>,
  entryId: string,
  previous: EntryFields,
  next: EntryFields,
): SlugMove[] {
  const pattern = contentType.urlPattern;
  if (!pattern) return [];
  const named = urlPatternSlugFields(pattern);
  if (named.length === 0) return [];
  const localized = contentType.fields.some((f) => named.includes(f.apiId) && f.localized);
  const locales = new Set<string>();
  for (const name of named) {
    for (const fields of [previous, next])
      for (const l of Object.keys(fields[name] ?? {})) locales.add(l);
  }
  const moves: SlugMove[] = [];
  const seen = new Set<string>();
  for (const locale of [...locales].sort()) {
    const from = urlPath(pattern, { id: entryId, fields: previous }, locale);
    const to = urlPath(pattern, { id: entryId, fields: next }, locale);
    if (from === null || to === null) continue;
    let source: string;
    let destination: string;
    try {
      source = normalizeRedirectSource(from);
      destination = normalizeRedirectSource(to);
    } catch (err) {
      // A path no redirect can hold (too long) is not worth failing a publish over.
      if (err instanceof ValidationError) continue;
      throw err;
    }
    if (source === destination) continue;
    const move = { source, destination, ...(localized ? { locale } : {}) };
    const key = redirectKey(move);
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push(move);
  }
  return moves;
}

/** What a slug change writes to the set. */
export interface SlugRedirectPlan {
  readonly save: readonly Redirect[];
  readonly remove: readonly string[];
}

/**
 * The redirects a publish's slug moves make, given `existing`: every redirect whose source or
 * destination is one of the moves' paths. Each old path gets a 301 to the new one (taking over a
 * redirect already on that source); redirects that pointed at the old path are pointed at the new
 * one (no chain); and a redirect away from the new path is removed, since the entry now lives
 * there (it would loop). `max` caps the set: past it the new redirects are left out.
 */
export function planSlugRedirects(
  existing: readonly Redirect[],
  moves: readonly SlugMove[],
  opts: {
    readonly entryId: string;
    readonly at: string;
    readonly newId: () => string;
    readonly count: number;
    readonly max?: number;
  },
): SlugRedirectPlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const removed = new Set<string>();
  let count = opts.count;
  const max = opts.max ?? MAX_REDIRECTS;
  const applies = (r: Redirect, locale: string | undefined) =>
    r.locale === undefined || locale === undefined || r.locale === locale;
  for (const move of moves) {
    for (const r of byId.values()) {
      if (removed.has(r.id)) continue;
      // The entry lives at the new path now: nothing may send readers away from it.
      if (r.source === move.destination && (r.locale ?? undefined) === move.locale) {
        removed.add(r.id);
        continue;
      }
      // Pointed at the old path: straight to the new one instead.
      if (r.destination === move.source && applies(r, move.locale)) {
        byId.set(r.id, { ...r, destination: move.destination, updatedAt: opts.at });
      }
    }
    const held = [...byId.values()].find(
      (r) => !removed.has(r.id) && redirectKey(r) === redirectKey(move),
    );
    if (held) {
      byId.set(held.id, {
        ...held,
        destination: move.destination,
        status: 301,
        enabled: true,
        origin: 'slug',
        entryId: opts.entryId,
        updatedAt: opts.at,
      });
      continue;
    }
    if (count >= max) continue;
    count++;
    const created: Redirect = {
      id: opts.newId(),
      source: move.source,
      destination: move.destination,
      status: 301,
      ...(move.locale ? { locale: move.locale } : {}),
      enabled: true,
      origin: 'slug',
      entryId: opts.entryId,
      createdAt: opts.at,
      updatedAt: opts.at,
    };
    byId.set(created.id, created);
  }
  const before = new Map(existing.map((r) => [r.id, r]));
  return {
    save: [...byId.values()].filter((r) => !removed.has(r.id) && before.get(r.id) !== r),
    remove: [...removed].filter((id) => before.has(id)),
  };
}

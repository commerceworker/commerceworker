/**
 * @commerceworker/sdk-core/redirects — apply a space's redirects in front of a site. commerceworker
 * serves no site, so the front end (or an edge Worker before it) applies them: fetch the set once
 * with `client.redirects()`, match each request locally, and refresh the set on an interval.
 *
 * The matching here is the Delivery API's (`…/redirects/resolve`), kept in step with it by a
 * test: an exact source beats any pattern; a more specific pattern beats a less specific one
 * (segment by segment: a fixed segment, then `[param]`, then `[...splat]`); a tie goes to the
 * locale's own redirect, then the source, then the id. Zero dependencies.
 */

/** A redirect as Delivery serves it. */
export interface DeliveredRedirect {
  readonly id: string;
  /** A path: exact (`/old`), or a pattern of `[param]` segments and a trailing `[...splat]`. */
  readonly source: string;
  /** A path or an absolute https URL; `[param]`/`[...splat]` insert what the source captured. */
  readonly destination: string;
  readonly status: 301 | 302 | 307 | 308;
  /** Applies only to requests in this locale; absent, to every request. */
  readonly locale?: string;
}

/** Where a path is redirected. */
export interface RedirectMatch {
  readonly redirect: DeliveredRedirect;
  readonly status: DeliveredRedirect['status'];
  /** The destination with captures filled in, and the request's query when it has none. */
  readonly location: string;
}

type Segment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param' | 'splat'; readonly name: string };

interface Compiled {
  readonly redirect: DeliveredRedirect;
  readonly segments: readonly Segment[];
  readonly rank: readonly number[];
}

const RANK = { static: 0, param: 1, splat: 2 } as const;
const PLACEHOLDER = /\[(\.\.\.)?([^\]]*)\]/g;

const tidy = (path: string): string => {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
};

/** Percent-encodes a path as the URL parser does a pathname (an existing `%XX` is kept). */
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
    .map((value): Segment => {
      const m = /^\[(\.\.\.)?([^\]]*)\]$/.exec(value);
      if (!m) return { kind: 'static', value };
      return { kind: m[1] ? 'splat' : 'param', name: m[2] ?? '' };
    });
}

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
    } else out.set(seg.name, part);
  }
  return parts.length === segments.length ? out : null;
}

const key = (source: string, locale: string | undefined) => `${locale ?? ''}\u0000${source}`;

const withQuery = (location: string, query: string): string => {
  if (!query || location.includes('?')) return location;
  const hash = location.indexOf('#');
  return hash >= 0 ? `${location.slice(0, hash)}${query}${location.slice(hash)}` : location + query;
};

export interface RedirectMatcher {
  /**
   * The redirect for `path` (with or without its query), or null. With a `locale`, that locale's
   * redirects and the ones for every locale apply; without, only the latter.
   */
  match(path: string, locale?: string): RedirectMatch | null;
}

/** Compiles a set (as `client.redirects()` returns it) for matching many requests. */
export function createRedirectMatcher(redirects: readonly DeliveredRedirect[]): RedirectMatcher {
  const exact = new Map<string, DeliveredRedirect>();
  const byFirst = new Map<string, Compiled[]>();
  const wild: Compiled[] = [];
  for (const redirect of redirects) {
    const segments = parseSegments(redirect.source);
    if (segments.every((s) => s.kind === 'static')) {
      const k = key(redirect.source, redirect.locale);
      const held = exact.get(k);
      if (!held || redirect.id < held.id) exact.set(k, redirect);
      continue;
    }
    const compiled: Compiled = { redirect, segments, rank: segments.map((s) => RANK[s.kind]) };
    const first = segments[0];
    if (first?.kind === 'static') {
      const bucket = byFirst.get(first.value) ?? [];
      bucket.push(compiled);
      byFirst.set(first.value, bucket);
    } else wild.push(compiled);
  }
  for (const bucket of byFirst.values()) bucket.sort(compare);
  wild.sort(compare);

  return {
    match(input, locale) {
      const noHash = input.split('#')[0] ?? '';
      const q = noHash.indexOf('?');
      const rawPath = q >= 0 ? noHash.slice(0, q) : noHash;
      const query = q >= 0 && q < noHash.length - 1 ? noHash.slice(q) : '';
      const path = tidy(encodePath(tidy(rawPath.startsWith('/') ? rawPath : `/${rawPath}`)));
      const hit =
        (locale !== undefined ? exact.get(key(path, locale)) : undefined) ??
        exact.get(key(path, undefined));
      if (hit)
        return { redirect: hit, status: hit.status, location: withQuery(hit.destination, query) };
      const parts = path === '/' ? [] : path.slice(1).split('/');
      let best: { c: Compiled; captures: Map<string, string> } | null = null;
      for (const list of [byFirst.get(parts[0] ?? '') ?? [], wild]) {
        for (const c of list) {
          if (c.redirect.locale !== undefined && c.redirect.locale !== locale) continue;
          const captures = capture(c.segments, parts);
          if (!captures) continue;
          if (!best || compare(c, best.c) < 0) best = { c, captures };
          break;
        }
      }
      if (!best) return null;
      const r = best.c.redirect;
      const filled = r.destination.replace(
        PLACEHOLDER,
        (whole, _splat, name: string) => best.captures.get(name) ?? whole,
      );
      return { redirect: r, status: r.status, location: withQuery(filled, query) };
    },
  };
}

/** The source of a redirect set: `client.redirects` (a Delivery client) or any function like it. */
export type RedirectSource = () => Promise<readonly DeliveredRedirect[]>;

export interface ApplyRedirectsOptions {
  /** How long a fetched set is used before it is fetched again (ms). Default 60 000. */
  readonly ttlMs?: number;
  /** The request's locale, e.g. from its path prefix or `Accept-Language`. */
  readonly locale?: (request: Request) => string | undefined;
}

/**
 * A front-door helper for a Worker (or any fetch-style server): returns the redirect `Response`
 * for a request a redirect matches, or null to serve it as usual. The set is fetched once and
 * kept for `ttlMs`; while a refresh is in flight the last set keeps answering, and a failed
 * refresh keeps it too (a site never loses its redirects to a Delivery blip).
 *
 * ```ts
 * const redirects = createRedirectHandler(() => client.redirects());
 * export default {
 *   async fetch(request) {
 *     return (await redirects(request)) ?? fetch(request);
 *   },
 * };
 * ```
 */
export function createRedirectHandler(
  source: RedirectSource,
  opts: ApplyRedirectsOptions = {},
): (request: Request) => Promise<Response | null> {
  const ttl = opts.ttlMs ?? 60_000;
  let matcher: RedirectMatcher | null = null;
  let fetchedAt = 0;
  let pending: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    pending ??= source()
      .then((set) => {
        matcher = createRedirectMatcher(set);
        fetchedAt = Date.now();
      })
      .catch((err: unknown) => {
        // Keep the last set; with none yet, the first request surfaces the failure.
        if (!matcher) throw err;
        fetchedAt = Date.now();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async (request) => {
    if (!matcher) await refresh();
    else if (Date.now() - fetchedAt > ttl) void refresh();
    const url = new URL(request.url);
    const match = (matcher as RedirectMatcher | null)?.match(
      `${url.pathname}${url.search}`,
      opts.locale?.(request),
    );
    if (!match) return null;
    const location = match.location.startsWith('/')
      ? new URL(match.location, url.origin).toString()
      : match.location;
    return new Response(null, { status: match.status, headers: { location } });
  };
}

/**
 * One-off form of {@link createRedirectHandler}: the redirect `Response` for `request` among
 * `redirects`, or null. For many requests, compile once with `createRedirectHandler`.
 */
export function applyRedirects(
  request: Request,
  redirects: readonly DeliveredRedirect[],
  opts: { readonly locale?: string } = {},
): Response | null {
  const url = new URL(request.url);
  const match = createRedirectMatcher(redirects).match(`${url.pathname}${url.search}`, opts.locale);
  if (!match) return null;
  const location = match.location.startsWith('/')
    ? new URL(match.location, url.origin).toString()
    : match.location;
  return new Response(null, { status: match.status, headers: { location } });
}

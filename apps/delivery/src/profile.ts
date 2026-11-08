import type { Principal } from '@commerceworker/domain';

/**
 * The visibility profile of a delivery principal: everything that decides what a response may
 * contain (space, key kind, scopes, content grants with their field rules), and nothing that
 * doesn't (key id, name, last use). Two keys with the same profile see byte-identical responses,
 * so they share one cache entry; a profile change (role edit) lands on a new cache key.
 */
export async function visibilityProfile(principal: Principal): Promise<string> {
  const shape = {
    s: principal.spaceId,
    k: principal.kind,
    sc: [...principal.scopes].sort(),
    g: principal.contentGrants ?? null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(shape));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Internal origin for gateway → cached entrypoint requests (never resolvable publicly). */
export const INTERNAL_ORIGIN = 'https://delivery.internal';

/**
 * The cache key URL for a delivery read: the profile, the path, and the query parameters sorted,
 * so `?a=1&b=2` and `?b=2&a=1` share an entry. Nothing else (no cookies, no client headers)
 * reaches the cache.
 */
export function canonicalUrl(profile: string, url: URL): string {
  const params = [...url.searchParams].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const qs = new URLSearchParams(params).toString();
  return `${INTERNAL_ORIGIN}/_p/${profile}${url.pathname}${qs ? `?${qs}` : ''}`;
}

/** Splits a canonical URL back into the profile and the public path + query. */
export function fromCanonical(url: URL): { profile: string; path: URL } | null {
  const m = /^\/_p\/([0-9a-f]{24})(\/.*)$/.exec(url.pathname);
  if (!m) return null;
  const path = new URL(`${m[2]}${url.search}`, 'https://public.invalid');
  return { profile: m[1] as string, path };
}

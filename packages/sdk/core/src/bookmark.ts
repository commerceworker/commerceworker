/**
 * Read-your-writes against the api. Every api response carries the D1 Sessions bookmark after
 * its own queries in `x-cw-bookmark`; a request that sends one back is answered from a database
 * at least that fresh, even by a read replica. The tracker keeps the newest bookmark it has seen
 * and sends it with the next request.
 *
 * Kept in step with `packages/sdk/management/src/bookmark.ts`: each published SDK stays
 * dependency-free, so the two carry their own copy.
 */

export const BOOKMARK_HEADER = 'x-cw-bookmark';

/** D1 bookmarks are hex groups joined by dashes; the api ignores anything else, so do we. */
const BOOKMARK_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]+){2,8}$/i;

export interface BookmarkTracker {
  /** The bookmark the next request sends; setting it replaces it outright (or clears it). */
  current: string | undefined;
  /** The header to add to a request for `url`: none for another origin, or when there's none yet. */
  headersFor(url: string): Record<string, string>;
  /** Keeps the response's bookmark when it is newer than the one held. */
  record(res: Response): void;
}

const shaped = (value: string | null | undefined): string | undefined =>
  value && BOOKMARK_SHAPE.test(value) ? value : undefined;

/**
 * A tracker for one client. Bookmarks travel only to and from `baseUrl`'s origin, so a redirect
 * elsewhere neither receives the client's position nor moves it. When `enabled` is false it holds
 * nothing and sends nothing.
 */
export function bookmarkTracker(
  baseUrl: string,
  seed: string | undefined,
  enabled: boolean,
): BookmarkTracker {
  // A relative `baseUrl` ('' or '/cms') means the page's own origin; outside a browser there is
  // none, and a placeholder keeps relative URLs comparable with each other.
  const page = (globalThis as { location?: { href?: string } }).location?.href;
  const originOf = (url: string) => {
    try {
      return new URL(url, page ?? 'http://relative.invalid').origin;
    } catch {
      return undefined;
    }
  };
  const origin = originOf(baseUrl);
  const sameOrigin = (url: string) => origin !== undefined && originOf(url) === origin;
  let current = enabled ? shaped(seed) : undefined;
  return {
    get current() {
      return current;
    },
    set current(value) {
      if (enabled) current = shaped(value);
    },
    headersFor(url): Record<string, string> {
      return current && sameOrigin(url) ? { [BOOKMARK_HEADER]: current } : {};
    },
    record(res) {
      if (!enabled) return;
      // A Response built by hand (a test, a cache) has no url; one fetched did come from where
      // it was sent, so only a redirect can make it another origin's.
      if (res.url && !sameOrigin(res.url)) return;
      const next = shaped(res.headers.get(BOOKMARK_HEADER));
      // Bookmarks sort oldest to newest as strings. Concurrent requests can answer out of
      // order, and an older bookmark must not undo the freshness a write just bought.
      if (next && (current === undefined || next > current)) current = next;
    },
  };
}

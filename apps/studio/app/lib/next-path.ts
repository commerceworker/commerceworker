import { redirect, redirectDocument } from 'react-router';

/**
 * Where to go after signing in: the `next` query parameter when it resolves to a path on this
 * site, else `/`. Resolving it the way a browser would catches `//host`, `/\host` and the like.
 */
export function nextPath(request: Request): string {
  const url = new URL(request.url);
  const next = url.searchParams.get('next');
  if (!next?.startsWith('/') || next.includes('\\')) return '/';
  try {
    const target = new URL(next, url.origin);
    return target.origin === url.origin ? `${target.pathname}${target.search}${target.hash}` : '/';
  } catch {
    return '/';
  }
}

/** `path` carrying `next`, left off when it's `/`, where sign-in goes anyway. */
export function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}

/**
 * Where a page keeps something in a cookie scoped to its own path: the invitation page holds its
 * token under `Path=/invite` (`lib/invites.ts`). A client navigation would load it as
 * `/invite.data`, outside that path, without the cookie; it must be a whole document load.
 */
const NEEDS_DOCUMENT = /^\/invite(?:[?#]|$)/;

/**
 * The redirect to `next` after signing in (or finding someone already signed in): a document
 * redirect (`X-Remix-Reload-Document`) where the page needs one, a plain one elsewhere.
 */
export function redirectToNext(next: string, init?: ResponseInit): Response {
  return NEEDS_DOCUMENT.test(next) ? redirectDocument(next, init) : redirect(next, init);
}

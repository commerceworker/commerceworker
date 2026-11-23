/**
 * Headers for a response that carries a one-time secret (a webhook signing secret, an API token, a
 * temporary password): never stored by the browser or a cache, so the page that showed it once
 * isn't kept on disk or in back/forward history. A route returning one also exports
 * `headers = ({ actionHeaders }) => actionHeaders`, so a full-page submit gets them too.
 */
export const SECRET_HEADERS = { 'cache-control': 'private, no-store' } as const;

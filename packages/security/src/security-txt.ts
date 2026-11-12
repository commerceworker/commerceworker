/**
 * RFC 9116 `/.well-known/security.txt`, for every public host that serves one (the admin, the
 * storefront and the studio; the docs site ships the same text as a static file, which the test in
 * `test/security-txt.test.ts` holds to this one).
 *
 * `Expires` is computed per request rather than baked at build time: a deployment nobody has
 * touched for a year would otherwise serve a lapsed file, which RFC 9116 tells researchers to
 * distrust, and the build-time alternative is a test that goes red on an unrelated pull request.
 * It's cut to the day (UTC midnight, so the body is stable for a day's worth of cache) and sits
 * 364 days ahead, because §2.5.5 recommends less than a year.
 */

export const SECURITY_TXT_PATH = '/.well-known/security.txt';

/** Where a researcher reports: GitHub's private vulnerability reporting for this repository. */
export const SECURITY_CONTACT =
  'https://github.com/commerceworker/commerceworker/security/advisories/new';
/** What the report is held to; the file the repository's Security tab also shows. */
export const SECURITY_POLICY =
  'https://github.com/commerceworker/commerceworker/blob/main/SECURITY.md';

const DAY_MS = 86_400_000;
export const SECURITY_TXT_VALIDITY_DAYS = 364;

/** An RFC 3339 date-time with no fraction, as `Expires` is written. */
const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The origin to name as `Canonical`, or null. Only an https origin with an ordinary DNS name (a letter-led last label, so never an IP literal):
 * the request's host is the one thing echoed here (never used to route, sign or look anything
 * up), and a value that couldn't be a hostname, or a local http address, is left out rather than
 * written into a file a researcher trusts.
 */
function canonicalOrigin(url: URL): string | null {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/.test(url.hostname)
    ? url.origin
    : null;
}

/** The file's text. `url` is the request's, for `Canonical`; `now` is the clock. */
export function securityTxt(url: URL, now: Date): string {
  const day = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const origin = canonicalOrigin(url);
  return `${[
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${rfc3339(new Date(day.getTime() + SECURITY_TXT_VALIDITY_DAYS * DAY_MS))}`,
    'Preferred-Languages: en',
    `Policy: ${SECURITY_POLICY}`,
    ...(origin ? [`Canonical: ${origin}${SECURITY_TXT_PATH}`] : []),
  ].join('\n')}\n`;
}

/**
 * The answer to a request for `SECURITY_TXT_PATH`. Public, so a CDN or browser may keep it for an
 * hour (the policy changes rarely and a stale copy is harmless); only `GET` and `HEAD` are served.
 * The Worker's `withSecurityHeaders` adds the rest (nosniff, HSTS, framing), so the CSP is as on
 * any other response.
 */
export function securityTxtResponse(request: Request, now: Date = new Date()): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const body = securityTxt(new URL(request.url), now);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

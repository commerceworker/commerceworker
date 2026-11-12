/**
 * The Content-Security-Policy and security headers every Worker that serves pages sends: the admin
 * (`apps/web`) and the storefront (`apps/storefront`) differ only in what a page asks for. A route
 * names it in a response header (`EMBED_HEADER`, `TURNSTILE_HEADER`, `STRIPE_HEADER`), which `pageHeaders` folds into
 * the policy and drops. Pure, so both Workers and their tests share it.
 */

/** A fresh nonce for one HTML response. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * What a page an external cart's buyer sees adds to its policy: the origins that may frame it (the
 * buyer's procurement system) and where its return form may post. Both come from the cart, which
 * the plugin opened with https values the engine checked.
 */
export type EmbedPolicy = { frameAncestors: string[]; formAction: string[] };

/** Carried from a route's `headers` to entry.server.tsx, which folds it into the CSP and drops it. */
export const EMBED_HEADER = 'x-commerceworker-embed';

/**
 * Carried from the sign-in and setup pages' `headers` when the deployment uses Turnstile
 * (`withTurnstilePolicy`); entry.server.tsx lets that page alone load Turnstile, and drops it.
 */
export const TURNSTILE_HEADER = 'x-commerceworker-turnstile';

/**
 * Carried from a hosted checkout's page when it takes a card (`apps/storefront`): that page alone
 * loads Stripe.js, frames its Payment Element and 3-D Secure, calls its API and may use the
 * browser's payment request (`Permissions-Policy: payment`), which every other page denies.
 */
export const STRIPE_HEADER = 'x-commerceworker-stripe';

/**
 * Where Stripe.js loads from, the origins its elements and authentication frame, and its API.
 * Stripe's CSP guidance (https://docs.stripe.com/security/guide#content-security-policy) lists
 * js.stripe.com and its `*.js.stripe.com` subdomains for scripts and frames, hooks.stripe.com for
 * 3-D Secure and api.stripe.com for connections. That page could not be read when this was written
 * (the Stripe CLI's docs need a login), so the wildcard is Stripe's long-standing recommendation
 * from memory: check it against the page and trim what a real browser test shows is unused.
 */
export const STRIPE_SCRIPT_ORIGIN = 'https://js.stripe.com';
export const STRIPE_SCRIPT_ORIGINS = [STRIPE_SCRIPT_ORIGIN, 'https://*.js.stripe.com'] as const;
export const STRIPE_FRAME_ORIGINS = [
  'https://js.stripe.com',
  'https://*.js.stripe.com',
  'https://hooks.stripe.com',
] as const;
export const STRIPE_API_ORIGIN = 'https://api.stripe.com';

/** What every page may use of the browser's features; a card page's adds Stripe's payment request. */
const PERMISSIONS = 'camera=(), microphone=(), geolocation=()';
export const PERMISSIONS_POLICY = `${PERMISSIONS}, payment=()`;
export const STRIPE_PERMISSIONS_POLICY = `${PERMISSIONS}, payment=(self "${STRIPE_SCRIPT_ORIGIN}")`;

/**
 * Carried from the consent page's `headers` (routes/oauth-authorize.tsx): the return address the
 * provider already checked against the client's registration. Chromium holds a redirect after a
 * form post to the page's `form-action`, so without it the answer to Connect or Cancel (a `303`
 * to the client) is blocked. `pageHeaders` adds that address's origin to this page's `form-action`
 * and drops the header.
 */
export const CONSENT_HEADER = 'x-commerceworker-consent';

/** Where Turnstile's script and challenge frame come from. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Any https page may frame this one. Only for a refusal a buyer's page shows in its frame (a used
 * start link, a closed cart): it carries no data and nothing to click, and without it the buyer
 * sees a blocked frame instead of the reason.
 */
export const ANY_HTTPS_FRAMER = 'https:';

/**
 * `v` as a CSP source: an https URL's origin and path. CSP ignores the query, and matches paths
 * after percent-decoding them, so a path's `;` `,` and `'` (which the policy's grammar would split
 * on) are encoded rather than dropped: a return URL like `/punchout;jsessionid=…` must still be
 * one the form may post to. Null for anything else, or a host the grammar can't carry.
 */
function httpsSource(v: unknown, keepPath: boolean): string | null {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  // The URL parser accepts these in a host; a source can't hold them.
  if (/[^\x21-\x7e]|[;,'*]/.test(u.origin)) return null;
  if (!keepPath) return u.origin;
  return (
    u.origin + u.pathname.replace(/[;,']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  );
}

/**
 * A client's return address as a `form-action` source: an https origin, or a loopback origin over
 * http (RFC 8252 §7.3: a native app listening on 127.0.0.1 or localhost). Only an origin: a
 * redirect is matched without its path. Null for anything else, an IPv6 literal included, which a
 * source expression has no way to write.
 */
export function redirectSource(v: string | null): string | null {
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.hostname.includes('*')) return null;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
    return u.username || u.password ? null : u.origin;
  return httpsSource(v, false);
}

const sources = (vs: unknown, keepPath: boolean) => [
  ...new Set(
    (Array.isArray(vs) ? vs : []).flatMap((v) => {
      const s = httpsSource(v, keepPath);
      return s ? [s] : [];
    }),
  ),
];

/** An embed policy read back from `EMBED_HEADER`, keeping only https sources. */
export function parseEmbed(raw: string | null): EmbedPolicy | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<EmbedPolicy>;
    const anyFramer =
      Array.isArray(e.frameAncestors) && e.frameAncestors.includes(ANY_HTTPS_FRAMER);
    return {
      frameAncestors: anyFramer ? [ANY_HTTPS_FRAMER] : sources(e.frameAncestors, false),
      formAction: sources(e.formAction, true),
    };
  } catch {
    return null;
  }
}

/**
 * The Content-Security-Policy for an HTML page. Scripts run only from this origin or with the
 * response's nonce (the theme script and React Router's inline scripts); styles and fonts come
 * from this origin. Pages can't be framed, and forms post only here, unless `embed` (an external
 * cart's page) names the origins that may frame it and where its return form posts. A page with
 * `turnstile` (sign-in or setup, on a deployment that uses it) may also run Turnstile's script and
 * show its challenge frame.
 */
export function contentSecurityPolicy(
  nonce: string,
  embed?: EmbedPolicy | null,
  opts: { turnstile?: boolean; stripe?: boolean; redirect?: string | null } = {},
): string {
  const ancestors = embed?.frameAncestors.length ? embed.frameAncestors.join(' ') : "'none'";
  const actions = [
    "'self'",
    ...(embed?.formAction ?? []),
    ...(opts.redirect ? [opts.redirect] : []),
  ].join(' ');
  const turnstile = opts.turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  const stripe = opts.stripe ? ` ${STRIPE_SCRIPT_ORIGINS.join(' ')}` : '';
  const frames = [
    ...(opts.turnstile ? [TURNSTILE_ORIGIN] : []),
    ...(opts.stripe ? STRIPE_FRAME_ORIGINS : []),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${turnstile}${stripe}`,
    ...(frames.length ? [`frame-src ${frames.join(' ')}`] : []),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src 'self'${opts.stripe ? ` ${STRIPE_API_ORIGIN}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${actions}`,
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/** Headers a route passes to entry.server.tsx and no response may carry. */
const INTERNAL_HEADERS = [EMBED_HEADER, TURNSTILE_HEADER, STRIPE_HEADER, CONSENT_HEADER];

/**
 * A page's headers as sent: the route's `EMBED_HEADER`, `TURNSTILE_HEADER`, `STRIPE_HEADER` and
 * `CONSENT_HEADER` folded into its Content-Security-Policy when there is a `nonce`, and removed
 * either way (a HEAD answer, or the dev server, which sets no policy). A card page also gets the
 * Permissions-Policy that lets Stripe's payment request run; `withSecurityHeaders` leaves it be.
 */
export function pageHeaders(headers: Headers, nonce?: string): Headers {
  const embed = parseEmbed(headers.get(EMBED_HEADER));
  const turnstile = headers.has(TURNSTILE_HEADER);
  const stripe = headers.has(STRIPE_HEADER);
  const redirect = redirectSource(headers.get(CONSENT_HEADER));
  for (const h of INTERNAL_HEADERS) headers.delete(h);
  if (stripe) headers.set('permissions-policy', STRIPE_PERMISSIONS_POLICY);
  if (nonce)
    headers.set(
      'Content-Security-Policy',
      contentSecurityPolicy(nonce, embed, { turnstile, stripe, redirect }),
    );
  return headers;
}

/**
 * Headers every response from the web Worker carries. HSTS only over HTTPS, so local development
 * on http://localhost isn't pinned.
 */
export function withSecurityHeaders(res: Response, url: URL): Response {
  // A WebSocket upgrade's response can't be rebuilt, and has no body to protect.
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return res;
  const out = new Response(res.body, res);
  // A route's notes to entry.server.tsx also reach React Router's `.data` answers, which never
  // pass through it.
  for (const h of INTERNAL_HEADERS) out.headers.delete(h);
  const set = (k: string, v: string) => {
    if (!out.headers.has(k)) out.headers.set(k, v);
  };
  set('x-content-type-options', 'nosniff');
  set('referrer-policy', 'strict-origin-when-cross-origin');
  // A page that allows framers says so in its CSP (frame-ancestors), which X-Frame-Options can't.
  if (!/frame-ancestors (?!'none')/.test(out.headers.get('content-security-policy') ?? ''))
    set('x-frame-options', 'DENY');
  set('permissions-policy', PERMISSIONS_POLICY);
  if (url.protocol === 'https:')
    set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return out;
}

import { createContext } from 'react';

/** The per-response nonce for inline scripts, set by `entry.server.tsx`; absent in the browser. */
export const NonceContext = createContext<string | undefined>(undefined);

/** A fresh nonce for one HTML response. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * What an embeddable page adds to its policy: the https origins that may frame it and where its
 * form may post. No page uses one yet; the CMS's embedded editors may.
 */
export type EmbedPolicy = { frameAncestors: string[]; formAction: string[] };

/** Carried from a route's `headers` to entry.server.tsx, which folds it into the CSP and drops it. */
export const EMBED_HEADER = 'x-cw-embed';

/**
 * Any https page may frame this one. Only for a refusal an embedded page shows in its frame: it
 * carries no data and nothing to click, and without it the framer sees a blocked frame instead of
 * the reason.
 */
export const ANY_HTTPS_FRAMER = 'https:';

/**
 * `v` as a CSP source: an https URL's origin and path. CSP ignores the query, and matches paths
 * after percent-decoding them, so a path's `;` `,` and `'` (which the policy's grammar would split
 * on) are encoded rather than dropped: a return URL like `/return;jsessionid=…` must still be one
 * the form may post to. Null for anything else, or a host the grammar can't carry.
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
  if (/[^\x21-\x7e]|[;,']/.test(u.origin)) return null;
  if (!keepPath) return u.origin;
  return (
    u.origin + u.pathname.replace(/[;,']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  );
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

/** Carried from a route's `headers` to entry.server.tsx: a JSON array of origins it frames. */
export const FRAME_HEADER = 'x-cw-frames';

// A customer's frontend in development runs on the developer's own machine, over plain http.
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
// A host as the parser normalizes it: DNS labels (an IPv4 address among them) or a bracketed IPv6
// address. The parser lets `*` and other punctuation through, and `https://*` is a CSP wildcard.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$|^\\[[0-9a-f:.]+\\]$`);

/**
 * The origins a page may frame (`frame-src`), from the frontend origins of a space's content types
 * (`previewOrigin` in the domain): https, or http on localhost and 127.0.0.1, origin only, on a
 * plain host name or address. Anything else is dropped, so a stored value can never widen the
 * policy (`https://*`) or add a directive.
 */
export function frameSources(vs: unknown): string[] {
  const out = new Set<string>();
  for (const v of Array.isArray(vs) ? vs : []) {
    let u: URL;
    try {
      u = new URL(String(v));
    } catch {
      continue;
    }
    if (u.username || u.password || !HOSTNAME.test(u.hostname)) continue;
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
    if (!ok || /[^\x21-\x7e]|[;,']/.test(u.origin)) continue;
    out.add(u.origin);
  }
  return [...out];
}

/** Framed origins read back from `FRAME_HEADER`; none for anything unreadable. */
export function parseFrames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return frameSources(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * The Content-Security-Policy for an HTML page. Scripts run only from this origin or with the
 * response's nonce (the theme script and React Router's inline scripts); styles and fonts come
 * from this origin. Pages can't be framed, and forms post only here, unless `embed` (an embeddable
 * page) names the origins that may frame it and where its return form posts. Frames load only
 * from this origin and `frames` (a frontend the admin previews entries on, from `frameSources`).
 */
export function contentSecurityPolicy(
  nonce: string,
  embed?: EmbedPolicy | null,
  frames: readonly string[] = [],
): string {
  const ancestors = embed?.frameAncestors.length ? embed.frameAncestors.join(' ') : "'none'";
  const actions = ["'self'", ...(embed?.formAction ?? [])].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${actions}`,
    `frame-ancestors ${ancestors}`,
    ["frame-src 'self'", ...frameSources(frames)].join(' '),
  ].join('; ');
}

/**
 * Headers every response from the web Worker carries. HSTS only over HTTPS, so local development
 * on http://localhost isn't pinned.
 */
export function withSecurityHeaders(res: Response, url: URL): Response {
  // A WebSocket upgrade's response can't be rebuilt, and has no body to protect.
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  const set = (k: string, v: string) => {
    if (!out.headers.has(k)) out.headers.set(k, v);
  };
  set('x-content-type-options', 'nosniff');
  set('referrer-policy', 'strict-origin-when-cross-origin');
  // A page that allows framers says so in its CSP (frame-ancestors), which X-Frame-Options can't.
  if (!/frame-ancestors (?!'none')/.test(out.headers.get('content-security-policy') ?? ''))
    set('x-frame-options', 'DENY');
  set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Always this origin's own policy, never a forwarded Worker's (the delivery Worker's omits
  // includeSubDomains): a browser keeps the last HSTS header it saw for the host, and the api and
  // cdn hosts are subdomains of this one.
  if (url.protocol === 'https:')
    out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return out;
}

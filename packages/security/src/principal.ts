/**
 * The signed principal the web Worker forwards to the api Worker (`x-cw-principal`).
 *
 * The web Worker fronts the api over a service binding. For a browser request with a valid web
 * session it strips every cookie and adds this header instead, so the api never sees the session.
 * The api believes the header only when it is signed with the `PRINCIPAL_KEY` secret both Workers
 * hold, names the exact path it was sent to, and has not expired (60 seconds after it was issued).
 * Whatever a caller sent in the header is always replaced by the web Worker; a request that reaches
 * the api with a bearer token carries no principal at all.
 *
 * Format: `base64url(JSON payload)` `.` `base64url(HMAC-SHA256(key, <the base64url payload>))`,
 * with payload `{ sub, email, name, role, sid?, iat, exp, path }`; `iat` and `exp` are Unix seconds.
 *
 * Dependency-free (Web Crypto only), so it runs unchanged in Workers, Node and the browser.
 */

import { isRole, type Role } from './roles';

/**
 * The request target a principal is bound to: the method and the path (`DELETE /spaces/s1/x`), so
 * a header captured for one request can't be replayed as another method on the same path. Signer
 * and verifier both build it with this function.
 */
export const principalTarget = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path}`;

/** The header the web gateway sets on requests it forwards to the api. */
export const PRINCIPAL_HEADER = 'x-cw-principal';

/** The read-your-writes bookmark header, forwarded both ways untouched. */
export const BOOKMARK_HEADER = 'x-cw-bookmark';

/** How long a signed principal is good for, in seconds. */
export const PRINCIPAL_TTL_S = 60;

/** Clock skew tolerated on `iat` between the two Workers, in seconds. */
const MAX_SKEW_S = 5;

/** Local development's key (vite.config.ts gives it to both Workers). Never a deployment's. */
export const DEV_PRINCIPAL_KEY = 'commerceworker-local-dev-principal-key';

/** Who a forwarded request is from: a person signed in to the admin web app. */
export type WebPrincipal = {
  /** The person's stable id (`usr_…`), or `local` in open local development. */
  sub: string;
  email: string;
  name: string;
  /** Their deployment role. Content permissions are the api's to resolve from `sub`. */
  role: Role;
  /**
   * The web session this was signed from (the SHA-256 its `sessions` row is keyed by), when there
   * is one. What keeps acting after the request it came with (the assistant's socket) checks that
   * session is still live before each thing it does; open local development has none.
   */
  sid?: string;
};

/** The signed claims: the principal plus when and where it is good. */
export type PrincipalClaims = WebPrincipal & { iat: number; exp: number; path: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keys.set(secret, key);
  }
  return key;
}

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
};

/**
 * The header value for `p`, good for requests to `path` for `PRINCIPAL_TTL_S` seconds from
 * `nowMs`.
 */
export async function signPrincipal(
  secret: string,
  p: WebPrincipal,
  path: string,
  nowMs = Date.now(),
): Promise<string> {
  if (!secret) throw new Error('PRINCIPAL_KEY is not set');
  const iat = Math.floor(nowMs / 1000);
  const claims: PrincipalClaims = {
    sub: p.sub,
    email: p.email,
    name: p.name,
    role: p.role,
    ...(p.sid ? { sid: p.sid } : {}),
    iat,
    exp: iat + PRINCIPAL_TTL_S,
    path,
  };
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/**
 * The principal in a forwarded request, or null unless `header` is signed by one of `secrets`
 * (the current key, then the previous one while a rotation finishes), names exactly `path`, was
 * issued no later than now (within a few seconds' skew), lives no longer than `PRINCIPAL_TTL_S`
 * and has not expired.
 */
export async function verifyPrincipal(
  secrets: string | readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  nowMs = Date.now(),
): Promise<WebPrincipal | null> {
  if (!header) return null;
  const parts = header.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!payload || !sig) return null;
  try {
    const mac = fromB64url(sig);
    const data = enc.encode(payload);
    let valid = false;
    for (const secret of typeof secrets === 'string' ? [secrets] : secrets) {
      if (secret && (await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, data))) {
        valid = true;
        break;
      }
    }
    if (!valid) return null;
    const c = JSON.parse(dec.decode(fromB64url(payload))) as Partial<PrincipalClaims>;
    if (!c || typeof c !== 'object') return null;
    const now = Math.floor(nowMs / 1000);
    if (c.path !== path) return null;
    if (typeof c.iat !== 'number' || typeof c.exp !== 'number') return null;
    if (c.iat > now + MAX_SKEW_S || c.exp <= now || c.exp - c.iat > PRINCIPAL_TTL_S) return null;
    if (typeof c.sub !== 'string' || !c.sub) return null;
    if (typeof c.email !== 'string' || typeof c.name !== 'string' || !isRole(c.role)) return null;
    if (c.sid !== undefined && (typeof c.sid !== 'string' || !c.sid)) return null;
    return {
      sub: c.sub,
      email: c.email,
      name: c.name,
      role: c.role,
      ...(c.sid ? { sid: c.sid } : {}),
    };
  } catch {
    return null;
  }
}

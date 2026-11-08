/**
 * Signed envelopes the web app sets and reads itself (never sent anywhere else): the single
 * sign-on flow cookie (`sf1`) and a pending SSO link (`sl1`). Each is
 * `<version>.<payload>.<signature>` (HMAC-SHA256 under `PRINCIPAL_KEY`), bound to a fixed path
 * and an expiry, so the browser can neither change one nor use it past its time.
 */

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string) {
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

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** `<version>.<payload>.<signature>` over `body`, both base64url. */
async function seal(secret: string, version: string, body: unknown): Promise<string> {
  const signed = `${version}.${b64url(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signed));
  return `${signed}.${b64url(new Uint8Array(sig))}`;
}

/**
 * What `seal` signed, or null unless the header is a `version` envelope signed by one of
 * `secrets` (the current key, then the one before it while a rotation finishes), names this
 * `path` and hasn't expired.
 */
async function unseal(
  secrets: readonly (string | undefined)[],
  version: string,
  header: string | null | undefined,
  path: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (!header) return null;
  const [v, payload, sig, extra] = header.split('.');
  if (v !== version || !payload || !sig || extra !== undefined) return null;
  try {
    const data = enc.encode(`${v}.${payload}`);
    const mac = fromB64url(sig);
    let valid = false;
    for (const secret of secrets)
      if (secret && (await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, data))) {
        valid = true;
        break;
      }
    if (!valid) return null;
    const body = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Record<
      string,
      unknown
    >;
    if (body.path !== path || typeof body.exp !== 'number' || body.exp <= now) return null;
    return body;
  } catch {
    return null;
  }
}

const SSO_FLOW_VERSION = 'sf1';

/**
 * The cookie that carries a single sign-on in progress (its state, nonce, code verifier, where it
 * goes next, and whether it's a step-up) from the start to the provider's callback: its own
 * envelope (`sf1`), which the web app alone sets and reads, so the browser can't change it or use
 * it past `expiresAt`.
 */
export function signSsoFlow(
  secret: string,
  flow: Record<string, unknown>,
  expiresAt: number,
): Promise<string> {
  return seal(secret, SSO_FLOW_VERSION, { flow, path: 'sso', exp: expiresAt });
}

/** The flow `signSsoFlow` sealed, or null when it's forged, from another key, or expired. */
export async function verifySsoFlow(
  secrets: readonly (string | undefined)[],
  value: string | null | undefined,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const flow = (await unseal(secrets, SSO_FLOW_VERSION, value, 'sso', now))?.flow;
  return flow && typeof flow === 'object' && !Array.isArray(flow)
    ? (flow as Record<string, unknown>)
    : null;
}

/**
 * A single sign-on identity waiting to be linked to a person who signs in with a password. The
 * provider vouched for `sub` with that person's email, but an email alone doesn't hand over an
 * account that has a password: the person confirms it (and their two-factor code) first. Held in
 * a short-lived cookie in the web app, as its own envelope (`sl1`).
 */
export type SsoLink = { userId: string; sub: string };

const SSO_LINK_VERSION = 'sl1';
const SSO_LINK_PATH = 'sso-link';

/** How long a pending link waits for the password: as long as a sign-in challenge. */
export const SSO_LINK_TTL_MS = 10 * 60_000;

export function signSsoLink(secret: string, l: SsoLink, now = Date.now()): Promise<string> {
  return seal(secret, SSO_LINK_VERSION, { l, path: SSO_LINK_PATH, exp: now + SSO_LINK_TTL_MS });
}

export async function verifySsoLink(
  secrets: readonly (string | undefined)[],
  value: string | null | undefined,
  now = Date.now(),
): Promise<SsoLink | null> {
  const body = await unseal(secrets, SSO_LINK_VERSION, value, SSO_LINK_PATH, now);
  const l = body?.l as Partial<SsoLink> | undefined;
  if (!l || typeof l.userId !== 'string' || typeof l.sub !== 'string') return null;
  return { userId: l.userId, sub: l.sub };
}

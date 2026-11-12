/**
 * Who may do what. Roles are ordered: each one can do everything the roles before it can.
 *
 * - `viewer` reads orders, flows, approvals and the Commerce page, and asks the workspace assistant.
 * - `approver` also decides approvals.
 * - `operator` also starts, cancels and restarts orders, delivers events, edits and publishes
 *   flows, and runs the stock review.
 * - `admin` also manages the team, API tokens, webhooks and integrations, the workspace's
 *   settings, and reads the audit log.
 */

export const ROLES = ['viewer', 'approver', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  approver: 'Approver',
  operator: 'Operator',
  admin: 'Admin',
};

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/** True when `role` is at least `min`. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/**
 * Who is acting. `id` is stable (`usr_…`, `tok_…`, or a fixed id for open local dev); `name` is what the audit trail shows, such as an approval's `by`.
 */
export type Principal = {
  kind: 'user' | 'token' | 'open';
  id: string;
  name: string;
  email?: string;
  role: Role;
  /**
   * When this person's session last proved it was them (a step-up), as the engine read it from the
   * session; absent for anything but a signed-in session.
   */
  steppedUpAt?: number;
};

/** A session ends this long after sign-in, whatever happens. */
export const SESSION_MAX_MS = 30 * 86_400_000;
/**
 * A session that single sign-on started ends this long after sign-in, sooner than `SESSION_MAX_MS`:
 * the engine can't ask the identity provider whether the person is still there, so someone
 * disabled at the provider (with no SCIM to say so) is signed out at the latest by this, and
 * signs in at the provider again to continue. Passwords and passkeys keep `SESSION_MAX_MS`.
 */
export const SESSION_SSO_MAX_MS = 12 * 3_600_000;
/** A session also ends after this long without a request, on a page or the order page's socket. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** An admin's, sooner: an admin's browser left signed in can change who has access. */
export const SESSION_IDLE_ADMIN_MS = 12 * 3_600_000;

/** How long a session of `role` may go without a request before it ends. */
export const sessionIdleMs = (role: Role) =>
  role === 'admin' ? SESSION_IDLE_ADMIN_MS : SESSION_IDLE_MS;
/** Activity is written back at most this often. */
export const SESSION_TOUCH_MS = 5 * 60_000;

/**
 * The header the web app sets when it forwards a request to the engine (the order page's and the
 * assistant's sockets, `/mcp` and `/a2a`), after removing any copy the caller sent. The engine is
 * reachable only through the web app's service binding, and it still believes the header only
 * when it is signed: an HMAC over the principal, the path it was sent to and an expiry, under the
 * `PRINCIPAL_KEY` secret the two Workers share.
 */
export const PRINCIPAL_HEADER = 'x-commerceworker-principal';

/**
 * What the proxy header carries: the principal plus, for a signed-in person, their session's id
 * (the SHA-256 the `sessions` table is keyed by), so the agent can check the session is still live.
 * The session id never reaches the browser. A connected app's request (an OAuth grant, at `/mcp`
 * or `/a2a`) also names the grant and the client it was issued to, so two apps one person
 * connected are told apart: in the audit trail, and as separate A2A callers.
 */
export type ProxiedPrincipal = Principal & {
  session?: string;
  grant?: string;
  client?: string;
  /** For a grant, the endpoint it was granted for (RFC 8707), e.g. `https://app.example/api/v1`. */
  resource?: string;
  /** When the credential stops working (epoch ms): an API token's expiry, or an access token's. */
  expiresAt?: number;
};

/** How long a signed header is good for. A socket is checked once, when it connects. */
export const PRINCIPAL_TTL_MS = 60_000;

/** Local dev's key (`vite.config.ts` gives it to both Workers). Never a deployment's. */
export const DEV_PRINCIPAL_KEY = 'commerceworker-local-dev-principal-key';

const PRINCIPAL_VERSION = 'v1';
const enc = new TextEncoder();
const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();

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

/**
 * The header value for `p`, good for requests to `path` until `now + PRINCIPAL_TTL_MS`:
 * `v1.<payload>.<signature>`, both base64url.
 */
export function signPrincipal(
  secret: string,
  p: ProxiedPrincipal,
  path: string,
  now = Date.now(),
): Promise<string> {
  return seal(secret, PRINCIPAL_VERSION, { p, path, exp: now + PRINCIPAL_TTL_MS });
}

/**
 * The principal in a forwarded request, or null unless the header is signed by one of `secrets`
 * (the current key, then the one before it while a rotation finishes), names this `path` and
 * hasn't expired.
 */
export async function verifyPrincipal(
  secrets: readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  now = Date.now(),
): Promise<ProxiedPrincipal | null> {
  const body = await unseal(secrets, PRINCIPAL_VERSION, header, path, now);
  const p = body?.p as Partial<ProxiedPrincipal> | undefined;
  if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !isRole(p.role)) return null;
  if (p.kind !== 'user' && p.kind !== 'token' && p.kind !== 'open') return null;
  return {
    kind: p.kind,
    id: p.id,
    name: p.name,
    ...(typeof p.email === 'string' ? { email: p.email } : {}),
    role: p.role,
    ...(typeof p.session === 'string' ? { session: p.session } : {}),
    ...(typeof p.grant === 'string' ? { grant: p.grant } : {}),
    ...(typeof p.client === 'string' ? { client: p.client } : {}),
    ...(typeof p.resource === 'string' ? { resource: p.resource } : {}),
    ...(typeof p.expiresAt === 'number' ? { expiresAt: p.expiresAt } : {}),
  };
}

/** What `GET /api/v1/me` and the `whoami` tool answer (`whoamiOutput` in tool-schemas.ts). */
export type Whoami = {
  kind: 'api_token' | 'oauth' | 'session';
  role: Role;
  resource?: string;
  expiresAt?: number;
  subject: { id: string; name?: string; email?: string; label?: string };
};

/**
 * The calling credential as its holder may see it. A principal that names a grant is an OAuth
 * app acting as the person who approved it, not that person. Only what the principal already
 * carries: no secret, hash or session id.
 */
export function whoami(p: ProxiedPrincipal): Whoami {
  const kind = p.grant !== undefined ? 'oauth' : p.kind === 'token' ? 'api_token' : 'session';
  const subject =
    p.kind === 'token'
      ? { id: p.id, label: p.name.replace(/^token:/, '') }
      : { id: p.id, name: p.name, ...(p.email ? { email: p.email } : {}) };
  return {
    kind,
    role: p.role,
    ...(kind === 'oauth' && p.resource ? { resource: p.resource } : {}),
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    subject,
  };
}

/**
 * A UCP platform (an AI shopping surface the workspace let in) calling `/ucp/*`. It is not a
 * Principal: it has no role and acts only on the checkouts and orders it started, so its header
 * is a different envelope (`u1`) that `verifyPrincipal` never accepts, and the reverse.
 */
export type PlatformCaller = {
  id: string;
  name: string;
  /** The UCP profile it is registered with, and named in UCP-Agent. */
  profileUrl: string;
  /** The public origin it called, for the URLs the engine hands back (`continue_url`, profiles). */
  origin: string;
};

const PLATFORM_VERSION = 'u1';

/**
 * The buyer an external cart was opened for (by a plugin, say a punchout session), on that cart's
 * socket. Not a Principal: no role, and admitted only to the one cart, so its header is its own
 * envelope (`g1`) that `verifyPrincipal` and `verifyPlatform` never accept, signed for that cart's
 * path alone. Like every envelope the storefront signs (the platform's `u1`, the cookie `gs1`, a
 * guest's `a1`), it is under the storefront key (`storefrontKey`), never `PRINCIPAL_KEY`: the
 * storefront holds only that, so it can't mint a staff envelope.
 */
export type CartGuest = { cartId: string; id: string; name: string };

const GUEST_VERSION = 'g1';

export function signCartGuest(
  /** The storefront key (`storefrontKey`). */
  secret: string,
  g: CartGuest,
  path: string,
  now = Date.now(),
): Promise<string> {
  return seal(secret, GUEST_VERSION, { g, path, exp: now + PRINCIPAL_TTL_MS });
}

const GUEST_SESSION_VERSION = 'gs1';

/**
 * The cookie that keeps a redeemed start link's buyer on their cart (set by the web app, never
 * sent to the engine): its own envelope (`gs1`), bound to that cart and expiring with it.
 */
export function signCartGuestSession(
  /** The storefront key (`storefrontKey`). */
  secret: string,
  g: CartGuest,
  expiresAt: number,
): Promise<string> {
  return seal(secret, GUEST_SESSION_VERSION, { g, path: `cart:${g.cartId}`, exp: expiresAt });
}

export async function verifyCartGuestSession(
  secrets: readonly (string | undefined)[],
  value: string | null | undefined,
  cartId: string,
  now = Date.now(),
): Promise<CartGuest | null> {
  const body = await unseal(secrets, GUEST_SESSION_VERSION, value, `cart:${cartId}`, now);
  const g = body?.g as Partial<CartGuest> | undefined;
  if (!g || g.cartId !== cartId || typeof g.id !== 'string' || typeof g.name !== 'string')
    return null;
  return { cartId: g.cartId, id: g.id, name: g.name };
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

/** The cart guest a forwarded request is from, or null (see `verifyPrincipal`); `secrets` are storefront keys. */
export async function verifyCartGuest(
  secrets: readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  now = Date.now(),
): Promise<CartGuest | null> {
  const body = await unseal(secrets, GUEST_VERSION, header, path, now);
  const g = body?.g as Partial<CartGuest> | undefined;
  if (!g || typeof g.cartId !== 'string' || typeof g.id !== 'string' || typeof g.name !== 'string')
    return null;
  return { cartId: g.cartId, id: g.id, name: g.name };
}

/** The header value for a platform calling `path` (same header as `signPrincipal`, under the storefront key). */
export function signPlatform(
  /** The storefront key (`storefrontKey`). */
  secret: string,
  c: PlatformCaller,
  path: string,
  now = Date.now(),
): Promise<string> {
  return seal(secret, PLATFORM_VERSION, { c, path, exp: now + PRINCIPAL_TTL_MS });
}

/** The platform a forwarded `/ucp/*` request is from, or null (see `verifyPrincipal`); `secrets` are storefront keys. */
export async function verifyPlatform(
  secrets: readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  now = Date.now(),
): Promise<PlatformCaller | null> {
  const body = await unseal(secrets, PLATFORM_VERSION, header, path, now);
  const c = body?.c as Partial<PlatformCaller> | undefined;
  if (
    !c ||
    typeof c.id !== 'string' ||
    typeof c.name !== 'string' ||
    typeof c.profileUrl !== 'string' ||
    typeof c.origin !== 'string'
  )
    return null;
  return { id: c.id, name: c.name, profileUrl: c.profileUrl, origin: c.origin };
}

/**
 * A single sign-on identity waiting to be linked to a person who signs in with a password. The
 * provider vouched for `sub` with that person's email, but an email alone doesn't hand over an
 * account that has a password: the person confirms it (and their two-factor code) first. Held in
 * a short-lived cookie in the web app, never sent to the engine, as its own envelope (`sl1`).
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

/**
 * Who is acting on an approval or a cart over the engine's binding (`EngineRpc.decide`,
 * `changeCart`, `submitCart`, `cancelCart`, `attachToCart`): a staff member (their principal id,
 * the name the record shows, their role). The web app signs it (`a1`) for that one call, under
 * `PRINCIPAL_KEY`, and the engine believes nothing else for those calls. The binding's other
 * methods (plugin installs, data subjects) still trust their caller: only the web app holds it.
 * An external cart's buyer is the storefront's (`GuestActor`), under its own key.
 */
export type StaffActor = {
  kind: 'staff';
  id: string;
  name: string;
  role: Role;
  /** `person`: a person signed in as themselves, not an API token (some actions need one). */
  person?: true;
  /** An OAuth app acting as this person (its grant and client), so the audit trail names it. */
  grant?: string;
  client?: string;
};

/** An external cart's buyer acting on that cart over `StorefrontRpc`, signed by the storefront. */
export type GuestActor = { kind: 'guest'; id: string; name: string };

export type RpcActor = StaffActor | GuestActor;

/** An `RpcActor` signed for one call (`signRpcActor`, `signGuestActor`). */
export type SignedActor = string;

const ACTOR_VERSION = 'a1';

/**
 * A staff actor signed for `call` under `PRINCIPAL_KEY`; `call` names the call and what it acts
 * on, e.g. `decide:<orderId>` or `cart:<cartId>`.
 */
export function signRpcActor(
  secret: string,
  actor: StaffActor,
  call: string,
  now = Date.now(),
): Promise<SignedActor> {
  return seal(secret, ACTOR_VERSION, { a: actor, path: call, exp: now + PRINCIPAL_TTL_MS });
}

/**
 * The staff actor a call was signed for under one of `secrets` (`PRINCIPAL_KEY`, then its
 * previous), or null (see `verifyPrincipal`). A guest actor is refused whatever signed it: only
 * the storefront's key vouches for one (`verifyGuestActor`).
 */
export async function verifyRpcActor(
  secrets: readonly (string | undefined)[],
  signed: string | null | undefined,
  call: string,
  now = Date.now(),
): Promise<StaffActor | null> {
  // Anything but the string a1 envelope (an actor object from an older web app) is refused.
  if (typeof signed !== 'string') return null;
  const body = await unseal(secrets, ACTOR_VERSION, signed, call, now);
  const a = body?.a as
    | Partial<{
        kind: string;
        id: string;
        name: string;
        role: Role;
        person: unknown;
        grant: unknown;
        client: unknown;
      }>
    | undefined;
  if (a?.kind !== 'staff' || typeof a.id !== 'string' || typeof a.name !== 'string') return null;
  if (!isRole(a.role)) return null;
  return {
    kind: 'staff',
    id: a.id,
    name: a.name,
    role: a.role,
    ...(a.person === true ? { person: true as const } : {}),
    ...(typeof a.grant === 'string' ? { grant: a.grant } : {}),
    ...(typeof a.client === 'string' ? { client: a.client } : {}),
  };
}

/** A cart's buyer signed for `call` (`cart:<cartId>`) under the storefront key. */
export function signGuestActor(
  /** The storefront key (`storefrontKey`). */
  secret: string,
  actor: GuestActor,
  call: string,
  now = Date.now(),
): Promise<SignedActor> {
  return seal(secret, ACTOR_VERSION, { a: actor, path: call, exp: now + PRINCIPAL_TTL_MS });
}

/**
 * The guest a call was signed for under one of the storefront keys `secrets`, or null. A staff
 * actor is refused whatever signed it: only `PRINCIPAL_KEY` vouches for one.
 */
export async function verifyGuestActor(
  secrets: readonly (string | undefined)[],
  signed: string | null | undefined,
  call: string,
  now = Date.now(),
): Promise<GuestActor | null> {
  if (typeof signed !== 'string') return null;
  const a = (await unseal(secrets, ACTOR_VERSION, signed, call, now))?.a as
    | Partial<GuestActor>
    | undefined;
  if (a?.kind !== 'guest' || typeof a.id !== 'string' || typeof a.name !== 'string') return null;
  return { kind: 'guest', id: a.id, name: a.name };
}

/**
 * The header carrying the deploy smoke test's write check (`POST /health/write`). CI signs it; no
 * person, token or connected app ever can.
 */
export const HEALTH_CHECK_HEADER = 'x-commerceworker-health-check';

const HEALTH_CHECK_VERSION = 'h1';
const HEALTH_CHECK_LABEL = 'commerceworker-health-check';
const STOREFRONT_LABEL = 'commerceworker-storefront';
const SHOPPER_CODE_LABEL = 'commerceworker-shopper-code';
const derived = new Map<string, Promise<string>>();

/** An HMAC of `principalKey` under `label`, as hex: a key derived for one purpose. */
function derive(label: string, principalKey: string): Promise<string> {
  const id = `${label}\0${principalKey}`;
  let key = derived.get(id);
  if (!key) {
    key = (async () => {
      const mac = await crypto.subtle.sign('HMAC', await hmacKey(principalKey), enc.encode(label));
      return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
    })();
    derived.set(id, key);
  }
  return key;
}

/**
 * The key the write check is signed with: an HMAC of the deployment's principal key with its own
 * label, as `pluginKey` derives a plugin's. CI holds the principal key already, so it needs nothing
 * new; and since every other envelope is checked under the principal key itself, a write check
 * opens nothing else, nor anything else a write check. scripts/fleet.ts derives the same value.
 */
export function healthCheckKey(principalKey: string): Promise<string> {
  return derive(HEALTH_CHECK_LABEL, principalKey);
}

/**
 * The key the public storefront signs with, and the only one it holds: an HMAC of the deployment's
 * principal key with its own label. The engine derives the same from its `PRINCIPAL_KEY`, and
 * accepts under it the storefront's envelopes alone (a cart's buyer `g1`, a UCP platform `u1`, a
 * guest's `a1`; the storefront's own cookie `gs1` is checked only by the storefront), while v1
 * principals and staff `a1` actors verify only under `PRINCIPAL_KEY`. A compromised storefront can
 * therefore speak as a buyer or a platform but never mint a staff envelope. scripts/fleet.ts
 * derives the same value for the storefront's secret.
 */
export function storefrontKey(principalKey: string): Promise<string> {
  return derive(STOREFRONT_LABEL, principalKey);
}

/**
 * The key a shopper's sign-in code is hashed under (`hashShopperCode`): derived from the principal
 * key with its own label and held by the engine alone, so the storefront can't compute one and a
 * copy of the table can't be searched for a code. A rotation of the principal key lapses the codes
 * outstanding, which live ten minutes.
 */
export function shopperCodeKey(principalKey: string): Promise<string> {
  return derive(SHOPPER_CODE_LABEL, principalKey);
}

/** `storefrontKey` of each of `principalKeys` that is set (the current, then the previous). */
export async function storefrontKeys(
  principalKeys: readonly (string | undefined)[],
): Promise<string[]> {
  return Promise.all(principalKeys.filter((k): k is string => !!k).map(storefrontKey));
}

/** The write check's header value for `path`, good for `PRINCIPAL_TTL_MS`: its own envelope (`h1`). */
export async function signHealthCheck(
  principalKey: string,
  path: string,
  now = Date.now(),
): Promise<string> {
  return seal(await healthCheckKey(principalKey), HEALTH_CHECK_VERSION, {
    path,
    exp: now + PRINCIPAL_TTL_MS,
  });
}

/**
 * Whether `header` is a write check signed under one of `principalKeys` (the current key, then the
 * one before it while a rotation finishes) for this `path`, and not yet expired.
 */
export async function verifyHealthCheck(
  principalKeys: readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  now = Date.now(),
): Promise<boolean> {
  const keys = await Promise.all(principalKeys.map((k) => (k ? healthCheckKey(k) : undefined)));
  return (await unseal(keys, HEALTH_CHECK_VERSION, header, path, now)) !== null;
}

/**
 * The workspace setting (`workspace_settings`) that keeps whoever started an order from deciding
 * its approvals: `on` or `off` (the default).
 */
export const APPROVAL_SEPARATION_KEY = 'approval_separation';

/**
 * The workspace's assistant routing (`on` or `off`, off unless an admin turns it on): whether a
 * typed request the fixed rules read as one exact call runs without the chat model, when Clef is
 * sure they read it right (`apps/engine/src/assistant/routing.ts`).
 */
export const ASSISTANT_ROUTING_KEY = 'assistant_routing';

export const OWN_ORDER_REFUSAL =
  'You started this order, so someone else must decide its approvals.';

/**
 * Why `deciderId` may not decide an approval on an order that `startedBy` started, or null. Only
 * with separation on, and only when both are known: an order from a channel, an email or the
 * stock review has no starter, and anyone with the role may decide it.
 */
export function ownOrderRefusal(
  separate: boolean,
  startedBy: string | null | undefined,
  deciderId: string | null | undefined,
): string | null {
  return separate && startedBy && startedBy === deciderId ? OWN_ORDER_REFUSAL : null;
}

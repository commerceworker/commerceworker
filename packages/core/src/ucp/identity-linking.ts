/**
 * Identity linking (`dev.ucp.common.identity_linking`), the business side, pure: a UCP platform
 * that a shopper links to their address through OAuth, and acts for them afterwards, starting with
 * reading their orders (`dev.ucp.shopping.order:read`).
 *
 * The authorization server is the storefront's own host, where shoppers sign in (RFC 8414
 * metadata at its origin), and it is not the staff OAuth server: its own issuer, keys, tables and
 * tokens. The engine holds every credential; the storefront only carries them (`StorefrontRpc`).
 * The OAuth client is the registered platform (UCP's spec defines no client registration, and an
 * admin already let each platform in with a key): its `client_id` is its platform id, its
 * return addresses are the exact ones the admin registered with it, and at the token endpoint it
 * authenticates with that key, the one secret it holds. Authorization code with
 * PKCE `S256` only; tokens are opaque, stored as SHA-256 only, and bound to the platform they were
 * issued to.
 */

import { constantTimeEqual } from '../webhooks';

export const IDENTITY_LINKING_CAPABILITY = 'dev.ucp.common.identity_linking';

/**
 * The scopes this business offers, each `{capability}:{scope}` as the vendored schema words it
 * (`scope_token`), with the description a platform may show. The spec names only
 * `dev.ucp.shopping.order:read`; nothing else is offered until a capability spec defines it.
 */
export const LINK_SCOPES = {
  'dev.ucp.shopping.order:read': 'See the orders you placed with this store.',
} as const;
export type LinkScope = keyof typeof LINK_SCOPES;
export const LINK_ORDER_READ: LinkScope = 'dev.ucp.shopping.order:read';

/** `config.scopes` of the business profile's identity_linking capability (`scope_policy` each). */
export const identityLinkingConfig = () => ({
  scopes: Object.fromEntries(
    Object.entries(LINK_SCOPES).map(([scope, plain]) => [scope, { description: { plain } }]),
  ),
});

/** An authorization code works this long, once (RFC 6749 §4.1.2 asks for a minute or so). */
export const LINK_CODE_TTL_MS = 60_000;
/** An access token's life, in seconds as the token response says it. Short: a refresh renews it. */
export const LINK_ACCESS_TTL_S = 900;
/** A refresh token's life from when it was issued; each use issues the next. */
export const LINK_REFRESH_TTL_MS = 30 * 86_400_000;
/** The longest a link lasts, however it is refreshed: after this the shopper links again. */
export const LINK_GRANT_TTL_MS = 180 * 86_400_000;
/** A revoked or expired link's rows are kept this long past it, then deleted (the sweep). */
export const LINK_RETENTION_MS = 30 * 86_400_000;

/**
 * Where the authorization server lives on the storefront, and its RFC 8414 metadata at the root.
 * `/identity/*` rather than `/oauth/*`: the staff server's names stay the admin's.
 */
export const LINK_PATHS = {
  authorize: '/identity/authorize',
  token: '/identity/token',
  revoke: '/identity/revoke',
} as const;
export const LINK_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * The header the storefront passes a linked shopper's access token to the engine in, taken from
 * the platform's `Authorization: Bearer` (the platform's own key stays in `X-API-Key`). It is no
 * credential alone: the engine accepts it only beside the signed platform envelope, for the
 * platform the token was issued to.
 */
export const LINK_USER_TOKEN_HEADER = 'x-ucp-user-token';

/**
 * Secrets are `cmw_ucp<kind>_` and 43 base64url characters (32 random bytes). The prefixes can't
 * be taken for a platform's API key (`cmw_ucp_`), so a token presented as a key finds no platform.
 */
const KINDS = { code: 'c', access: 'a', refresh: 'r' } as const;
export type LinkSecretKind = keyof typeof KINDS;
const SECRET_TAIL = '[A-Za-z0-9_-]{43}';
export const LINK_SECRET: Record<LinkSecretKind, RegExp> = {
  code: new RegExp(`^cmw_ucpc_${SECRET_TAIL}$`),
  access: new RegExp(`^cmw_ucpa_${SECRET_TAIL}$`),
  refresh: new RegExp(`^cmw_ucpr_${SECRET_TAIL}$`),
};

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export const newLinkSecret = (kind: LinkSecretKind) =>
  `cmw_ucp${KINDS[kind]}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The SHA-256 a secret is stored under: a copy of the tables holds nothing to present. */
export async function hashLinkSecret(secret: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))),
  );
}

/** A PKCE verifier (RFC 7636 §4.1) and the challenge `S256` makes of it (§4.2). */
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Whether `verifier` is the one `challenge` was made from (constant time, `S256` only). */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return (
    PKCE_VERIFIER.test(verifier) && constantTimeEqual(await pkceChallenge(verifier), challenge)
  );
}

/** Return addresses one platform may register. */
export const LINK_REDIRECT_URIS_MAX = 10;

/**
 * Why `uri` can't be a registered return address, or null: https only, no fragment, no
 * credentials, and not so long a header or log would cut it. The registration (admin) and the
 * request both hold to it; the request must then equal one registered string exactly.
 */
export function linkRedirectShapeProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'The redirect_uri is not a URL.';
  }
  if (uri.length > 2000) return 'The redirect_uri is too long.';
  if (url.protocol !== 'https:') return 'The redirect_uri must be an https URL.';
  if (url.hash || uri.includes('#')) return 'The redirect_uri must have no fragment.';
  if (url.username || url.password) return 'The redirect_uri must carry no credentials.';
  return null;
}

/**
 * Why `redirectUri` is not one this platform may be sent to, or null. UCP defines no redirect
 * registration of its own, so an admin registers each exact address with the platform
 * (`redirectUris`) and a request must name one **as the same string** (RFC 9700 §2.1, OAuth 2.1): no
 * matching by origin or prefix, since any open redirect on a matched origin would hand the code on.
 * A platform with none registered can't link.
 */
export function linkRedirectProblem(
  redirectUri: string,
  registered: readonly string[],
): string | null {
  const shape = linkRedirectShapeProblem(redirectUri);
  if (shape) return shape;
  if (!registered.length) return 'This platform has no return address registered.';
  return registered.includes(redirectUri)
    ? null
    : 'The redirect_uri is not one registered for this platform.';
}

/**
 * The scopes a `scope` parameter asks for (RFC 6749 §3.3: space-separated), each one of ours, or
 * null when it is empty or names any other: a request is never narrowed behind the platform's back.
 */
export function linkScopes(raw: unknown): LinkScope[] | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  const parts = raw.split(' ').filter(Boolean);
  if (!parts.length) return null;
  const out = new Set<LinkScope>();
  for (const p of parts) {
    if (!Object.hasOwn(LINK_SCOPES, p)) return null;
    out.add(p as LinkScope);
  }
  return [...out];
}

/** Stored and sent as the `scope` string: sorted, so two orders of one set are one. */
export const joinLinkScopes = (scopes: readonly string[]) => [...scopes].sort().join(' ');
export const splitLinkScopes = (scope: string) => scope.split(' ').filter(Boolean);

/** OAuth's own error codes (RFC 6749 §4.1.2.1, §5.2; RFC 8707 §2). */
export type LinkError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied';

/** The authorization server's metadata (RFC 8414) for the storefront at `origin`. */
export function authorizationServerMetadata(origin: string) {
  const base = origin.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}${LINK_PATHS.authorize}`,
    token_endpoint: `${base}${LINK_PATHS.token}`,
    revocation_endpoint: `${base}${LINK_PATHS.revoke}`,
    scopes_supported: Object.keys(LINK_SCOPES),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    // RFC 9207: the redirect names its issuer, so a platform linking to several businesses can't be
    // led to send one's code to another.
    authorization_response_iss_parameter_supported: true,
  };
}

/** What a consent page shows: a scope and what it lets the platform do. */
export type LinkScopeView = { scope: string; description: string };

/** The consent the engine describes for a valid request from a signed-in shopper. */
export type LinkAuthorizeView =
  | {
      status: 'consent';
      platform: string;
      /** The shopper's own address: whose orders the platform would see. */
      email: string;
      scopes: LinkScopeView[];
      /** The platform's registered return address an approval or a denial sends the browser to. */
      redirectUri: string;
    }
  /** A valid request, and no one signed in: the page asks them to sign in and come back. */
  | { status: 'sign_in'; platform: string }
  | LinkRefusal;

/**
 * A request that can't go on. With `redirect`, the client and its return address were valid, so
 * the error goes back to the platform there (RFC 6749 §4.1.2.1); without, it can't be trusted to
 * go anywhere and the page shows it.
 */
export type LinkRefusal = {
  status: 'refused';
  error: LinkError;
  description: string;
  redirect: string | null;
};

/** An approval's or a denial's answer: where to send the browser. */
export type LinkDecision =
  | { status: 'redirect'; redirect: string }
  | { status: 'sign_in'; platform: string }
  | LinkRefusal;

/** What a token or revocation request answers: the HTTP status and body, as RFC 6749 §5 words them. */
export type LinkTokenResult = { status: number; body: Record<string, unknown> };

/** A platform a shopper has linked, as `/account` lists it. */
export type ShopperLink = {
  id: string;
  platform: string;
  scopes: string[];
  since: number;
  expiresAt: number;
};

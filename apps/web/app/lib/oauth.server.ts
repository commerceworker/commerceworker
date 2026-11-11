/**
 * MCP (`/mcp`), A2A (`/a2a`) and the REST API (`/api/v1`) on the public origin.
 * @cloudflare/workers-oauth-provider is the authorization server for all three: discovery (`/.well-known/oauth-authorization-server`), client
 * registration (`/oauth/register`, or a Client ID Metadata Document), tokens (`/oauth/token`) and
 * grants in `OAUTH_KV`. Each endpoint is its own protected resource, so a token is issued for one
 * of them (RFC 8707) and publishes its metadata at `/.well-known/oauth-protected-resource/<path>`.
 * The REST API's own router is the app's (workers/app.ts): it sends an OAuth access token here to be
 * checked (`apiOAuthFetch`) and keeps serving `cmw_live_` tokens and sessions itself.
 * The consent page is ours (routes/oauth-authorize.tsx): a signed-in person approves a client with
 * a role no higher than their own, and can disconnect it from their Account page.
 *
 * Both endpoints also take the REST API's credentials as a bearer token (`cmw_live_…` API tokens),
 * so clients configured with a header (Claude Code, Cursor, an A2A
 * client) work without the browser flow. Either way the caller is resolved here, as they are now,
 * and the request is forwarded to the engine (apps/engine/src/mcp.ts, apps/engine/src/a2a/) with
 * the principal header, like the agent sockets.
 */

import { env } from 'cloudflare:workers';
import {
  insufficientScope,
  OAuthAuthorizationServer,
  OAuthError,
  type OAuthHelpers,
  type OAuthResourceAuth,
  OAuthResourceServer,
} from '@cloudflare/workers-oauth-provider';
import { A2A_PATH, type Principal, ROLES, type Role } from '@commerceworker/core';
import { audit, clientIp } from './audit.server';
import {
  apiPrincipal,
  type Caller,
  type GrantProps,
  grantPrincipal,
  setupDue,
  Throttled,
  TokenExpired,
} from './auth.server';
import { sha256Hex } from './credentials';
import { engine } from './env.server';
import {
  approveDevice,
  CLI_CLIENT_ID,
  DEVICE_AUTHORIZATION_PATH,
  DEVICE_GRANT,
  DEVICE_INTERVAL_S,
  DEVICE_REDIRECT,
  DEVICE_TTL_S,
  DEVICE_VERIFICATION_PATH,
  type DeviceRecord,
  ensureCliClient,
  formatUserCode,
  imitatesCli,
  isDeviceClient,
  markDeviceClient,
  pollDevice,
  startDevice,
} from './oauth-device.server';
import { setPrincipalHeader } from './principal.server';
import { overBudget } from './rate-limit';

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
/** The REST API's resource: the prefix of every route (`/api/v1/…`), not a route itself. */
export const API_PATH = '/api/v1';

/**
 * The roles an app can be granted: a grant's scope is one of them. Admin is never offered (the
 * consent page lists these), so a connected app never acts as an admin.
 */
export const GRANTABLE_ROLES = ROLES.filter((r) => r !== 'admin') as Exclude<Role, 'admin'>[];

/** The protected endpoints, each its own OAuth resource. */
const ENDPOINTS = {
  [MCP_PATH]: 'CommerceWorker MCP',
  [A2A_PATH]: 'CommerceWorker A2A',
  [API_PATH]: 'CommerceWorker API',
} as const;
type Endpoint = keyof typeof ENDPOINTS;
const isEndpoint = (pathname: string): pathname is Endpoint => pathname in ENDPOINTS;

/** What an endpoint hands the forwarder: a caller resolved from an API token, or an OAuth grant. */
type Props = { principal: Caller } | GrantProps;

const resource = (origin: string, path: Endpoint) => `${origin}${path}`;

/**
 * Paths the OAuth roles answer; everything else goes straight to the app. The REST API is not
 * one: its routes are the app's, and only a token's check comes here (`apiOAuthFetch`).
 */
export const isOAuthPath = (pathname: string) =>
  (isEndpoint(pathname) && pathname !== API_PATH) ||
  pathname.startsWith('/.well-known/oauth-') ||
  (pathname.startsWith('/oauth/') &&
    pathname !== AUTHORIZE_PATH &&
    // The device page is the app's too (routes/oauth-device.tsx); its endpoint is not.
    // Nor its client-side data requests (`/oauth/device.data`).
    pathname.replace(/\.data$/, '') !== DEVICE_VERIFICATION_PATH);

/** The channel an authorization request is for, as the audit trail names it. */
export const channelOf = (resourceUrl: string | undefined) => {
  const path = resourceUrl ? new URL(resourceUrl).pathname : MCP_PATH;
  return path === A2A_PATH ? 'A2A' : path === API_PATH ? 'API' : 'MCP';
};

function authorizationServer(origin: string) {
  return new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: Object.keys(ENDPOINTS).map((p) => resource(origin, p as Endpoint)),
    // MCP connected before A2A existed: grants from then, and clients that name no resource, are
    // for MCP. A2A clients name theirs.
    defaultResource: resource(origin, MCP_PATH),
    legacyGrantResource: resource(origin, MCP_PATH),
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // A grant's scope is the role the person granted; admin never is.
    scopesSupported: GRANTABLE_ROLES,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
    clientIdMetadataDocumentEnabled: true,
  });
}

const spentKey = (hash: string) => `cmw_spent:${hash}`;
type Spent = { userId: string; grantId: string; at: number };

/** How long a client may still present the refresh token it just traded, for a lost response. */
export const REFRESH_GRACE_MS = 60_000;

/**
 * A refresh token presented again after it was traded for a new one (RFC 9700 §4.14.2). Each
 * refresh with the current token records it as spent (`cmw_spent:<hash>`, kept as long as a grant
 * lives). The provider still accepts the token before the current one, so a client whose answer
 * was lost may retry it within `REFRESH_GRACE_MS` of when it was traded (the window doesn't move
 * on a retry). Any other spent token coming back means a copy is in someone else's hands: the
 * grant is revoked so neither copy works, and an A2A app's push configs go with it. Holding the
 * token is the proof here, as the RFC asks, so this runs before the client authenticates. Two
 * processes sharing one client's credentials and refreshing apart will trip it too. Null for
 * anything else (including a token traded before this was recorded), which the provider answers
 * as usual.
 */
async function refreshReuse(request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const body = new URLSearchParams(await request.clone().text());
  const token = body.get('refresh_token');
  if (body.get('grant_type') !== 'refresh_token' || !token) return null;
  const [userId, grantId] = token.split(':');
  if (!userId || !grantId) return null;
  const hash = await sha256Hex(token);
  const grant = await env.OAUTH_KV.get<{
    refreshTokenId?: string;
    previousRefreshTokenId?: string;
  }>(`grant:${userId}:${grantId}`, 'json');
  if (grant?.refreshTokenId === hash) {
    // The current token, being traded now: from here on it is spent.
    const spent: Spent = { userId, grantId, at: Date.now() };
    await env.OAUTH_KV.put(spentKey(hash), JSON.stringify(spent), {
      expirationTtl: 30 * 86_400,
    });
    return null;
  }
  const spent = await env.OAUTH_KV.get<Spent>(spentKey(hash), 'json');
  if (!spent || spent.userId !== userId || spent.grantId !== grantId) return null;
  if (grant?.previousRefreshTokenId === hash && Date.now() - spent.at < REFRESH_GRACE_MS)
    return null;
  if (grant) {
    await oauthApi(request).revokeGrant(grantId, userId);
    await engine().dropA2aPushes('user', userId, [grantId]);
    await audit(request, 'oauth.refresh_reused', { target: grantId, detail: { userId } });
  }
  return Response.json(
    { error: 'invalid_grant', error_description: 'This refresh token was already used.' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

/** Tokens this authorization server issued look like `<user>:<grant>:<secret>`. */
const issuedToken = (token: string) => token.split(':').length === 3;

/** Whether a request carries an access token this server issued, rather than an API token. */
export const hasIssuedToken = (request: Request) => {
  const token = /^Bearer[\t ]+([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  return token !== undefined && issuedToken(token);
};

type ResourceHandler = ConstructorParameters<typeof OAuthResourceServer<Env, Props>>[0]['handler'];

function resourceServer(
  origin: string,
  as: OAuthAuthorizationServer<Env>,
  path: Endpoint,
  handler: ResourceHandler = {
    fetch: (request, _env, ctx) => forward(request, path, ctx.props, ctx.auth),
  },
) {
  return new OAuthResourceServer<Env, Props>({
    resourceMetadata: {
      resource: resource(origin, path),
      authorization_servers: [origin],
      resource_name: ENDPOINTS[path],
      // Also named in the 401 challenge's `scope`, so a client knows what to ask for.
      scopes_supported: GRANTABLE_ROLES,
    },
    validateToken: (env, request) => async (res, token) => {
      if (issuedToken(token)) return as.validateToken<Props>(res, token, env);
      // The REST API takes `cmw_live_` tokens in its own router, never through here.
      if (path === API_PATH) return null;
      let caller: Caller | null;
      try {
        caller = await apiPrincipal(request);
      } catch (err) {
        if (err instanceof TokenExpired)
          throw new OAuthError('invalid_token', { description: err.message, statusCode: 401 });
        if (!(err instanceof Throttled)) throw err;
        throw new OAuthError('temporarily_unavailable', {
          description: err.message,
          statusCode: 429,
          headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) },
        });
      }
      return caller ? { props: { principal: caller }, audience: res } : null;
    },
    handler,
  });
}

type Roles = {
  as: OAuthAuthorizationServer<Env>;
  endpoints: Record<Endpoint, OAuthResourceServer<Env, Props>>;
};

// One set per origin (commerceworker.com, or localhost in development), made once per isolate.
const roles = new Map<string, Roles>();

function rolesFor(origin: string): Roles {
  let r = roles.get(origin);
  if (!r) {
    const as = authorizationServer(origin);
    r = {
      as,
      endpoints: {
        [MCP_PATH]: resourceServer(origin, as, MCP_PATH),
        [A2A_PATH]: resourceServer(origin, as, A2A_PATH),
        // Only its metadata is served from here: a request to the API is `apiOAuthFetch`'s.
        [API_PATH]: resourceServer(origin, as, API_PATH, {
          fetch: () => new Response(null, { status: 404 }),
        }),
      },
    };
    roles.set(origin, r);
  }
  return r;
}

const PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';

/**
 * Serves an OAuth path (see `isOAuthPath`): an endpoint or its resource metadata goes to that
 * resource server, everything else (discovery, registration, tokens) to the authorization server.
 */
export async function oauthFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  // Registration and tokens are open to anyone on the internet: limit each address.
  const limiter =
    url.pathname === '/oauth/register'
      ? env.OAUTH_REGISTER_LIMIT
      : url.pathname === '/oauth/token' || url.pathname === DEVICE_AUTHORIZATION_PATH
        ? env.OAUTH_TOKEN_LIMIT
        : undefined;
  if (
    limiter &&
    !(
      await limiter.limit({
        key: `${url.pathname === DEVICE_AUTHORIZATION_PATH ? 'device-start:' : ''}${clientIp(request)}`,
      })
    ).success
  )
    return Response.json(
      { error: 'slow_down', error_description: 'Too many requests; try again in a minute.' },
      { status: 429, headers: { 'retry-after': '60' } },
    );
  const { as, endpoints } = rolesFor(url.origin);
  if (url.pathname === DEVICE_AUTHORIZATION_PATH) return deviceAuthorization(request);
  if (url.pathname === '/oauth/register') {
    // Nobody registers as the first-party CLI, whichever grant they ask for.
    const name = await request
      .clone()
      .json()
      .then((m) => (m as { client_name?: unknown } | null)?.client_name)
      .catch(() => undefined);
    if (request.method === 'POST' && typeof name === 'string' && imitatesCli(name))
      return oauthError('invalid_client_metadata', 'That client name is reserved.');
    const registration = await deviceRegistration(request);
    const res = await as.fetch(registration.request, env, ctx);
    // Only a client that registered for the device grant may start a device sign-in.
    if (registration.device && res.status === 201)
      await markDeviceClient(((await res.clone().json()) as { client_id: string }).client_id);
    return res;
  }
  if (url.pathname === '/oauth/token') {
    const reused = await refreshReuse(request);
    if (reused) return reused;
    const device = await deviceToken(request, (r) => as.fetch(r, env, ctx));
    if (device) return device;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server')
    return withDeviceMetadata(await as.fetch(request, env, ctx), url.origin);
  const path = url.pathname.startsWith(`${PROTECTED_RESOURCE}/`)
    ? url.pathname.slice(PROTECTED_RESOURCE.length)
    : url.pathname;
  if (isEndpoint(path)) return endpoints[path].fetch(request, env, ctx);
  return as.fetch(request, env, ctx);
}

const oauthError = (error: string, description: string, status = 400, extra = {}) =>
  Response.json(
    { error, error_description: description, ...extra },
    { status, headers: { 'cache-control': 'no-store' } },
  );

/** Roughly where a request came from, as Cloudflare places it: "Paris, Île-de-France, FR". */
function placeOf(request: Request): string | null {
  const cf = (request as { cf?: { city?: string; region?: string; country?: string } }).cf;
  const place = [cf?.city, cf?.region, cf?.country].filter(Boolean).join(', ');
  return place || null;
}

/**
 * RFC 8628 §3.1: a public client with a role and a resource asks for a device code. The terminal
 * shows the user code and where to enter it; nothing here proves who is asking, so nothing is
 * granted until a signed-in person approves it (`routes/oauth-device.tsx`).
 */
async function deviceAuthorization(request: Request): Promise<Response> {
  if (request.method !== 'POST')
    return Response.json({ error: 'Use POST' }, { status: 405, headers: { allow: 'POST' } });
  const body = new URLSearchParams(await request.text());
  const { origin } = new URL(request.url);
  const clientId = body.get('client_id');
  if (!clientId) return oauthError('invalid_request', 'client_id is required.');
  // A metadata-document id is a URL anyone can name, so a device flow could borrow a publisher's
  // good name on the approval page: those clients sign in with a browser, never a code.
  if (/^[a-z][a-z0-9+.-]*:/i.test(clientId))
    return oauthError('invalid_client', 'This client can’t use a device code.');
  let client: Awaited<ReturnType<OAuthHelpers['lookupClient']>>;
  try {
    if (clientId === CLI_CLIENT_ID) await ensureCliClient();
    client = await oauthApi(request).lookupClient(clientId);
  } catch {
    return oauthError('invalid_client', 'This client can’t be checked.');
  }
  if (!client) return oauthError('invalid_client', 'Unknown client.', 401);
  // A device has no secret to keep: a confidential client signs in the usual way.
  if (client.tokenEndpointAuthMethod !== 'none')
    return oauthError('unauthorized_client', 'Only public clients may use a device code.');
  if (!(await isDeviceClient(clientId)) || !client.redirectUris.includes(DEVICE_REDIRECT))
    return oauthError('unauthorized_client', 'This client did not register for the device grant.');
  const scope = (body.get('scope') ?? '').split(/\s+/).filter(Boolean);
  const role = scope[0] ?? 'viewer';
  // One role, never admin (a connected app never acts as one).
  if (scope.length > 1 || !(GRANTABLE_ROLES as string[]).includes(role))
    return oauthError('invalid_scope', `Ask for one role: ${GRANTABLE_ROLES.join(', ')}.`);
  const resourceUrl = body.get('resource') ?? resource(origin, API_PATH);
  if (!Object.keys(ENDPOINTS).some((p) => resource(origin, p as Endpoint) === resourceUrl))
    return oauthError('invalid_target', 'CommerceWorker offers no such resource.');
  const { deviceCode, userCode } = await startDevice({
    clientId,
    role: role as DeviceRecord['role'],
    resource: resourceUrl,
    origin: {
      ip: clientIp(request),
      place: placeOf(request),
      at: Date.now(),
    },
  });
  const verification = `${origin}${DEVICE_VERIFICATION_PATH}`;
  return Response.json(
    {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verification,
      verification_uri_complete: `${verification}?user_code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_TTL_S,
      interval: DEVICE_INTERVAL_S,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Registration for a client that names the device grant, which the provider doesn't know: it is
 * registered for the authorization-code grant the device approval mints, with `DEVICE_REDIRECT`
 * beside any return addresses it gave (the provider insists on one). RFC 7591 lets a server answer
 * with what it registered. `device` says the registration asked for the grant, so its client id
 * is marked once it succeeds.
 */
async function deviceRegistration(
  request: Request,
): Promise<{ request: Request; device: boolean }> {
  if (request.method !== 'POST') return { request, device: false };
  const meta = (await request
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const grants = meta?.grant_types;
  if (!meta || !Array.isArray(grants) || !grants.includes(DEVICE_GRANT))
    return { request, device: false };
  const redirects = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return {
    device: true,
    request: new Request(request.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...meta,
        grant_types: [
          ...new Set([...grants.filter((g) => g !== DEVICE_GRANT), 'authorization_code']),
        ],
        redirect_uris: [...new Set([...redirects, DEVICE_REDIRECT])],
      }),
    }),
  };
}

/**
 * The device grant at `/oauth/token` (RFC 8628 §3.4): the answers while a person decides, and once
 * they approve, the authorization-code exchange the provider already knows, with the device code
 * as its PKCE verifier. Tokens, refresh rotation and reuse detection are the provider's.
 * Null for any other grant.
 */
async function deviceToken(
  request: Request,
  exchange: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const body = new URLSearchParams(await request.clone().text());
  if (body.get('grant_type') !== DEVICE_GRANT) return null;
  const deviceCode = body.get('device_code');
  const clientId = body.get('client_id');
  if (!deviceCode || !clientId)
    return oauthError('invalid_request', 'device_code and client_id are required.');
  const polled = await pollDevice(deviceCode, clientId);
  if ('error' in polled)
    return oauthError(polled.error, polled.description, 400, {
      ...(polled.interval ? { interval: polled.interval } : {}),
    });
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: polled.exchange.code,
    code_verifier: deviceCode,
    redirect_uri: polled.exchange.redirectUri,
    client_id: clientId,
  });
  for (const name of ['resource', 'scope']) {
    const value = body.get(name);
    if (value) form.set(name, value);
  }
  return exchange(
    new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
  );
}

/** The authorization server's metadata with the device grant (RFC 8628 §4) added to it. */
async function withDeviceMetadata(res: Response, origin: string): Promise<Response> {
  const text = res.ok ? await res.clone().text() : '';
  if (!text) return res;
  const meta = JSON.parse(text) as { grant_types_supported?: string[] };
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(
    JSON.stringify({
      ...meta,
      grant_types_supported: [...(meta.grant_types_supported ?? []), DEVICE_GRANT],
      device_authorization_endpoint: `${origin}${DEVICE_AUTHORIZATION_PATH}`,
      // The first-party CLI needs no registration: it signs in as this client.
      commerceworker_cli_client_id: CLI_CLIENT_ID,
    }),
    { status: res.status, headers },
  );
}

/**
 * A person's approval of a device code: mints the grant through the provider (so it shows on the
 * Account page and is revoked like any other) for the code's client, resource and the chosen
 * role, and leaves its authorization code with the device record, redeemable only by whoever
 * holds the device code. Returns the app's name for the audit trail.
 */
export async function approveDeviceGrant(
  request: Request,
  me: Caller,
  id: string,
  record: DeviceRecord,
  role: Role,
): Promise<string> {
  const oauth = oauthApi(request);
  const client = await oauth.lookupClient(record.clientId);
  if (!client?.redirectUris.includes(DEVICE_REDIRECT))
    throw new Error('This client can no longer be granted access.');
  const redirectUri = DEVICE_REDIRECT;
  const app = client.clientName || record.clientId;
  const props: GrantProps = { kind: me.kind, id: me.id, role };
  const { redirectTo } = await oauth.completeAuthorization({
    request: {
      responseType: 'code',
      clientId: record.clientId,
      redirectUri,
      scope: [role],
      state: '',
      // The device code's own challenge: only the terminal that holds it can redeem the code.
      codeChallenge: id,
      codeChallengeMethod: 'S256',
      resource: record.resource,
    },
    userId: me.id,
    // Shown on the Account page. No host: nothing was sent anywhere.
    metadata: { app, channel: channelOf(record.resource), via: 'device' },
    scope: [role],
    props,
  });
  const code = new URL(redirectTo).searchParams.get('code');
  if (!code) throw new Error('The provider issued no authorization code.');
  await approveDevice(id, record, { code, redirectUri });
  return app;
}

/** What the REST router does with a caller once an access token has named one. */
export type ApiRun = (caller: Caller) => Promise<Response>;

/**
 * Checks an OAuth access token presented at `/api/v1/…` and, for one granted for the REST API
 * (and no other resource: an MCP or A2A token is refused here as an API one is at `/mcp`), runs
 * the request as the person who approved it. The caller is resolved as MCP resolves its grants
 * (`grantPrincipal`): the role is the lower of the token's scope and the person's own now, and a
 * disabled or deleted person is refused. It is marked with its grant, so it is never taken for a
 * person at a step-up or a confirmation (`runRestOperation`).
 */
export async function apiOAuthFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  run: ApiRun,
): Promise<Response> {
  const { origin } = new URL(request.url);
  // Made per request: its handler is this request's `run`.
  const server = resourceServer(origin, rolesFor(origin).as, API_PATH, {
    fetch: async (_request, _env, c) => {
      const { props, auth } = c;
      if ('principal' in props) return unauthorized(origin);
      const grant = scopedGrant(props, auth.scope);
      if (!grant) return insufficientScope(auth, [props.role], 'This token names no role.');
      const caller = await grantPrincipal(grant);
      if (!caller) return unauthorized(origin, 'This connection has ended. Connect the app again.');
      const grantId = auth.token.split(':')[1];
      return run({
        ...caller,
        ...(grantId ? { grant: grantId } : {}),
        ...(auth.clientId ? { client: auth.clientId } : {}),
        resource: auth.audience,
        ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt * 1000 } : {}),
      });
    },
  });
  return withoutCors(await server.fetch(request, env, ctx));
}

/**
 * The REST API offers no CORS, whichever credential a call carries: browser apps call it from a
 * backend. The resource server adds `Access-Control-*` (reflecting any Origin) to every answer,
 * which suits `/mcp`'s browser-based clients but not here, so they are dropped.
 */
function withoutCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const name of [...out.headers.keys()])
    if (name.startsWith('access-control-')) out.headers.delete(name);
  return out;
}

/** The `WWW-Authenticate` of a 401 at `/api/v1`: where its resource metadata is, as `/mcp`'s is. */
export function apiChallenge(origin: string, invalidToken = false) {
  return `Bearer realm="OAuth", resource_metadata="${origin}${PROTECTED_RESOURCE}${API_PATH}"${
    invalidToken ? ', error="invalid_token"' : ''
  }, scope="${GRANTABLE_ROLES.join(' ')}"`;
}

const unauthorized = (origin: string, error = 'Unauthorized') =>
  Response.json(
    { error },
    { status: 401, headers: { 'www-authenticate': apiChallenge(origin, true) } },
  );

/** The authorization server's helpers, for the consent page and the Account page. */
export function oauthApi(request: Request): OAuthHelpers {
  return rolesFor(new URL(request.url).origin).as.getOAuthApi(env);
}

/** A browser Origin, when there is one, must at least be a real web origin. */
function badOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol !== 'https:' && u.protocol !== 'http:';
  } catch {
    return true;
  }
}

/**
 * The grant as this token may use it: a token carries the grant's role as its scope, or less when
 * the app asked for a narrower token (RFC 6749 §6), so the lowest role it names is the one it gets.
 * Null for a token that names no role.
 */
export function scopedGrant(props: GrantProps, scope: readonly string[]): GrantProps | null {
  const named = ROLES.filter((r) => scope.includes(r));
  const lowest = named[0];
  if (!lowest) return null;
  return {
    ...props,
    role: ROLES.indexOf(lowest) < ROLES.indexOf(props.role) ? lowest : props.role,
  };
}

async function forward(
  request: Request,
  path: Endpoint,
  props: Props,
  auth: OAuthResourceAuth,
): Promise<Response> {
  if (badOrigin(request)) return Response.json({ error: 'Origin refused' }, { status: 403 });
  let caller: Caller | null;
  // A connected app is named by its grant (an issued token is `<user>:<grant>:<secret>`) and client.
  let app: { grant: string; client?: string; resource: string; expiresAt?: number } | null = null;
  if ('principal' in props) caller = props.principal;
  else {
    const grant = scopedGrant(props, auth.scope);
    if (!grant) return insufficientScope(auth, [props.role], 'This token names no role.');
    caller = await grantPrincipal(grant);
    const grantId = auth.token.split(':')[1];
    if (grantId)
      app = {
        grant: grantId,
        ...(auth.clientId ? { client: auth.clientId } : {}),
        resource: auth.audience,
        ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt * 1000 } : {}),
      };
  }
  if (!caller)
    return Response.json(
      { error: 'This connection has ended. Connect the app again.' },
      { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } },
    );
  const due = setupDue(caller);
  if (due) return Response.json({ error: due }, { status: 403 });
  // MCP and A2A have a budget each, per principal.
  const limited = await overBudget('AGENT_LIMIT', `${path}:${caller.id}`);
  if (limited) return limited;
  const { twoFactorDue: _due, passwordChangeDue: _pw, ...principal } = caller;
  const headers = new Headers(request.headers);
  // The engine trusts the principal header; the client's credential stays here.
  headers.delete('authorization');
  headers.delete('cookie');
  await setPrincipalHeader(headers, { ...(principal satisfies Principal), ...app }, path);
  return engine().fetch(new Request(`https://engine${path}`, new Request(request, { headers })));
}

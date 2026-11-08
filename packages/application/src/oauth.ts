import {
  type ApiKeyKind,
  assertPkcePresent,
  assertScopesAllowed,
  type ClientRegistrationInput,
  ForbiddenError,
  formatScopeString,
  normalizeClientRegistration,
  normalizeUserCode,
  type OAuthClient,
  OAuthError,
  type OAuthGrantType,
  PKCE_METHOD_S256,
  parseScopeString,
  resolveRedirectUri,
  SCOPES,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  verifyPkce,
} from '@commerceworker/domain';
import type { Hasher, OAuthGrantRecord } from '@commerceworker/ports';
import { assertMayMintKeys, createApiKey, type KeyIssuer } from './auth';
import type { AppContext } from './context';
import { invalidateCachedPrincipals } from './principal-cache';
import { randomSecret, randomUserCode, sha256Base64Url } from './token-crypto';

/**
 * OAuth 2.1 authorization server.
 *
 * Access tokens are ordinary API keys with `issuance: 'oauth'` and a short
 * expiry, so there is exactly one authentication path in the system: whatever
 * `authenticate` enforces for keys — expiry, revocation, live role resolution,
 * last-used tracking — applies unchanged to OAuth tokens. Nothing here mints a
 * credential the rest of the platform doesn't already understand.
 */

export interface OAuthConfig {
  /** Public base URL of this authorization server, e.g. `https://cms.example.com`. */
  readonly issuer: string;
  /** Canonical URI of the protected resource (the MCP endpoint). */
  readonly resource: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly authorizationCodeTtlSeconds: number;
  readonly deviceCodeTtlSeconds: number;
  readonly devicePollIntervalSeconds: number;
  /** Ceiling on what an anonymously-registered client may ever request. */
  readonly maxClientScopes: readonly string[];
}

/**
 * Defaults. The 60-second authorization-code lifetime is the OAuth 2.1
 * recommendation — a code is redeemed immediately by a machine, so anything
 * longer is only an attack window.
 */
export function defaultOAuthConfig(issuer: string, resource: string): OAuthConfig {
  return {
    issuer,
    resource,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 30 * 24 * 3600,
    authorizationCodeTtlSeconds: 60,
    deviceCodeTtlSeconds: 600,
    devicePollIntervalSeconds: 5,
    // Anonymous registration deliberately cannot reach `space:admin` or
    // `content:manage`: an unauthenticated client must not be able to put
    // "manage this space" in front of a human as a single approve button.
    maxClientScopes: [
      SCOPES.deliveryRead,
      SCOPES.previewRead,
      SCOPES.searchRead,
      SCOPES.contentWrite,
      SCOPES.contentPublish,
    ],
  };
}

/** What a human approving a grant contributes: identity, space, and a ceiling. */
export interface OAuthApproval {
  readonly spaceId: string;
  readonly subject: string;
  /** Role bound to the issued token, so permissions stay live-resolved. */
  readonly roleId?: string;
  /** The approver's own scopes — a grant can never exceed them. */
  readonly approverScopes: readonly string[];
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// Client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  readonly client: OAuthClient;
  /** Present only for confidential clients; returned once, never stored raw. */
  readonly clientSecret?: string;
}

/**
 * Dynamic client registration. Open by design — MCP clients must be able to
 * register themselves — so the blast radius is contained by `maxClientScopes`
 * and by the fact that a registered client holds no authority until a human
 * approves a grant for it.
 */
export async function registerOAuthClient(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  input: ClientRegistrationInput,
): Promise<RegisteredClient> {
  const normalized = normalizeClientRegistration(input, config.maxClientScopes);
  const confidential = normalized.tokenEndpointAuthMethod !== 'none';
  const clientSecret = confidential ? randomSecret() : undefined;

  const client: OAuthClient = {
    id: ctx.ids.newId(),
    clientName: normalized.clientName,
    redirectUris: normalized.redirectUris,
    grantTypes: normalized.grantTypes,
    scopes: normalized.scopes,
    tokenEndpointAuthMethod: normalized.tokenEndpointAuthMethod,
    hashedClientSecret: clientSecret ? hasher.hash(clientSecret) : undefined,
    clientUri: normalized.clientUri,
    logoUri: normalized.logoUri,
    softwareId: normalized.softwareId,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.oauthClients.create(client);
  return { client, clientSecret };
}

export async function getOAuthClient(ctx: AppContext, clientId: string): Promise<OAuthClient> {
  const client = await ctx.store.oauthClients.get(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id', 401);
  return client;
}

export async function listOAuthClients(ctx: AppContext): Promise<OAuthClient[]> {
  return ctx.store.oauthClients.list();
}

export async function deleteOAuthClient(ctx: AppContext, clientId: string): Promise<void> {
  await ctx.store.oauthClients.delete(clientId);
}

/**
 * Authenticates the client at the token endpoint. Public clients (`none`) are
 * identified but not authenticated — which is exactly why PKCE is mandatory.
 */
export async function authenticateOAuthClient(
  ctx: AppContext,
  hasher: Hasher,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthClient> {
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
  const client = await getOAuthClient(ctx, clientId);
  if (client.tokenEndpointAuthMethod === 'none') return client;
  if (!clientSecret || !client.hashedClientSecret) {
    throw new OAuthError('invalid_client', 'client_secret is required', 401);
  }
  if (hasher.hash(clientSecret) !== client.hashedClientSecret) {
    throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
  }
  return client;
}

function assertGrantAllowed(client: OAuthClient, grant: OAuthGrantType): void {
  if (!client.grantTypes.includes(grant)) {
    throw new OAuthError('unauthorized_client', `Client may not use the ${grant} grant`);
  }
}

/**
 * RFC 8707 resource indicator check. Validated when present rather than
 * required, because clients in the wild are inconsistent about sending it; a
 * mismatch is always refused, so a token minted for us can't be aimed elsewhere.
 */
function assertResourceMatches(config: OAuthConfig, resource: string | undefined): void {
  if (!resource) return;
  const canonical = (value: string) => value.replace(/\/$/, '');
  if (canonical(resource) !== canonical(config.resource)) {
    throw new OAuthError('invalid_request', `Unknown resource "${resource}"`);
  }
}

// ---------------------------------------------------------------------------
// Authorization code flow
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  readonly clientId?: string;
  readonly redirectUri?: string;
  readonly responseType?: string;
  readonly scope?: string;
  readonly state?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly resource?: string;
}

/** An authorization request that passed validation, ready for the consent UI. */
export interface ValidatedAuthorization {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly codeChallenge: string;
  readonly resource?: string;
}

/**
 * Validates an `/authorize` request before any human sees it.
 *
 * Errors here must NOT be redirected back to the client: an unvalidated
 * redirect_uri is exactly the open-redirect an attacker wants. Callers render
 * these directly. Once this returns, redirecting errors is safe.
 */
export async function validateAuthorizationRequest(
  ctx: AppContext,
  config: OAuthConfig,
  req: AuthorizationRequest,
): Promise<ValidatedAuthorization> {
  if (!req.clientId) throw new OAuthError('invalid_request', 'client_id is required');
  const client = await getOAuthClient(ctx, req.clientId);
  assertGrantAllowed(client, 'authorization_code');

  const redirectUri = resolveRedirectUri(client, req.redirectUri);
  if ((req.responseType ?? 'code') !== 'code') {
    throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
  }
  assertPkcePresent(req.codeChallenge, req.codeChallengeMethod);
  assertResourceMatches(config, req.resource);

  const requested = parseScopeString(req.scope);
  const scopes = requested.length
    ? assertScopesAllowed(requested, client.scopes)
    : [...client.scopes];

  return {
    client,
    redirectUri,
    scopes,
    state: req.state,
    codeChallenge: req.codeChallenge as string,
    resource: req.resource,
  };
}

/** Narrows the requested scopes to what the approving human actually holds. */
function grantableScopes(requested: readonly string[], approval: OAuthApproval): readonly string[] {
  const granted = requested.filter((s) => approval.approverScopes.includes(s));
  if (granted.length === 0) {
    throw new OAuthError(
      'access_denied',
      'You do not hold any of the permissions this application requested',
    );
  }
  return granted;
}

export interface AuthorizationCodeIssued {
  readonly code: string;
  readonly redirectTo: string;
  readonly grantedScopes: readonly string[];
}

/** Issues an authorization code after a human approved the request. */
export async function approveAuthorization(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  request: ValidatedAuthorization,
  approval: OAuthApproval,
): Promise<AuthorizationCodeIssued> {
  if (!approval.spaceId || approval.spaceId === '*') {
    throw new OAuthError('access_denied', 'A grant belongs to one space');
  }
  const grantedScopes = grantableScopes(request.scopes, approval);
  const code = `cwc_${randomSecret()}`;
  const now = ctx.clock.now();

  await ctx.store.oauthGrants.create({
    id: ctx.ids.newId(),
    kind: 'code',
    clientId: request.client.id,
    hashedCode: hasher.hash(code),
    status: 'approved',
    scopes: grantedScopes,
    spaceId: approval.spaceId,
    subject: approval.subject,
    roleId: approval.roleId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: PKCE_METHOD_S256,
    resource: request.resource,
    expiresAt: new Date(now.getTime() + config.authorizationCodeTtlSeconds * 1000),
    createdAt: now,
  });

  const url = new URL(request.redirectUri);
  url.searchParams.set('code', code);
  if (request.state) url.searchParams.set('state', request.state);
  return { code, redirectTo: url.href, grantedScopes };
}

/** Builds the redirect for a denied authorization (RFC 6749 §4.1.2.1). */
export function denyAuthorization(request: ValidatedAuthorization): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('error_description', 'The user denied the request');
  if (request.state) url.searchParams.set('state', request.state);
  return url.href;
}

export interface CodeExchangeInput {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly code?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string;
  readonly resource?: string;
}

/**
 * Redeems an authorization code for an access token (+ refresh token).
 *
 * Replay handling follows OAuth 2.1: presenting an already-consumed code
 * revokes every token descended from it, on the assumption that if a code
 * leaked, the attacker may have redeemed it first.
 */
export async function exchangeAuthorizationCode(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  input: CodeExchangeInput,
): Promise<OAuthTokenResponse> {
  const client = await authenticateOAuthClient(ctx, hasher, input.clientId, input.clientSecret);
  assertGrantAllowed(client, 'authorization_code');
  if (!input.code) throw new OAuthError('invalid_request', 'code is required');

  const grant = await ctx.store.oauthGrants.findByHash('code', hasher.hash(input.code));
  if (!grant) throw new OAuthError('invalid_grant', 'Unknown or expired authorization code');

  if (grant.status === 'consumed') {
    await revokeGrantFamily(ctx, grant.parentId ?? grant.id);
    throw new OAuthError('invalid_grant', 'Authorization code has already been used');
  }
  if (grant.status !== 'approved') {
    throw new OAuthError('invalid_grant', 'Authorization code is not usable');
  }
  if (grant.clientId !== client.id) {
    throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
  }
  if (grant.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    throw new OAuthError('invalid_grant', 'Authorization code has expired');
  }
  // RFC 6749 §4.1.3 — the redirect_uri must be identical to the one authorized.
  if (input.redirectUri && input.redirectUri !== grant.redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  }
  assertResourceMatches(config, input.resource ?? grant.resource);
  verifyPkce(
    grant.codeChallenge as string,
    grant.codeChallengeMethod ?? PKCE_METHOD_S256,
    input.codeVerifier,
    sha256Base64Url,
  );

  await ctx.store.oauthGrants.save({ ...grant, status: 'consumed' });
  return issueTokens(ctx, hasher, config, grant, grant.id);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshInput {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly resource?: string;
}

/**
 * Exchanges a refresh token for a new access token, rotating the refresh token
 * (OAuth 2.1 requires rotation for public clients). Reusing a rotated refresh
 * token revokes the whole family — the standard stolen-token detection.
 */
export async function refreshAccessToken(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  input: RefreshInput,
): Promise<OAuthTokenResponse> {
  const client = await authenticateOAuthClient(ctx, hasher, input.clientId, input.clientSecret);
  assertGrantAllowed(client, 'refresh_token');
  if (!input.refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');

  const grant = await ctx.store.oauthGrants.findByHash('refresh', hasher.hash(input.refreshToken));
  if (!grant) throw new OAuthError('invalid_grant', 'Unknown refresh token');
  if (grant.clientId !== client.id) {
    throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
  }
  if (grant.status === 'consumed' || grant.status === 'revoked') {
    await revokeGrantFamily(ctx, grant.parentId ?? grant.id);
    throw new OAuthError('invalid_grant', 'Refresh token has already been used');
  }
  if (grant.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    throw new OAuthError('invalid_grant', 'Refresh token has expired');
  }
  assertResourceMatches(config, input.resource);

  // A refresh may narrow scope but never widen it (RFC 6749 §6).
  const requested = parseScopeString(input.scope);
  const scopes = requested.length ? assertScopesAllowed(requested, grant.scopes) : grant.scopes;

  await ctx.store.oauthGrants.save({ ...grant, status: 'consumed' });
  return issueTokens(ctx, hasher, config, { ...grant, scopes }, grant.parentId ?? grant.id);
}

// ---------------------------------------------------------------------------
// Device authorization flow (RFC 8628)
// ---------------------------------------------------------------------------

export interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** Starts a device flow: the CLI polls `device_code`, the human types `user_code`. */
export async function startDeviceAuthorization(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  input: { clientId?: string; scope?: string; resource?: string },
): Promise<DeviceAuthorizationResponse> {
  if (!input.clientId) throw new OAuthError('invalid_request', 'client_id is required');
  const client = await getOAuthClient(ctx, input.clientId);
  assertGrantAllowed(client, 'urn:ietf:params:oauth:grant-type:device_code');
  assertResourceMatches(config, input.resource);

  const requested = parseScopeString(input.scope);
  const scopes = requested.length
    ? assertScopesAllowed(requested, client.scopes)
    : [...client.scopes];

  const deviceCode = `cwd_${randomSecret()}`;
  const userCode = randomUserCode(USER_CODE_ALPHABET, USER_CODE_LENGTH);
  const now = ctx.clock.now();

  await ctx.store.oauthGrants.create({
    id: ctx.ids.newId(),
    kind: 'device',
    clientId: client.id,
    hashedCode: hasher.hash(deviceCode),
    hashedUserCode: hasher.hash(userCode),
    status: 'pending',
    scopes,
    resource: input.resource,
    expiresAt: new Date(now.getTime() + config.deviceCodeTtlSeconds * 1000),
    createdAt: now,
  });

  const base = config.issuer.replace(/\/$/, '');
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/oauth/device`,
    verification_uri_complete: `${base}/oauth/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: config.deviceCodeTtlSeconds,
    interval: config.devicePollIntervalSeconds,
  };
}

export interface PendingDeviceGrant {
  readonly grant: OAuthGrantRecord;
  readonly client: OAuthClient;
}

/** Resolves a human-typed user code to the pending grant awaiting approval. */
export async function lookupDeviceGrant(
  ctx: AppContext,
  hasher: Hasher,
  rawUserCode: string,
): Promise<PendingDeviceGrant> {
  const userCode = normalizeUserCode(rawUserCode);
  const grant = await ctx.store.oauthGrants.findByUserCodeHash(hasher.hash(userCode));
  if (!grant) throw new OAuthError('invalid_grant', 'That code is not valid or has expired');
  if (grant.status !== 'pending') {
    throw new OAuthError('invalid_grant', 'That code has already been used');
  }
  if (grant.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    throw new OAuthError('expired_token', 'That code has expired. Start again on your device.');
  }
  return { grant, client: await getOAuthClient(ctx, grant.clientId) };
}

/** Records a human's approve/deny decision against a pending device grant. */
export async function decideDeviceAuthorization(
  ctx: AppContext,
  hasher: Hasher,
  rawUserCode: string,
  decision: 'approve' | 'deny',
  approval: OAuthApproval,
): Promise<void> {
  const { grant } = await lookupDeviceGrant(ctx, hasher, rawUserCode);
  if (decision === 'deny') {
    await ctx.store.oauthGrants.save({ ...grant, status: 'denied' });
    return;
  }
  await ctx.store.oauthGrants.save({
    ...grant,
    status: 'approved',
    scopes: grantableScopes(grant.scopes, approval),
    spaceId: approval.spaceId,
    subject: approval.subject,
    roleId: approval.roleId,
  });
}

export interface DeviceExchangeInput {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly deviceCode?: string;
}

/**
 * The device-flow poll. Returns tokens once approved; until then it raises the
 * RFC 8628 signalling errors (`authorization_pending`, `access_denied`,
 * `expired_token`) that a polling client is expected to interpret.
 */
export async function exchangeDeviceCode(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  input: DeviceExchangeInput,
): Promise<OAuthTokenResponse> {
  const client = await authenticateOAuthClient(ctx, hasher, input.clientId, input.clientSecret);
  assertGrantAllowed(client, 'urn:ietf:params:oauth:grant-type:device_code');
  if (!input.deviceCode) throw new OAuthError('invalid_request', 'device_code is required');

  const grant = await ctx.store.oauthGrants.findByHash('device', hasher.hash(input.deviceCode));
  if (!grant || grant.clientId !== client.id) {
    throw new OAuthError('invalid_grant', 'Unknown device_code');
  }
  if (grant.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    throw new OAuthError('expired_token', 'The device code has expired');
  }
  switch (grant.status) {
    case 'pending':
      throw new OAuthError('authorization_pending', 'Waiting for the user to approve');
    case 'denied':
      throw new OAuthError('access_denied', 'The user denied the request');
    case 'consumed':
    case 'revoked':
      throw new OAuthError('invalid_grant', 'The device code has already been used');
    case 'approved':
      break;
  }

  await ctx.store.oauthGrants.save({ ...grant, status: 'consumed' });
  return issueTokens(ctx, hasher, config, grant, grant.id);
}

// ---------------------------------------------------------------------------
// Token issuance, revocation, retention
// ---------------------------------------------------------------------------

/**
 * Mints the access token (an API key with `issuance: 'oauth'`) and a rotating
 * refresh token, both descending from `familyId` so a replay can revoke the
 * whole lineage at once.
 */
async function issueTokens(
  ctx: AppContext,
  hasher: Hasher,
  config: OAuthConfig,
  grant: OAuthGrantRecord,
  familyId: string,
): Promise<OAuthTokenResponse> {
  if (!grant.spaceId || !grant.subject) {
    throw new OAuthError('server_error', 'Grant is missing its approved identity', 500);
  }
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + config.accessTokenTtlSeconds * 1000);

  const { apiKey, token } = await createApiKey(ctx, hasher, {
    // The grant a person approved, minting its own token.
    issuer: 'system',
    spaceId: grant.spaceId,
    kind: kindForScopes(grant.scopes),
    name: `oauth:${grant.clientId}`,
    scopes: grant.scopes,
    roleId: grant.roleId,
    expiresAt: expiresAt.toISOString(),
    issuance: 'oauth',
    subject: grant.subject,
    clientId: grant.clientId,
  });

  const refreshToken = `cwr_${randomSecret()}`;
  await ctx.store.oauthGrants.create({
    id: ctx.ids.newId(),
    kind: 'refresh',
    clientId: grant.clientId,
    hashedCode: hasher.hash(refreshToken),
    status: 'approved',
    scopes: grant.scopes,
    spaceId: grant.spaceId,
    subject: grant.subject,
    roleId: grant.roleId,
    resource: grant.resource,
    parentId: familyId,
    issuedKeyIds: [apiKey.id],
    expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
    createdAt: now,
  });

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: formatScopeString(grant.scopes),
  };
}

/**
 * The API key *kind* that matches a granted scope set. Kind drives which API
 * surfaces a token may touch, so it is derived from the authority actually
 * granted rather than being asked for by the client.
 */
function kindForScopes(scopes: readonly string[]): ApiKeyKind {
  if (
    scopes.includes(SCOPES.contentWrite) ||
    scopes.includes(SCOPES.contentPublish) ||
    scopes.includes(SCOPES.contentManage) ||
    scopes.includes(SCOPES.spaceAdmin)
  ) {
    return 'cma';
  }
  if (scopes.includes(SCOPES.previewRead)) return 'cpa';
  return 'cda';
}

/**
 * Revokes an entire grant family: the code/device grant, every refresh token
 * descended from it, and every access token they minted.
 */
async function revokeGrantFamily(ctx: AppContext, familyId: string): Promise<void> {
  const descendants = await ctx.store.oauthGrants.listByParent(familyId);
  for (const record of descendants) {
    if (record.status !== 'revoked') {
      await ctx.store.oauthGrants.save({ ...record, status: 'revoked' });
    }
    for (const keyId of record.issuedKeyIds ?? []) {
      await ctx.store.auth.revoke(keyId).catch(() => {});
    }
    if (record.spaceId) await invalidateCachedPrincipals(ctx, record.spaceId);
  }
}

/**
 * RFC 7009 token revocation. Accepts either an access token or a refresh token
 * and always reports success — telling a caller that a token was already
 * unknown is an oracle, and the endpoint's contract is idempotent anyway.
 */
export async function revokeOAuthToken(
  ctx: AppContext,
  hasher: Hasher,
  token: string,
): Promise<void> {
  const hashed = hasher.hash(token);
  const refresh = await ctx.store.oauthGrants.findByHash('refresh', hashed);
  if (refresh) {
    await revokeGrantFamily(ctx, refresh.parentId ?? refresh.id);
    await ctx.store.oauthGrants.save({ ...refresh, status: 'revoked' });
    return;
  }
  const key = await ctx.store.auth.findByHash(hashed);
  if (key) {
    await ctx.store.auth.revoke(key.id).catch(() => {});
    await invalidateCachedPrincipals(ctx, key.spaceId);
  }
}

/** Drops grants that expired before `olderThan`. Runs from the worker's retention tick. */
export async function pruneExpiredOAuthGrants(ctx: AppContext, olderThan: Date): Promise<number> {
  return ctx.store.oauthGrants.deleteExpiredBefore(olderThan);
}

// ---------------------------------------------------------------------------
// Administration: connected apps and personal access tokens
// ---------------------------------------------------------------------------

/**
 * One application's access to a space, on one person's behalf — the unit an
 * admin actually reasons about. A single connection may sit behind several
 * access tokens (each refresh mints another), so tokens are folded together
 * rather than listed raw.
 */
export interface ConnectedApp {
  readonly clientId: string;
  readonly clientName: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly tokenCount: number;
  readonly lastUsedAt?: string;
  /** Expiry of the longest-lived access token still outstanding. */
  readonly expiresAt?: string;
}

/** Every application currently holding live access to `spaceId`. */
export async function listConnectedApps(ctx: AppContext, spaceId: string): Promise<ConnectedApp[]> {
  const now = ctx.clock.now().getTime();
  const live = (await ctx.store.auth.list(spaceId)).filter(
    (k) =>
      k.issuance === 'oauth' &&
      !k.revoked &&
      k.clientId &&
      k.subject &&
      (!k.expiresAt || new Date(k.expiresAt).getTime() > now),
  );

  const grouped = new Map<string, ConnectedApp>();
  for (const key of live) {
    const id = `${key.clientId}\u0000${key.subject}`;
    const existing = grouped.get(id);
    const later = (a?: string, b?: string) =>
      !a ? b : !b ? a : new Date(a).getTime() >= new Date(b).getTime() ? a : b;
    grouped.set(id, {
      clientId: key.clientId as string,
      clientName: existing?.clientName ?? (key.clientId as string),
      subject: key.subject as string,
      // Scopes can differ across tokens if a refresh narrowed them; show the
      // union, which is what the connection can currently do.
      scopes: [...new Set([...(existing?.scopes ?? []), ...key.scopes])],
      tokenCount: (existing?.tokenCount ?? 0) + 1,
      lastUsedAt: later(existing?.lastUsedAt, key.lastUsedAt),
      expiresAt: later(existing?.expiresAt, key.expiresAt),
    });
  }

  // Resolve display names once per distinct client, not once per token.
  const names = new Map<string, string>();
  for (const app of grouped.values()) {
    if (names.has(app.clientId)) continue;
    const client = await ctx.store.oauthClients.get(app.clientId);
    names.set(app.clientId, client?.clientName ?? app.clientId);
  }

  return [...grouped.values()]
    .map((app) => ({ ...app, clientName: names.get(app.clientId) ?? app.clientId }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

/**
 * Disconnects an application: revokes every access token it holds for this
 * person *and* every grant behind them.
 *
 * Both halves are required. Revoking only the access tokens leaves the refresh
 * token alive, and the client mints a replacement within the hour — the
 * disconnect would appear to work and silently not.
 */
export async function revokeConnectedApp(
  ctx: AppContext,
  spaceId: string,
  clientId: string,
  subject: string,
): Promise<{ revokedTokens: number }> {
  const keys = (await ctx.store.auth.list(spaceId)).filter(
    (k) => k.issuance === 'oauth' && k.clientId === clientId && k.subject === subject && !k.revoked,
  );
  for (const key of keys) await ctx.store.auth.revoke(key.id);

  for (const grant of await ctx.store.oauthGrants.listByClientAndSubject(clientId, subject)) {
    if (grant.spaceId !== spaceId) continue;
    if (grant.status === 'revoked') continue;
    await ctx.store.oauthGrants.save({ ...grant, status: 'revoked' });
  }
  await invalidateCachedPrincipals(ctx, spaceId);
  return { revokedTokens: keys.length };
}

/**
 * Ends every credential a person holds in the deployment: their OAuth access tokens and the grants
 * behind them (so no refresh mints a new one), their personal access tokens and setup-issued
 * credentials, in every space. Called when the web app disables, removes or re-secures a person;
 * their web sessions are the web app's to end. Idempotent.
 */
export async function revokeEverythingFor(
  ctx: AppContext,
  subject: string,
): Promise<{ revokedTokens: number; revokedGrants: number }> {
  let revokedTokens = 0;
  let revokedGrants = 0;
  const clientIds = new Set((await ctx.store.oauthClients.list()).map((c) => c.id));
  for (const space of await ctx.store.spaces.list()) {
    const keys = (await ctx.store.auth.list(space.spaceId)).filter(
      (k) =>
        k.subject === subject &&
        (k.issuance === 'oauth' || k.issuance === 'pat' || k.issuance === 'setup'),
    );
    for (const key of keys) {
      if (key.clientId) clientIds.add(key.clientId);
      if (key.revoked) continue;
      await ctx.store.auth.revoke(key.id);
      revokedTokens++;
    }
    if (keys.length) await invalidateCachedPrincipals(ctx, space.spaceId);
  }
  for (const clientId of clientIds) {
    for (const grant of await ctx.store.oauthGrants.listByClientAndSubject(clientId, subject)) {
      if (grant.status === 'revoked') continue;
      await ctx.store.oauthGrants.save({ ...grant, status: 'revoked' });
      revokedGrants++;
    }
  }
  return { revokedTokens, revokedGrants };
}

/** A personal access token as shown to an admin. */
export interface PersonalAccessToken {
  readonly id: string;
  readonly name?: string;
  readonly subject?: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** Personal access tokens issued in a space, newest-looking first. */
export async function listPersonalAccessTokens(
  ctx: AppContext,
  spaceId: string,
): Promise<PersonalAccessToken[]> {
  return (await ctx.store.auth.list(spaceId))
    .filter((k) => k.issuance === 'pat')
    .map((k) => ({
      id: k.id,
      name: k.name,
      subject: k.subject,
      scopes: k.scopes,
      revoked: k.revoked,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
    }));
}

// ---------------------------------------------------------------------------
// Personal access tokens
// ---------------------------------------------------------------------------

export interface CreatePatInput {
  readonly spaceId: string;
  readonly subject: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly roleId?: string;
  /** Days until expiry. Omit for a non-expiring token. */
  readonly expiresInDays?: number;
  /** The issuing human's scopes — a PAT can never exceed them. */
  readonly issuerScopes: readonly string[];
  /**
   * Who asks: refused when it is itself a delegated bearer (an OAuth or personal access token), so
   * a token can't mint another, perhaps never-expiring, one.
   */
  readonly issuer: KeyIssuer;
}

/**
 * Mints a long-lived personal access token. Same storage and authentication
 * path as an OAuth token; it simply skips the authorization dance, for CLI and
 * CI callers that cannot run a browser flow.
 */
export async function createPersonalAccessToken(
  ctx: AppContext,
  hasher: Hasher,
  input: CreatePatInput,
): Promise<{ id: string; token: string; expiresAt?: string }> {
  assertMayMintKeys(input.issuer);
  const scopes = input.scopes.filter((s) => input.issuerScopes.includes(s));
  if (scopes.length === 0) {
    throw new OAuthError('invalid_scope', 'A token cannot exceed your own permissions');
  }
  // A personal token is checked against its owner's team membership on every use, so it can
  // only be minted for an enabled member of this space.
  const owner = (await ctx.store.members.list(input.spaceId)).find(
    (m) => m.subject === input.subject && !m.disabled,
  );
  if (!owner) {
    throw new ForbiddenError(
      `Join space ${input.spaceId}'s team to create a personal access token`,
    );
  }
  const expiresAt = input.expiresInDays
    ? new Date(ctx.clock.now().getTime() + input.expiresInDays * 24 * 3600 * 1000).toISOString()
    : undefined;

  const { apiKey, token } = await createApiKey(ctx, hasher, {
    // Checked above, against the caller.
    issuer: 'system',
    spaceId: input.spaceId,
    kind: kindForScopes(scopes),
    name: input.name,
    scopes,
    roleId: input.roleId,
    expiresAt,
    issuance: 'pat',
    subject: input.subject,
  });
  return { id: apiKey.id, token, expiresAt };
}

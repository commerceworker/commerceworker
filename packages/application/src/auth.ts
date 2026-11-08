import {
  type ApiKey,
  type ApiKeyKind,
  DelegatedKeyMintError,
  isDelegatedBearer,
  NotFoundError,
  type Principal,
  scopesForKind,
  type TokenIssuance,
  UnauthorizedError,
  ValidationError,
} from '@commerceworker/domain';
import type { Hasher } from '@commerceworker/ports';
import type { AppContext } from './context';
import { invalidateCachedPrincipals, principalCacheTag } from './principal-cache';
import { type AccessPolicy, assertKeepsAnAdmin, NO_SSO, readAccessSettings } from './team';
import { randomSecret } from './token-crypto';

export interface CreateApiKeyInput {
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  /** Optional human-readable label. */
  readonly name?: string;
  /** Overrides the default scope set for the kind. */
  readonly scopes?: readonly string[];
  /**
   * Bind the key to a custom role (granular RBAC). The role's scopes and
   * content grants are resolved live on every request, superseding `scopes`.
   */
  readonly roleId?: string;
  /** ISO timestamp after which the key stops authenticating (optional). */
  readonly expiresAt?: string;
  /** How the token is being issued. Defaults to `key` (operator-minted). */
  readonly issuance?: TokenIssuance;
  /** The human this token acts for — makes the resolved principal a `user`. */
  readonly subject?: string;
  /** The OAuth client that obtained the token, when `issuance` is `oauth`. */
  readonly clientId?: string;
  /**
   * Who is minting it: the caller's principal (the routes and tools), or `system` for the flows
   * that mint delegated tokens themselves (an OAuth grant, a personal access token). Required, so
   * no caller skips the check by leaving it out. A delegated bearer is refused: see
   * {@link assertMayMintKeys}.
   */
  readonly issuer: KeyIssuer;
}

/**
 * Refuses a delegated bearer (an OAuth access token, a personal access token) minting or widening
 * an operator key, which never expires and acts for no one: a token a person handed to a program
 * must not turn itself into one that outlives it. A signed-in person, an operator key and the
 * admin token may.
 */
export function assertMayMintKeys(issuer: KeyIssuer): void {
  if (issuer !== 'system' && isDelegatedBearer(issuer)) throw new DelegatedKeyMintError();
}

/** Who mints or changes a key: a caller's principal, or the platform's own flows (`system`). */
export type KeyIssuer = Principal | 'system';

/** Token prefix by issuance, so operators can identify a token on sight. */
function tokenPrefix(issuance: TokenIssuance, kind: ApiKeyKind): string {
  switch (issuance) {
    case 'oauth':
      return `cwo_${kind}`;
    case 'pat':
      return `cwpat_${kind}`;
    case 'setup':
      return `cwsetup_${kind}`;
    case 'key':
      return `cwk_${kind}`;
  }
}

export interface CreatedApiKey {
  readonly apiKey: ApiKey;
  /** The raw token — shown ONCE; only its hash is stored. */
  readonly token: string;
}

/**
 * Mints an API key: generates a high-entropy token, stores only its hash, and
 * returns the raw token once. Token shape: `cwk_<kind>_<random>`.
 */
export async function createApiKey(
  ctx: AppContext,
  hasher: Hasher,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  assertMayMintKeys(input.issuer);
  if (!input.spaceId || input.spaceId === '*') {
    // Only the deployment's root tokens act across spaces; a stored key never does.
    throw new ValidationError([{ field: 'spaceId', message: 'A key belongs to one space' }]);
  }
  let roleScopes: readonly string[] | undefined;
  if (input.roleId) {
    const role = await ctx.store.roles.get(input.spaceId, input.roleId);
    if (!role) throw new NotFoundError('Role', input.roleId);
    roleScopes = role.scopes;
  }
  const issuance = input.issuance ?? 'key';
  const token = `${tokenPrefix(issuance, input.kind)}_${randomSecret()}`;
  const apiKey: ApiKey = {
    id: ctx.ids.newId(),
    spaceId: input.spaceId,
    kind: input.kind,
    name: input.name,
    hashedToken: hasher.hash(token),
    // For operator-minted keys the stored scopes are a display snapshot and the
    // role wins. For delegated tokens (OAuth/PAT) the consented scopes are the
    // authority and act as a *ceiling* — see `authenticate`, which intersects
    // them with the live role.
    scopes:
      issuance === 'key'
        ? (roleScopes ?? input.scopes ?? scopesForKind(input.kind))
        : (input.scopes ?? roleScopes ?? scopesForKind(input.kind)),
    revoked: false,
    roleId: input.roleId,
    expiresAt: input.expiresAt,
    issuance,
    subject: input.subject,
    clientId: input.clientId,
  };
  await ctx.store.auth.createApiKey(apiKey);
  return { apiKey, token };
}

/** How stale `lastUsedAt` may get before authentication refreshes it. */
export const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

/** Resolves a bearer token to a Principal, or throws UnauthorizedError. */
export async function authenticate(
  ctx: AppContext,
  hasher: Hasher,
  token: string | undefined,
): Promise<Principal> {
  if (!token) throw new UnauthorizedError();
  const key = await ctx.store.auth.findByHash(hasher.hash(token));
  if (!key) throw new UnauthorizedError();
  // Expired keys fail closed (e.g. an orphaned OIDC-delegated key whose session
  // lapsed). Checked here so both stores enforce it uniformly.
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= ctx.clock.now().getTime()) {
    throw new UnauthorizedError('API key has expired');
  }
  // Best-effort last-used tracking — must not block authentication, and throttled: written at
  // most once per LAST_USED_RESOLUTION_MS per key, so a busy delivery key costs no write on the
  // hot path (D1 has a single writer; a write per read would serialize the whole read load).
  const now = ctx.clock.now();
  if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) >= LAST_USED_RESOLUTION_MS) {
    void ctx.store.auth.touchLastUsed(key.id, now).catch(() => {});
  }
  // A setup-issued administrator credential is a person's sign-in, so it stops
  // working while the space requires SSO (a recovery code turns that off).
  if (key.issuance === 'setup' && (await readAccessSettings(ctx, key.spaceId)).ssoOnly) {
    throw new UnauthorizedError('This space requires single sign-on');
  }
  // A token minted for a human (OAuth grant, PAT, or setup) resolves to a `user`
  // principal so audit attributes the action to the person, not the key kind.
  const delegated = key.issuance === 'oauth' || key.issuance === 'pat' || key.issuance === 'setup';
  const identity = delegated
    ? {
        kind: 'user' as const,
        subject: key.subject,
        clientId: key.clientId,
        issuance: key.issuance as 'oauth' | 'pat' | 'setup',
      }
    : { kind: key.kind };

  if (delegated) {
    // A token a person holds is only as good as their place on the space's team, checked on every
    // use: disabled or removed → refused; re-roled → their current role, capped by the scopes they
    // consented to. So a person losing access loses every token at once, whatever minted it.
    const member = key.subject
      ? (await ctx.store.members.list(key.spaceId)).find((m) => m.subject === key.subject)
      : undefined;
    if (!member || member.disabled || !member.roleId) {
      throw new UnauthorizedError('The person this token acts for no longer has access');
    }
    const role = await ctx.store.roles.get(key.spaceId, member.roleId);
    if (!role) throw new UnauthorizedError('The person this token acts for no longer has access');
    return {
      spaceId: key.spaceId,
      ...identity,
      scopes: key.scopes.filter((s) => role.scopes.includes(s)),
      contentGrants: role.contentGrants,
    };
  }

  if (key.roleId) {
    // Role-bound key: the role is the live source of truth. A dangling
    // roleId (role deleted out-of-band) fails closed.
    const role = await ctx.store.roles.get(key.spaceId, key.roleId);
    if (!role) throw new UnauthorizedError('API key role no longer exists');
    // For delegated tokens the consented scope set is a ceiling: widening the
    // role must not retroactively widen a token a human approved for less.
    // Narrowing the role still takes effect immediately, in both directions.
    const scopes = delegated ? role.scopes.filter((s) => key.scopes.includes(s)) : role.scopes;
    return {
      spaceId: key.spaceId,
      ...identity,
      scopes,
      contentGrants: role.contentGrants,
    };
  }
  return { spaceId: key.spaceId, ...identity, scopes: key.scopes };
}

export async function listApiKeys(ctx: AppContext, spaceId: string): Promise<ApiKey[]> {
  return ctx.store.auth.list(spaceId);
}

/**
 * Revokes a key (by id) after verifying it belongs to the space. Refused with
 * `LastAdminError` when it is the space's last active administrator.
 */
export async function revokeApiKey(
  ctx: AppContext,
  spaceId: string,
  keyId: string,
  policy: AccessPolicy = NO_SSO,
): Promise<void> {
  const keys = await ctx.store.auth.list(spaceId);
  const key = keys.find((k) => k.id === keyId);
  if (!key) throw new NotFoundError('ApiKey', keyId);
  if (!key.revoked) {
    await assertKeepsAnAdmin(ctx, spaceId, policy, {
      keys: keys.map((k) => (k.id === keyId ? { ...k, revoked: true } : k)),
    });
  }
  await ctx.store.auth.revoke(keyId);
  await invalidateCachedPrincipals(ctx, spaceId);
}

/** How long a resolved principal may be served from cache. */
export const PRINCIPAL_CACHE_TTL_SECONDS = 60;

/**
 * {@link authenticate} behind `ctx.cache`, for read paths that authenticate on every request
 * (the delivery gateway): a cache hit costs no database read. Entries are keyed by the token's
 * peppered hash (the token itself is never a cache key) and tagged per space, so revoking a key,
 * re-roling it, or editing a role drops every cached principal of that space at once
 * ({@link invalidateCachedPrincipals}). The TTL bounds anything an invalidation could miss.
 * Failures are not cached: an attacker cycling bad tokens must keep paying the limiter.
 */
export async function authenticateCached(
  ctx: AppContext,
  hasher: Hasher,
  token: string | undefined,
): Promise<Principal> {
  if (!token || !ctx.cache) return authenticate(ctx, hasher, token);
  const key = `principal:${hasher.hash(token)}`;
  const hit = await ctx.cache.get(key).catch(() => null);
  if (hit) {
    const cached = JSON.parse(hit) as { principal: Principal; expiresAt?: number };
    if (!cached.expiresAt || cached.expiresAt > ctx.clock.now().getTime()) return cached.principal;
  }
  const principal = await authenticate(ctx, hasher, token);
  const stored = await ctx.store.auth.findByHash(hasher.hash(token));
  const expiresAt = stored?.expiresAt ? Date.parse(stored.expiresAt) : undefined;
  await ctx.cache
    .set(key, JSON.stringify({ principal, ...(expiresAt ? { expiresAt } : {}) }), {
      ttlSeconds: PRINCIPAL_CACHE_TTL_SECONDS,
      tags: [principalCacheTag(principal.spaceId)],
    })
    .catch(() => {});
  return principal;
}

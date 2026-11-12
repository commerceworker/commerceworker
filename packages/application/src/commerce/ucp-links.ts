/**
 * Identity linking: a UCP platform links a signed-in shopper's address through OAuth (the rules in
 * core's `ucp/identity-linking.ts`). The authorization request is checked, the shopper consents,
 * and that mints a one-time code (a minute, stored as a hash); the platform, authenticated with
 * its API key, redeems it with its PKCE verifier for an opaque access token and a rotating refresh
 * token. Every token belongs to one link, to one platform: a refresh token presented by another
 * platform, or spent twice, ends the link, and an access token presented by another platform
 * reads nothing. A code used twice ends the link its first use started (RFC 6749 §4.1.2). Scopes
 * only narrow, never widen. Time comes in as `now`; every refusal is the RFC's own error.
 */
import {
  hashLinkSecret,
  joinLinkScopes,
  LINK_ACCESS_TTL_S,
  LINK_CODE_TTL_MS,
  LINK_GRANT_TTL_MS,
  LINK_REFRESH_TTL_MS,
  LINK_RETENTION_MS,
  LINK_SCOPES,
  LINK_SECRET,
  type LinkAuthorizeView,
  type LinkDecision,
  type LinkError,
  type LinkRefusal,
  type LinkScope,
  type LinkTokenResult,
  linkRedirectProblem,
  linkScopes,
  newLinkSecret,
  PKCE_CHALLENGE,
  pkceMatches,
  type ShopperLink,
  splitLinkScopes,
  UCP_PATH,
} from '@commerceworker/core';
import type { UcpLinks, UcpPlatform, UcpStore } from '@commerceworker/ports/commerce';

export type LinkPorts = {
  readonly links: UcpLinks;
  readonly platforms: Pick<UcpStore, 'livePlatform' | 'livePlatformById'>;
  /** The storefront's origin: the issuer, and what a redirect names as `iss` (RFC 9207). */
  readonly issuer: string;
};

/** The longest `state` a platform may send: it is only ever echoed. */
const STATE_MAX = 512;

type Request = {
  platform: UcpPlatform;
  redirectUri: string;
  scopes: LinkScope[];
  challenge: string;
  state: string | null;
};

const refused = (
  error: LinkError,
  description: string,
  redirect: string | null = null,
): LinkRefusal => ({ status: 'refused', error, description, redirect });

/** `redirectUri` with the response's parameters, keeping any query the platform's address has. */
function back(
  ports: LinkPorts,
  redirectUri: string,
  state: string | null,
  p: Record<string, string>,
) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
  if (state !== null) url.searchParams.set('state', state);
  url.searchParams.set('iss', ports.issuer);
  return url.href;
}

/**
 * An authorization request, checked in the order RFC 6749 §4.1.2.1 asks: a client or return
 * address that can't be trusted is shown, never redirected to; any other fault goes back to the
 * platform at its return address. Nothing is written.
 */
async function checked(
  ports: LinkPorts,
  params: Record<string, string>,
): Promise<{ request: Request } | LinkRefusal> {
  const clientId = params.client_id;
  const platform =
    typeof clientId === 'string' && clientId
      ? await ports.platforms.livePlatformById(clientId)
      : undefined;
  // A revoked platform and one that never was look the same.
  if (!platform)
    return refused('invalid_request', 'This link request is from an unknown platform.');
  const redirectUri = params.redirect_uri;
  if (typeof redirectUri !== 'string' || !redirectUri)
    return refused('invalid_request', 'The request names no redirect_uri.');
  const problem = linkRedirectProblem(redirectUri, platform.redirectUris);
  if (problem) return refused('invalid_request', problem);

  const state = typeof params.state === 'string' ? params.state : null;
  const fail = (error: LinkError, description: string) =>
    refused(
      error,
      description,
      back(ports, redirectUri, state, { error, error_description: description }),
    );
  if (state !== null && state.length > STATE_MAX)
    return fail('invalid_request', 'The state is too long.');
  if (params.response_type !== 'code')
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = params.code_challenge;
  if (
    params.code_challenge_method !== 'S256' ||
    typeof challenge !== 'string' ||
    !PKCE_CHALLENGE.test(challenge)
  )
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  const scopes = linkScopes(params.scope);
  if (!scopes) return fail('invalid_scope', 'Ask for scopes this business offers.');
  if (params.resource !== undefined && params.resource !== `${ports.issuer}${UCP_PATH}`)
    return fail('invalid_target', 'The resource is not this business’s UCP endpoint.');
  return { request: { platform, redirectUri, scopes, challenge, state } };
}

/**
 * What the consent page shows for a request, given who is signed in (`email`, or null): the
 * platform, the shopper's own address and each scope in words. Nothing is written, so a GET can ask.
 */
export async function describeLink(
  ports: LinkPorts,
  params: Record<string, string>,
  email: string | null,
): Promise<LinkAuthorizeView> {
  const c = await checked(ports, params);
  if ('status' in c) return c;
  const { request } = c;
  if (!email) return { status: 'sign_in', platform: request.platform.name };
  return {
    status: 'consent',
    platform: request.platform.name,
    email,
    scopes: request.scopes.map((scope) => ({ scope, description: LINK_SCOPES[scope] })),
    redirectUri: request.redirectUri,
  };
}

/**
 * The shopper's answer. The request is checked again (the page's form carries it back, which is
 * the shopper's browser's word, not ours). A denial goes back as `access_denied`; an approval
 * stores a one-time code under its hash for the platform to redeem.
 */
export async function decideLink(
  ports: LinkPorts,
  params: Record<string, string>,
  approve: boolean,
  email: string | null,
  now: number,
): Promise<LinkDecision> {
  const c = await checked(ports, params);
  if ('status' in c) return c;
  const { request } = c;
  if (!email) return { status: 'sign_in', platform: request.platform.name };
  if (!approve)
    return {
      status: 'redirect',
      redirect: back(ports, request.redirectUri, request.state, {
        error: 'access_denied',
        error_description: 'The shopper declined.',
      }),
    };
  const code = newLinkSecret('code');
  await ports.links.issueCode({
    codeHash: await hashLinkSecret(code),
    grantId: `lg_${crypto.randomUUID().replaceAll('-', '')}`,
    platformId: request.platform.id,
    email,
    scope: joinLinkScopes(request.scopes),
    redirectUri: request.redirectUri,
    challenge: request.challenge,
    createdAt: now,
    expiresAt: now + LINK_CODE_TTL_MS,
  });
  return {
    status: 'redirect',
    redirect: back(ports, request.redirectUri, request.state, { code }),
  };
}

// ── The token endpoint ────────────────────────────────────────────────────

/** What a platform presented to authenticate: the id it names and the SHA-256 of its API key. */
export type LinkClient = { id: string | null; keyHash: string | null };

const oauthError = (status: number, error: LinkError, description: string): LinkTokenResult => ({
  status,
  body: { error, error_description: description },
});
const invalidGrant = (description: string) => oauthError(400, 'invalid_grant', description);

/** The platform a client authenticated as (its key is live, and the id it named is its own), or null. */
async function authenticated(ports: LinkPorts, client: LinkClient): Promise<UcpPlatform | null> {
  if (!client.keyHash) return null;
  const platform = await ports.platforms.livePlatform(client.keyHash);
  if (!platform || (client.id !== null && client.id !== platform.id)) return null;
  return platform;
}

const invalidClient = () =>
  oauthError(401, 'invalid_client', 'Authenticate with the platform’s client id and API key.');

/** Mints the tokens a link's holder presents, within the link's own end. */
async function issue(grantId: string, grantEnd: number, scope: string, now: number) {
  const access = newLinkSecret('access');
  const refresh = newLinkSecret('refresh');
  const accessEnd = Math.min(now + LINK_ACCESS_TTL_S * 1000, grantEnd);
  const tokens = [
    {
      tokenHash: await hashLinkSecret(access),
      grantId,
      kind: 'access' as const,
      scope,
      createdAt: now,
      expiresAt: accessEnd,
    },
    {
      tokenHash: await hashLinkSecret(refresh),
      grantId,
      kind: 'refresh' as const,
      scope,
      createdAt: now,
      expiresAt: Math.min(now + LINK_REFRESH_TTL_MS, grantEnd),
    },
  ];
  const response: LinkTokenResult = {
    status: 200,
    body: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor((accessEnd - now) / 1000),
      refresh_token: refresh,
      scope,
    },
  };
  return { tokens, response };
}

async function exchangeCode(
  ports: LinkPorts,
  platform: UcpPlatform,
  form: Record<string, string>,
  now: number,
): Promise<LinkTokenResult> {
  const { code, code_verifier: verifier, redirect_uri: redirectUri } = form;
  if (typeof code !== 'string' || !LINK_SECRET.code.test(code))
    return invalidGrant('The code is not valid.');
  const codeHash = await hashLinkSecret(code);
  const spent = await ports.links.spendCode(codeHash, now);
  if (!spent) return invalidGrant('The code is not valid.');
  if (spent.kind === 'replayed') {
    // A code used twice: whoever got tokens from the first use loses them (RFC 6749 §4.1.2).
    await ports.links.revokeGrant(spent.grantId, now);
    return invalidGrant('The code was already used.');
  }
  const c = spent.code;
  // The code is spent whatever follows, so a wrong guess can't be retried against it.
  if (c.platformId !== platform.id) return invalidGrant('The code was issued to another client.');
  if (redirectUri !== c.redirectUri)
    return invalidGrant('The redirect_uri differs from the request’s.');
  if (typeof verifier !== 'string' || !(await pkceMatches(verifier, c.challenge)))
    return invalidGrant('The code_verifier does not match.');
  const grantEnd = now + LINK_GRANT_TTL_MS;
  const { tokens, response } = await issue(c.grantId, grantEnd, c.scope, now);
  const created = await ports.links.createGrant(
    {
      id: c.grantId,
      platformId: c.platformId,
      email: c.email,
      scope: c.scope,
      createdAt: now,
      expiresAt: grantEnd,
      revokedAt: null,
    },
    tokens,
    now,
    codeHash,
  );
  // A replay got in between spending the code and this write: it marked the code, so nothing was made.
  if (!created) return invalidGrant('The code was already used.');
  return response;
}

async function refreshTokens(
  ports: LinkPorts,
  platform: UcpPlatform,
  form: Record<string, string>,
  now: number,
): Promise<LinkTokenResult> {
  const given = form.refresh_token;
  if (typeof given !== 'string' || !LINK_SECRET.refresh.test(given))
    return invalidGrant('The refresh token is not valid.');
  const hash = await hashLinkSecret(given);
  const row = await ports.links.refresh(hash);
  if (!row) return invalidGrant('The refresh token is not valid.');
  const { grant } = row;
  if (grant.platformId !== platform.id) {
    // Another platform holds this token: it has leaked, so the link ends.
    await ports.links.revokeGrant(grant.id, now);
    return invalidGrant('The refresh token was issued to another client.');
  }
  if (row.spent) {
    // A spent token presented again: it was copied, and which holder is the thief is unknowable.
    await ports.links.revokeGrant(grant.id, now);
    return invalidGrant('The refresh token was already used.');
  }
  if (grant.revokedAt !== null || grant.expiresAt <= now || row.expiresAt <= now)
    return invalidGrant('The refresh token has expired or was revoked.');
  // A refresh may ask for less than the link holds, never more (RFC 6749 §6).
  let scope = row.scope;
  if (form.scope !== undefined) {
    const asked = linkScopes(form.scope);
    const held = new Set(splitLinkScopes(row.scope));
    if (!asked || !asked.every((s) => held.has(s)))
      return oauthError(400, 'invalid_scope', 'The scope exceeds what was granted.');
    scope = joinLinkScopes(asked);
  }
  const { tokens, response } = await issue(grant.id, grant.expiresAt, scope, now);
  const rotated = await ports.links.rotate(hash, tokens, now);
  if (rotated === 'rotated') return response;
  if (rotated === 'reused') await ports.links.revokeGrant(grant.id, now);
  return invalidGrant('The refresh token is not valid.');
}

/** The token endpoint (RFC 6749 §3.2): the platform authenticates, then redeems a code or refreshes. */
export async function linkToken(
  ports: LinkPorts,
  form: Record<string, string>,
  client: LinkClient,
  now: number,
): Promise<LinkTokenResult> {
  const platform = await authenticated(ports, client);
  if (!platform) return invalidClient();
  if (form.grant_type === 'authorization_code') return exchangeCode(ports, platform, form, now);
  if (form.grant_type === 'refresh_token') return refreshTokens(ports, platform, form, now);
  return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

/**
 * Revocation (RFC 7009): the platform ends the link a token of its own belongs to, either kind.
 * The answer is 200 for any token, so it can't be used to find out which exist; a token of
 * another platform's is left alone.
 */
export async function revokeLinkToken(
  ports: LinkPorts,
  form: Record<string, string>,
  client: LinkClient,
  now: number,
): Promise<LinkTokenResult> {
  const platform = await authenticated(ports, client);
  if (!platform) return invalidClient();
  const token = form.token;
  if (
    typeof token === 'string' &&
    (LINK_SECRET.access.test(token) || LINK_SECRET.refresh.test(token))
  ) {
    const grant = await ports.links.grantOfToken(await hashLinkSecret(token));
    if (grant && grant.platformId === platform.id) await ports.links.revokeGrant(grant.id, now);
  }
  return { status: 200, body: {} };
}

// ── Using a token ─────────────────────────────────────────────────────────

/**
 * The shopper an access token speaks for, for `platformId` and `scope`: the address and the link,
 * or null for a token that is unknown, expired, revoked, issued to another platform or without the
 * scope. All of those look the same to the caller.
 */
export async function linkedShopper(
  ports: Pick<LinkPorts, 'links'>,
  token: unknown,
  platformId: string,
  scope: LinkScope,
  now: number,
): Promise<{ email: string; grantId: string } | null> {
  if (typeof token !== 'string' || !LINK_SECRET.access.test(token)) return null;
  const row = await ports.links.access(await hashLinkSecret(token), now);
  if (!row || row.grant.platformId !== platformId) return null;
  if (!splitLinkScopes(row.scope).includes(scope)) return null;
  return { email: row.grant.email, grantId: row.grant.id };
}

// ── What the shopper sees ─────────────────────────────────────────────────

export async function shopperLinks(
  ports: Pick<LinkPorts, 'links'>,
  email: string,
  now: number,
): Promise<ShopperLink[]> {
  return (await ports.links.forShopper(email, now)).map((l) => ({
    id: l.id,
    platform: l.platformName,
    scopes: splitLinkScopes(l.scope),
    since: l.createdAt,
    expiresAt: l.expiresAt,
  }));
}

export const unlinkShopper = (
  ports: Pick<LinkPorts, 'links'>,
  email: string,
  linkId: string,
  now: number,
) => ports.links.revokeForShopper(email, linkId, now);

/**
 * Deletes codes a day after they expired (kept that long so a replay still ends its link), links
 * a month after they ended with their tokens, and from live links the access tokens that expired and
 * the refresh tokens spent over a day ago but each link's latest, so a long-lived link's rows don't
 * pile up with every refresh.
 */
export const pruneUcpLinks = (ports: Pick<LinkPorts, 'links'>, now: number) =>
  ports.links.prune({
    codes: now - 86_400_000,
    grants: now - LINK_RETENTION_MS,
    // An expired access token is useless; a spent refresh token is kept a day, and its link's latest.
    tokens: now,
    spent: now - 86_400_000,
  });

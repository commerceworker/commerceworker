import { OAuthError, SCOPES } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approveAuthorization,
  authenticate,
  createApiKey,
  createPersonalAccessToken,
  decideDeviceAuthorization,
  defaultOAuthConfig,
  exchangeAuthorizationCode,
  exchangeDeviceCode,
  lookupDeviceGrant,
  type OAuthApproval,
  type OAuthConfig,
  pruneExpiredOAuthGrants,
  refreshAccessToken,
  registerOAuthClient,
  revokeOAuthToken,
  sha256Base64Url,
  startDeviceAuthorization,
  validateAuthorizationRequest,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };

const ISSUER = 'https://cms.example.com';
const RESOURCE = 'https://cms.example.com/mcp';

let clock: FixedClock;

/**
 * Delegated tokens are re-checked against the space's team on every use, so every person these
 * tests approve as is a member of s1: most with a full-scope role, `u@example.com` with the
 * `r1` role the ceiling tests edit. (`nobody@example.com` is deliberately not on the team.)
 */
function ctx(): AppContext {
  clock = new FixedClock();
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  void store.roles.save({
    id: 'r-full',
    spaceId: 's1',
    name: 'admin',
    scopes: [...fullApproval.approverScopes],
  });
  const at = clock.now().toISOString();
  for (const [subject, roleId] of [
    ['user@example.com', 'r-full'],
    ['limited@example.com', 'r-full'],
    ['me@example.com', 'r-full'],
    ['u@example.com', 'r1'],
  ] as const) {
    void store.members.save({
      id: `m-${subject}`,
      spaceId: 's1',
      email: subject,
      subject,
      roleId,
      disabled: false,
      createdAt: at,
      updatedAt: at,
    });
  }
  return { store, clock, ids: new SequenceIdGenerator('o') };
}

function config(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return { ...defaultOAuthConfig(ISSUER, RESOURCE), ...overrides };
}

/** A real PKCE pair — verifyPkce uses the actual S256 digest, not the test hasher. */
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = sha256Base64Url(VERIFIER);

/** An approver holding the full CMA scope set. */
const fullApproval: OAuthApproval = {
  spaceId: 's1',
  subject: 'user@example.com',
  approverScopes: [
    SCOPES.contentWrite,
    SCOPES.contentPublish,
    SCOPES.contentManage,
    SCOPES.deliveryRead,
    SCOPES.previewRead,
    SCOPES.searchRead,
    SCOPES.spaceAdmin,
  ],
};

/** A public client registered for the read scopes unless `scope` says otherwise. */
async function publicClient(
  c: AppContext,
  cfg = config(),
  scope = `${SCOPES.deliveryRead} ${SCOPES.previewRead} ${SCOPES.searchRead}`,
) {
  const { client } = await registerOAuthClient(c, hasher, cfg, {
    clientName: 'Test MCP Client',
    redirectUris: ['https://client.example.com/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
    scope,
  });
  return client;
}

/** Drives validate → approve → exchange, returning the token response. */
async function fullCodeFlow(
  c: AppContext,
  cfg: OAuthConfig,
  clientId: string,
  approval: OAuthApproval = fullApproval,
  scope?: string,
) {
  const request = await validateAuthorizationRequest(c, cfg, {
    clientId,
    redirectUri: 'https://client.example.com/callback',
    scope,
    state: 'xyz',
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    resource: RESOURCE,
  });
  const { code } = await approveAuthorization(c, hasher, cfg, request, approval);
  return exchangeAuthorizationCode(c, hasher, cfg, {
    clientId,
    code,
    redirectUri: 'https://client.example.com/callback',
    codeVerifier: VERIFIER,
    resource: RESOURCE,
  });
}

describe('OAuth: dynamic client registration', () => {
  let c: AppContext;
  beforeEach(() => {
    c = ctx();
  });

  it('registers a public client with no secret, allowed anything under the registration ceiling', async () => {
    const { client, clientSecret } = await registerOAuthClient(c, hasher, config(), {
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(clientSecret).toBeUndefined();
    expect(client.hashedClientSecret).toBeUndefined();
    expect(client.tokenEndpointAuthMethod).toBe('none');
    expect(client.grantTypes).toEqual(['authorization_code']);
    // MCP clients commonly register without scopes and choose them when authorizing; the person
    // approving still sees each one, and the token is capped by their role.
    expect(client.scopes).toEqual(config().maxClientScopes);
    expect(client.scopes).toContain(SCOPES.contentWrite);
    expect(client.scopes).not.toContain(SCOPES.spaceAdmin);
    expect(client.scopes).not.toContain(SCOPES.contentManage);
  });

  it('returns a confidential client secret once and stores only its hash', async () => {
    const { client, clientSecret } = await registerOAuthClient(c, hasher, config(), {
      clientName: 'Server App',
      redirectUris: ['https://app.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(clientSecret).toBeTruthy();
    expect(client.hashedClientSecret).toBe(hasher.hash(clientSecret as string));
    expect(client.hashedClientSecret).not.toBe(clientSecret);
  });

  it('refuses scopes beyond the anonymous-registration ceiling', async () => {
    // An unauthenticated client must not be able to put "administer this space"
    // in front of a human as a single approve button.
    await expect(
      registerOAuthClient(c, hasher, config(), {
        clientName: 'Sneaky',
        redirectUris: ['https://x.example.com/cb'],
        scope: `${SCOPES.deliveryRead} ${SCOPES.spaceAdmin}`,
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });

  it('rejects redirect URIs that are not https, loopback, or private-use', async () => {
    for (const uri of ['http://evil.example.com/cb', 'ftp://x/cb', 'not-a-uri']) {
      await expect(
        registerOAuthClient(c, hasher, config(), { clientName: 'X', redirectUris: [uri] }),
      ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
    }
  });

  it('accepts loopback http and private-use schemes for native clients', async () => {
    const { client } = await registerOAuthClient(c, hasher, config(), {
      clientName: 'CLI',
      redirectUris: ['http://127.0.0.1:0/callback', 'com.example.app:/done'],
    });
    expect(client.redirectUris).toHaveLength(2);
  });

  it('rejects a redirect URI carrying a fragment', async () => {
    await expect(
      registerOAuthClient(c, hasher, config(), {
        clientName: 'X',
        redirectUris: ['https://x.example.com/cb#frag'],
      }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('requires a redirect URI for the authorization_code grant', async () => {
    await expect(
      registerOAuthClient(c, hasher, config(), { clientName: 'X', redirectUris: [] }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rejects unsupported grant and response types', async () => {
    await expect(
      registerOAuthClient(c, hasher, config(), {
        clientName: 'X',
        redirectUris: ['https://x.example.com/cb'],
        grantTypes: ['password'],
      }),
    ).rejects.toMatchObject({ error: 'invalid_client_metadata' });

    await expect(
      registerOAuthClient(c, hasher, config(), {
        clientName: 'X',
        redirectUris: ['https://x.example.com/cb'],
        responseTypes: ['token'],
      }),
    ).rejects.toMatchObject({ error: 'invalid_client_metadata' });
  });
});

describe('OAuth: authorization request validation', () => {
  let c: AppContext;
  let clientId: string;
  beforeEach(async () => {
    c = ctx();
    clientId = (await publicClient(c)).id;
  });

  it('requires PKCE and refuses the plain method', async () => {
    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toMatchObject({ error: 'invalid_request' });

    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'plain',
      }),
    ).rejects.toMatchObject({ error: 'invalid_request' });
  });

  it('rejects a redirect URI that is not registered', async () => {
    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://attacker.example.com/callback',
        codeChallenge: CHALLENGE,
      }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rejects a redirect URI that merely shares a prefix', async () => {
    // Prefix matching is the classic open-redirect hole; OAuth 2.1 requires
    // exact comparison.
    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://client.example.com/callback.attacker.com',
        codeChallenge: CHALLENGE,
      }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('ignores only the port for loopback redirects', async () => {
    const c2 = ctx();
    const { client } = await registerOAuthClient(c2, hasher, config(), {
      clientName: 'CLI',
      redirectUris: ['http://127.0.0.1:1234/cb'],
    });
    // A native client binds an ephemeral port it could not know at registration.
    const ok = await validateAuthorizationRequest(c2, config(), {
      clientId: client.id,
      redirectUri: 'http://127.0.0.1:54321/cb',
      codeChallenge: CHALLENGE,
    });
    expect(ok.redirectUri).toBe('http://127.0.0.1:54321/cb');

    // The path still has to match.
    await expect(
      validateAuthorizationRequest(c2, config(), {
        clientId: client.id,
        redirectUri: 'http://127.0.0.1:54321/other',
        codeChallenge: CHALLENGE,
      }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rejects an unknown client and a mismatched resource', async () => {
    await expect(
      validateAuthorizationRequest(c, config(), { clientId: 'nope', codeChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ error: 'invalid_client' });

    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: CHALLENGE,
        resource: 'https://elsewhere.example.com/mcp',
      }),
    ).rejects.toMatchObject({ error: 'invalid_request' });
  });

  it('rejects a scope the client did not register for', async () => {
    await expect(
      validateAuthorizationRequest(c, config(), {
        clientId,
        redirectUri: 'https://client.example.com/callback',
        codeChallenge: CHALLENGE,
        scope: SCOPES.contentWrite,
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });
});

describe('OAuth: authorization code flow', () => {
  let c: AppContext;
  let cfg: OAuthConfig;
  let clientId: string;
  beforeEach(async () => {
    c = ctx();
    cfg = config();
    clientId = (await publicClient(c, cfg)).id;
  });

  it('issues an access token that authenticates as the approving human', async () => {
    const tokens = await fullCodeFlow(c, cfg, clientId);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(cfg.accessTokenTtlSeconds);
    expect(tokens.access_token.startsWith('cwo_')).toBe(true);
    expect(tokens.refresh_token).toBeTruthy();

    const principal = await authenticate(c, hasher, tokens.access_token);
    expect(principal.kind).toBe('user');
    expect(principal.subject).toBe('user@example.com');
    expect(principal.clientId).toBe(clientId);
    expect(principal.spaceId).toBe('s1');
    expect(principal.scopes).toEqual([SCOPES.deliveryRead, SCOPES.previewRead, SCOPES.searchRead]);
  });

  it('carries the state parameter back on the redirect', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      state: 'xyz',
      codeChallenge: CHALLENGE,
    });
    const { redirectTo } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    expect(redirectTo).toContain('state=xyz');
    expect(redirectTo).toContain('code=cwc_');
  });

  it('narrows the grant to what the approving human actually holds', async () => {
    // The client asked for read+preview+search; this approver holds only
    // delivery:read, so that is all the token may carry.
    const tokens = await fullCodeFlow(c, cfg, clientId, {
      spaceId: 's1',
      subject: 'limited@example.com',
      approverScopes: [SCOPES.deliveryRead],
    });
    expect(tokens.scope).toBe(SCOPES.deliveryRead);
    const principal = await authenticate(c, hasher, tokens.access_token);
    expect(principal.scopes).toEqual([SCOPES.deliveryRead]);
  });

  it('refuses to approve when the human holds none of the requested scopes', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    await expect(
      approveAuthorization(c, hasher, cfg, request, {
        spaceId: 's1',
        subject: 'nobody@example.com',
        approverScopes: [SCOPES.spaceAdmin],
      }),
    ).rejects.toMatchObject({ error: 'access_denied' });
  });

  it('rejects a bad PKCE verifier', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, {
        clientId,
        code,
        redirectUri: 'https://client.example.com/callback',
        codeVerifier: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a malformed code_verifier without consulting the digest', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, { clientId, code, codeVerifier: 'short' }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a redirect_uri that differs from the authorized one', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, {
        clientId,
        code,
        redirectUri: 'https://client.example.com/other',
        codeVerifier: VERIFIER,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a code presented by a different client', async () => {
    const other = await registerOAuthClient(c, hasher, cfg, {
      clientName: 'Other',
      redirectUris: ['https://other.example.com/cb'],
    });
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, {
        clientId: other.client.id,
        code,
        codeVerifier: VERIFIER,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('expires an unredeemed code', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    clock.advance((cfg.authorizationCodeTtlSeconds + 1) * 1000);
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, { clientId, code, codeVerifier: VERIFIER }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('replaying a consumed code revokes every token issued from it', async () => {
    const request = await validateAuthorizationRequest(c, cfg, {
      clientId,
      redirectUri: 'https://client.example.com/callback',
      codeChallenge: CHALLENGE,
    });
    const { code } = await approveAuthorization(c, hasher, cfg, request, fullApproval);
    const tokens = await exchangeAuthorizationCode(c, hasher, cfg, {
      clientId,
      code,
      codeVerifier: VERIFIER,
    });
    // First redemption works.
    await expect(authenticate(c, hasher, tokens.access_token)).resolves.toBeTruthy();

    // The replay is refused...
    await expect(
      exchangeAuthorizationCode(c, hasher, cfg, { clientId, code, codeVerifier: VERIFIER }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });

    // ...and burns the whole family, on the assumption the code leaked.
    await expect(authenticate(c, hasher, tokens.access_token)).rejects.toBeInstanceOf(Error);
    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId,
        refreshToken: tokens.refresh_token as string,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });
});

describe('OAuth: refresh', () => {
  let c: AppContext;
  let cfg: OAuthConfig;
  let clientId: string;
  beforeEach(async () => {
    c = ctx();
    cfg = config();
    clientId = (await publicClient(c, cfg)).id;
  });

  it('rotates the refresh token and keeps the scope set', async () => {
    const first = await fullCodeFlow(c, cfg, clientId);
    const second = await refreshAccessToken(c, hasher, cfg, {
      clientId,
      refreshToken: first.refresh_token as string,
    });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe(first.scope);
    await expect(authenticate(c, hasher, second.access_token)).resolves.toMatchObject({
      kind: 'user',
    });
  });

  it('reusing a rotated refresh token revokes the family', async () => {
    const first = await fullCodeFlow(c, cfg, clientId);
    const second = await refreshAccessToken(c, hasher, cfg, {
      clientId,
      refreshToken: first.refresh_token as string,
    });
    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId,
        refreshToken: first.refresh_token as string,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    // The token minted by the legitimate rotation is burned too — we cannot tell
    // which party is the attacker, so both lose access.
    await expect(authenticate(c, hasher, second.access_token)).rejects.toBeInstanceOf(Error);
  });

  it('may narrow scope on refresh but never widen it', async () => {
    const first = await fullCodeFlow(c, cfg, clientId);
    const narrowed = await refreshAccessToken(c, hasher, cfg, {
      clientId,
      refreshToken: first.refresh_token as string,
      scope: SCOPES.deliveryRead,
    });
    expect(narrowed.scope).toBe(SCOPES.deliveryRead);

    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId,
        refreshToken: narrowed.refresh_token as string,
        scope: `${SCOPES.deliveryRead} ${SCOPES.contentWrite}`,
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });

  it('rejects a refresh token presented by another client', async () => {
    const first = await fullCodeFlow(c, cfg, clientId);
    const other = await registerOAuthClient(c, hasher, cfg, {
      clientName: 'Other',
      redirectUris: ['https://other.example.com/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId: other.client.id,
        refreshToken: first.refresh_token as string,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });
});

describe('OAuth: device authorization flow', () => {
  let c: AppContext;
  let cfg: OAuthConfig;
  let clientId: string;

  beforeEach(async () => {
    c = ctx();
    cfg = config();
    const { client } = await registerOAuthClient(c, hasher, cfg, {
      clientName: 'commerceworker CLI',
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    });
    clientId = client.id;
  });

  it('issues a user code the human can retype, and completes on approval', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, { clientId });
    expect(started.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(started.verification_uri).toBe(`${ISSUER}/oauth/device`);
    expect(started.interval).toBe(cfg.devicePollIntervalSeconds);

    // Polling before approval is the normal case, not an error condition.
    await expect(
      exchangeDeviceCode(c, hasher, cfg, { clientId, deviceCode: started.device_code }),
    ).rejects.toMatchObject({ error: 'authorization_pending' });

    await decideDeviceAuthorization(c, hasher, started.user_code, 'approve', fullApproval);
    const tokens = await exchangeDeviceCode(c, hasher, cfg, {
      clientId,
      deviceCode: started.device_code,
    });
    const principal = await authenticate(c, hasher, tokens.access_token);
    expect(principal.subject).toBe('user@example.com');
  });

  it('forgives user-code formatting when the human retypes it', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, { clientId });
    const mangled = started.user_code.toLowerCase().replace('-', ' ');
    const found = await lookupDeviceGrant(c, hasher, mangled);
    expect(found.client.id).toBe(clientId);
  });

  it('reports denial to the polling device', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, { clientId });
    await decideDeviceAuthorization(c, hasher, started.user_code, 'deny', fullApproval);
    await expect(
      exchangeDeviceCode(c, hasher, cfg, { clientId, deviceCode: started.device_code }),
    ).rejects.toMatchObject({ error: 'access_denied' });
  });

  it('expires a device code that nobody approved', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, { clientId });
    clock.advance((cfg.deviceCodeTtlSeconds + 1) * 1000);
    await expect(
      exchangeDeviceCode(c, hasher, cfg, { clientId, deviceCode: started.device_code }),
    ).rejects.toMatchObject({ error: 'expired_token' });
    await expect(lookupDeviceGrant(c, hasher, started.user_code)).rejects.toMatchObject({
      error: 'expired_token',
    });
  });

  it('cannot redeem the same device code twice', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, { clientId });
    await decideDeviceAuthorization(c, hasher, started.user_code, 'approve', fullApproval);
    await exchangeDeviceCode(c, hasher, cfg, { clientId, deviceCode: started.device_code });
    await expect(
      exchangeDeviceCode(c, hasher, cfg, { clientId, deviceCode: started.device_code }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a device grant to a client that did not register for it', async () => {
    const codeOnly = await publicClient(c, cfg);
    await expect(
      startDeviceAuthorization(c, hasher, cfg, { clientId: codeOnly.id }),
    ).rejects.toMatchObject({ error: 'unauthorized_client' });
  });

  it('rejects a user code that was never issued', async () => {
    await expect(lookupDeviceGrant(c, hasher, 'BCDF-GHJK')).rejects.toMatchObject({
      error: 'invalid_grant',
    });
  });
});

describe('OAuth: revocation and retention', () => {
  let c: AppContext;
  let cfg: OAuthConfig;
  let clientId: string;
  beforeEach(async () => {
    c = ctx();
    cfg = config();
    clientId = (await publicClient(c, cfg)).id;
  });

  it('revoking a refresh token kills the access token too', async () => {
    const tokens = await fullCodeFlow(c, cfg, clientId);
    await revokeOAuthToken(c, hasher, tokens.refresh_token as string);
    await expect(authenticate(c, hasher, tokens.access_token)).rejects.toBeInstanceOf(Error);
    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId,
        refreshToken: tokens.refresh_token as string,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('revoking an access token leaves the refresh token usable', async () => {
    const tokens = await fullCodeFlow(c, cfg, clientId);
    await revokeOAuthToken(c, hasher, tokens.access_token);
    await expect(authenticate(c, hasher, tokens.access_token)).rejects.toBeInstanceOf(Error);
    await expect(
      refreshAccessToken(c, hasher, cfg, {
        clientId,
        refreshToken: tokens.refresh_token as string,
      }),
    ).resolves.toBeTruthy();
  });

  it('is idempotent and silent for an unknown token', async () => {
    await expect(revokeOAuthToken(c, hasher, 'never-issued')).resolves.toBeUndefined();
  });

  it('prunes only grants that expired before the cutoff', async () => {
    const started = await startDeviceAuthorization(c, hasher, cfg, {
      clientId: (
        await registerOAuthClient(c, hasher, cfg, {
          clientName: 'CLI',
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
        })
      ).client.id,
    });
    expect(await pruneExpiredOAuthGrants(c, clock.now())).toBe(0);
    clock.advance((cfg.deviceCodeTtlSeconds + 60) * 1000);
    expect(await pruneExpiredOAuthGrants(c, clock.now())).toBeGreaterThan(0);
    await expect(lookupDeviceGrant(c, hasher, started.user_code)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
  });
});

describe('OAuth: personal access tokens', () => {
  it('mints a PAT that authenticates as its owner', async () => {
    const c = ctx();
    const { token } = await createPersonalAccessToken(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      subject: 'me@example.com',
      name: 'ci',
      scopes: [SCOPES.deliveryRead, SCOPES.contentWrite],
      issuerScopes: [SCOPES.deliveryRead, SCOPES.contentWrite, SCOPES.spaceAdmin],
    });
    expect(token.startsWith('cwpat_')).toBe(true);
    const principal = await authenticate(c, hasher, token);
    expect(principal.kind).toBe('user');
    expect(principal.subject).toBe('me@example.com');
    expect(principal.scopes).toEqual([SCOPES.deliveryRead, SCOPES.contentWrite]);
  });

  it('silently drops scopes the issuer does not hold', async () => {
    const c = ctx();
    const { token } = await createPersonalAccessToken(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      subject: 'me@example.com',
      name: 'ci',
      scopes: [SCOPES.deliveryRead, SCOPES.spaceAdmin],
      issuerScopes: [SCOPES.deliveryRead],
    });
    const principal = await authenticate(c, hasher, token);
    expect(principal.scopes).toEqual([SCOPES.deliveryRead]);
  });

  it('refuses a token that would hold nothing', async () => {
    const c = ctx();
    await expect(
      createPersonalAccessToken(c, hasher, {
        issuer: 'system',
        spaceId: 's1',
        subject: 'me@example.com',
        name: 'ci',
        scopes: [SCOPES.spaceAdmin],
        issuerScopes: [SCOPES.deliveryRead],
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('expires when asked to', async () => {
    const c = ctx();
    const { token } = await createPersonalAccessToken(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      subject: 'me@example.com',
      name: 'ci',
      scopes: [SCOPES.deliveryRead],
      issuerScopes: [SCOPES.deliveryRead],
      expiresInDays: 7,
    });
    await expect(authenticate(c, hasher, token)).resolves.toBeTruthy();
    clock.advance(8 * 24 * 3600 * 1000);
    await expect(authenticate(c, hasher, token)).rejects.toBeInstanceOf(Error);
  });
});

describe('OAuth: delegated tokens treat consented scopes as a ceiling', () => {
  it('widening the role does not widen an already-issued OAuth token', async () => {
    const c = ctx();
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    const cfg = config();
    const clientId = (await publicClient(c, cfg)).id;
    const tokens = await fullCodeFlow(c, cfg, clientId, {
      spaceId: 's1',
      subject: 'u@example.com',
      roleId: 'r1',
      approverScopes: [SCOPES.deliveryRead],
    });
    expect((await authenticate(c, hasher, tokens.access_token)).scopes).toEqual([
      SCOPES.deliveryRead,
    ]);

    // The role gains publish rights; the token the human approved must not.
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead, SCOPES.contentPublish],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'publish'] }],
    });
    const principal = await authenticate(c, hasher, tokens.access_token);
    expect(principal.scopes).toEqual([SCOPES.deliveryRead]);
    // Content grants still resolve live — only the coarse scopes are capped.
    expect(principal.contentGrants?.[0]?.actions).toEqual(['read', 'publish']);
  });

  it('narrowing the role still narrows an issued token immediately', async () => {
    const c = ctx();
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead, SCOPES.previewRead],
      contentGrants: [],
    });
    const cfg = config();
    const clientId = (await publicClient(c, cfg)).id;
    const tokens = await fullCodeFlow(c, cfg, clientId, {
      spaceId: 's1',
      subject: 'u@example.com',
      roleId: 'r1',
      approverScopes: [SCOPES.deliveryRead, SCOPES.previewRead],
    });
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead],
      contentGrants: [],
    });
    expect((await authenticate(c, hasher, tokens.access_token)).scopes).toEqual([
      SCOPES.deliveryRead,
    ]);
  });

  it('leaves operator-minted role-bound keys resolving the live role', async () => {
    // The ceiling applies to delegated tokens only — an operator key must keep
    // picking up role changes in both directions.
    const c = ctx();
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead],
      contentGrants: [],
    });
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: 'r1',
    });
    await c.store.roles.save({
      id: 'r1',
      spaceId: 's1',
      name: 'editor',
      scopes: [SCOPES.deliveryRead, SCOPES.contentPublish],
      contentGrants: [],
    });
    expect((await authenticate(c, hasher, token)).scopes).toEqual([
      SCOPES.deliveryRead,
      SCOPES.contentPublish,
    ]);
  });
});

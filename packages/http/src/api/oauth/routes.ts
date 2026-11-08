import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  approveAuthorization,
  decideDeviceAuthorization,
  defaultOAuthConfig,
  denyAuthorization,
  exchangeAuthorizationCode,
  exchangeDeviceCode,
  lookupDeviceGrant,
  memberAccess,
  type OAuthApproval,
  type OAuthConfig,
  refreshAccessToken,
  registerOAuthClient,
  revokeOAuthToken,
  spacesForWebUser,
  startDeviceAuthorization,
  validateAuthorizationRequest,
  type WebUser,
} from '@commerceworker/application';
import {
  authorizationServerMetadata,
  type OAuthClient,
  OAuthError,
  protectedResourceMetadata,
  resourceMetadataPaths,
} from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  verifyPrincipal,
} from '@commerceworker/security/principal';
import { logger } from '@commerceworker/telemetry';
import { type Context, Hono } from 'hono';
import type { AuthDeps } from '../auth';

/**
 * OAuth 2.1 authorization server + RFC 9728 protected-resource metadata.
 *
 * Mounted unauthenticated: these *are* the authentication endpoints. Everything
 * that grants authority still passes through a person: `/authorize` and `/device` are served on
 * the admin's origin (the web Worker's gateway forwards `/oauth/*`) and require the signed
 * `x-cw-principal` it adds for a signed-in person; the scopes a grant receives are capped by what
 * that person holds in the space they pick.
 *
 * Wire formats live here rather than in `validation.ts` because they are fixed
 * by the RFCs (form-encoded token requests, snake_case JSON) and shared with
 * nothing else in the API.
 */

/** True when this deployment runs an authorization server. */
export function oauthEnabled(config: ApiConfig): boolean {
  return !!config.oauthIssuer;
}

export function oauthConfigFrom(config: ApiConfig): OAuthConfig {
  const issuer = (config.oauthIssuer ?? '').replace(/\/$/, '');
  const defaults = defaultOAuthConfig(issuer, config.oauthResource ?? `${issuer}/mcp`);
  return {
    ...defaults,
    accessTokenTtlSeconds: config.oauthAccessTokenTtlSeconds || defaults.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauthRefreshTokenTtlSeconds || defaults.refreshTokenTtlSeconds,
  };
}

// --- rendering helpers ------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escapes untrusted text. Client names come from anonymous registration. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

const SCOPE_LABELS: Record<string, string> = {
  'content:write': 'Create and edit content',
  'content:publish': 'Publish and unpublish content',
  'content:manage': 'Change content types',
  'delivery:read': 'Read published content',
  'preview:read': 'Read drafts and unpublished content',
  'search:read': 'Search content',
  'space:admin': 'Administer the space, including API keys',
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --bg:#fff; --line:#e5e5e5; --accent:#1a1a1a; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f0f0f0; --muted:#9a9a9a; --bg:#141414; --line:#2c2c2c; --accent:#f0f0f0; }
  }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
  .card { width: 100%; max-width: 420px; border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p.sub { color: var(--muted); margin: 0 0 20px; }
  ul { list-style: none; padding: 0; margin: 0 0 24px; }
  li { padding: 9px 0; border-bottom: 1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  .row { display: flex; gap: 10px; }
  button, input { font: inherit; }
  button { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line);
           background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  input[type=text] { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
                     background: transparent; color: var(--fg); box-sizing: border-box; margin-bottom: 16px;
                     font-family: ui-monospace, monospace; letter-spacing: 2px; text-transform: uppercase; }
  .err { color: #c0392b; margin: 0 0 16px; }
</style></head><body><div class="card">${body}</div></body></html>`;
}

function scopeList(scopes: readonly string[]): string {
  return `<ul>${scopes.map((s) => `<li>${esc(SCOPE_LABELS[s] ?? s)}</li>`).join('')}</ul>`;
}

// --- errors -----------------------------------------------------------------

/**
 * OAuth pins its own error envelope (`{error, error_description}`) and specific
 * status codes, so these routes format errors themselves instead of falling
 * through to the API's generic DomainError mapping.
 */
function oauthErrorResponse(c: Context, err: unknown) {
  if (err instanceof OAuthError) {
    return c.json(
      { error: err.error, error_description: err.errorDescription },
      // biome-ignore lint/suspicious/noExplicitAny: hono status code typing
      err.status as any,
    );
  }
  logger.error({ err }, 'oauth: unhandled error');
  return c.json({ error: 'server_error' }, 500);
}

async function guard(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return oauthErrorResponse(c, err);
  }
}

// --- consent binding --------------------------------------------------------

/** How long a rendered consent form stays valid. */
const CONSENT_TTL_S = 10 * 60;

/**
 * Binds a rendered consent form to the person it was rendered for, the exact parameters they saw,
 * and when: `<issued at, s>.<HMAC>`. A form can't be replayed for someone else or with other
 * parameters, and it expires after CONSENT_TTL_S (the person starts again from the application).
 */
function consentSignature(
  secret: string,
  subject: string,
  params: string[],
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const mac = createHmac('sha256', secret)
    .update([String(iat), subject, ...params].join(' '))
    .digest('base64url');
  return `${iat}.${mac}`;
}

function consentSignatureValid(
  secret: string,
  subject: string,
  params: string[],
  presented: string,
  nowMs = Date.now(),
): boolean {
  const [iatText, mac] = presented.split('.');
  const iat = Number(iatText);
  const now = Math.floor(nowMs / 1000);
  if (!mac || !Number.isInteger(iat) || iat > now + 5 || now - iat > CONSENT_TTL_S) return false;
  const expected = createHmac('sha256', secret)
    .update([String(iat), subject, ...params].join(' '))
    .digest('base64url');
  try {
    return (
      expected.length === mac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
    );
  } catch {
    return false;
  }
}

// --- signed-in person → approval -------------------------------------------

/** The person the web Worker vouches for on this request, or null when none (or invalid). */
async function webUserOf(deps: AuthDeps, c: Context): Promise<WebUser | null> {
  if (!deps.webPrincipalKeys?.length) return null;
  const user = await verifyPrincipal(
    deps.webPrincipalKeys,
    c.req.header(PRINCIPAL_HEADER),
    principalTarget(c.req.method, new URL(c.req.url).pathname),
  );
  return user
    ? { sub: user.sub, email: user.email, role: user.role === 'admin' ? 'admin' : 'member' }
    : null;
}

/**
 * The ceiling for a grant approved by `user` in `spaceId`: their team role is bound to the issued
 * token (so its permissions keep resolving live), and their scopes cap what the grant may carry.
 * Null when they may not act in that space.
 */
async function approvalFor(
  deps: AuthDeps,
  user: WebUser,
  spaceId: string,
): Promise<OAuthApproval | null> {
  try {
    const access = await memberAccess(deps.ctx, spaceId, user);
    return {
      spaceId,
      subject: user.sub,
      roleId: access.roleId,
      approverScopes: access.scopes,
    };
  } catch {
    return null;
  }
}

/** Sends a signed-out person to the admin's sign-in, then back to exactly this request. */
function toSignIn(c: Context): Response {
  const back = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(back.pathname + back.search)}`);
}

/** A space picker over the spaces the person can approve in (preselecting `selected`). */
function spacePicker(spaces: readonly string[], selected?: string): string {
  if (spaces.length === 1) {
    return `<input type="hidden" name="space" value="${esc(spaces[0] as string)}">`;
  }
  const options = spaces
    .map((s) => `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(s)}</option>`)
    .join('');
  return `<label class="sub" for="space">Space</label>
<select id="space" name="space">${options}</select>`;
}

// --- routes -----------------------------------------------------------------

export function oauthRoutes(deps: AuthDeps, config: ApiConfig): Hono {
  const app = new Hono();
  const cfg = oauthConfigFrom(config);
  const { ctx, hasher } = deps;

  // Signs consent forms: the first PRINCIPAL_KEY (the web Worker's shared key), with a domain
  // label so a consent signature can never pass for a principal envelope; the session secret only
  // where no key is set (local and test wiring).
  const consentKey = `oauth-consent:${config.principalKeys[0] ?? config.sessionSecret}`;

  // -- discovery -------------------------------------------------------------

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(authorizationServerMetadata(cfg.issuer)),
  );

  // Served at both the RFC 9728 path-suffixed URL (`/.well-known/…/mcp`) and the
  // bare well-known path, because MCP clients in the wild probe either one.
  for (const path of resourceMetadataPaths(cfg.resource)) {
    app.get(path, (c) => c.json(protectedResourceMetadata(cfg.resource, cfg.issuer)));
  }

  // -- dynamic client registration (RFC 7591) --------------------------------

  app.post('/oauth/register', async (c) =>
    guard(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const { client, clientSecret } = await registerOAuthClient(ctx, hasher, cfg, {
        clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
        redirectUris: Array.isArray(body.redirect_uris)
          ? (body.redirect_uris as string[])
          : undefined,
        grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as string[]) : undefined,
        responseTypes: Array.isArray(body.response_types)
          ? (body.response_types as string[])
          : undefined,
        tokenEndpointAuthMethod:
          typeof body.token_endpoint_auth_method === 'string'
            ? body.token_endpoint_auth_method
            : undefined,
        scope: typeof body.scope === 'string' ? body.scope : undefined,
        clientUri: typeof body.client_uri === 'string' ? body.client_uri : undefined,
        logoUri: typeof body.logo_uri === 'string' ? body.logo_uri : undefined,
        softwareId: typeof body.software_id === 'string' ? body.software_id : undefined,
      });
      logger.info({ clientId: client.id, name: client.clientName }, 'oauth: client registered');
      return c.json(
        {
          client_id: client.id,
          client_secret: clientSecret,
          client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          grant_types: client.grantTypes,
          response_types: ['code'],
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          scope: client.scopes.join(' '),
        },
        201,
      );
    }),
  );

  // -- authorization ---------------------------------------------------------

  /** Reads an authorization request from the query string. */
  const authRequestFrom = (c: Context) => ({
    clientId: c.req.query('client_id'),
    redirectUri: c.req.query('redirect_uri'),
    responseType: c.req.query('response_type'),
    scope: c.req.query('scope'),
    state: c.req.query('state'),
    codeChallenge: c.req.query('code_challenge'),
    codeChallengeMethod: c.req.query('code_challenge_method'),
    resource: c.req.query('resource'),
  });

  app.get('/oauth/authorize', async (c) =>
    guard(c, async () => {
      // Validate BEFORE trusting redirect_uri. Errors below this line may be
      // redirected to the client; errors above it must never be, or the
      // endpoint becomes an open redirect.
      const request = await validateAuthorizationRequest(ctx, cfg, authRequestFrom(c));

      const current = await webUserOf(deps, c);
      if (!current) return toSignIn(c);
      const spaces = await spacesForWebUser(ctx, current, { membersOnly: true });
      if (spaces.length === 0) {
        return c.html(
          page(
            'No space to connect',
            '<h1>No space to connect</h1><p class="sub">Applications act as you on a space\'s team, and you are not on any. Ask an administrator to add you, then retry the connection from the application.</p>',
          ),
          403,
        );
      }

      const params = [
        request.client.id,
        request.redirectUri,
        request.scopes.join(' '),
        request.codeChallenge,
        request.state ?? '',
        request.resource ?? '',
      ];
      const sig = consentSignature(consentKey, current.sub, params);
      const hidden = [
        ['client_id', params[0]],
        ['redirect_uri', params[1]],
        ['scope', params[2]],
        ['code_challenge', params[3]],
        ['state', params[4]],
        ['resource', params[5]],
        ['consent', sig],
      ]
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${esc(k as string)}" value="${esc(v as string)}">`,
        )
        .join('');

      return c.html(
        page(
          'Authorize application',
          `<h1>${esc(request.client.clientName)}</h1>
<p class="sub">wants to act as ${esc(current.email || current.sub)}</p>
${scopeList(request.scopes)}
<form method="post" action="/oauth/authorize">${hidden}
  ${spacePicker(spaces, c.req.query('space'))}
  <div class="row">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="approve" class="primary">Approve</button>
  </div>
</form>`,
        ),
      );
    }),
  );

  app.post('/oauth/authorize', async (c) =>
    guard(c, async () => {
      const form = await c.req.parseBody();
      const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined);

      const current = await webUserOf(deps, c);
      if (!current) throw new OAuthError('access_denied', 'Your session has expired', 401);

      const params = [
        str('client_id') ?? '',
        str('redirect_uri') ?? '',
        str('scope') ?? '',
        str('code_challenge') ?? '',
        str('state') ?? '',
        str('resource') ?? '',
      ];
      if (!consentSignatureValid(consentKey, current.sub, params, str('consent') ?? '')) {
        throw new OAuthError('invalid_request', 'This form is no longer valid. Start again.');
      }

      // Re-validate rather than trusting the round-tripped form: the client
      // could have been deleted, or its registration changed, since render.
      const request = await validateAuthorizationRequest(ctx, cfg, {
        clientId: params[0],
        redirectUri: params[1],
        scope: params[2],
        codeChallenge: params[3],
        state: params[4] || undefined,
        resource: params[5] || undefined,
      });

      if (str('decision') !== 'approve') return c.redirect(denyAuthorization(request));

      const approval = await approvalFor(deps, current, str('space') ?? '');
      if (!approval) throw new OAuthError('access_denied', 'You cannot connect that space', 403);
      const { redirectTo, grantedScopes } = await approveAuthorization(
        ctx,
        hasher,
        cfg,
        request,
        approval,
      );
      logger.info(
        {
          clientId: request.client.id,
          subject: current.sub,
          space: approval.spaceId,
          scopes: grantedScopes,
        },
        'oauth: authorization granted',
      );
      return c.redirect(redirectTo);
    }),
  );

  // -- device authorization (RFC 8628) ---------------------------------------

  app.post('/oauth/device_authorization', async (c) =>
    guard(c, async () => {
      const form = await c.req.parseBody();
      const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined);
      const started = await startDeviceAuthorization(ctx, hasher, cfg, {
        clientId: str('client_id'),
        scope: str('scope'),
        resource: str('resource'),
      });
      return c.json(started);
    }),
  );

  const deviceForm = (userCode: string, error?: string) =>
    page(
      'Connect a device',
      `<h1>Connect a device</h1>
<p class="sub">Enter the code shown on your device.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/device">
  <input type="text" name="user_code" value="${esc(userCode)}" placeholder="XXXX-XXXX" autocomplete="off" autofocus>
  <div class="row"><button type="submit" name="decision" value="approve" class="primary">Continue</button></div>
</form>`,
    );

  app.get('/oauth/device', async (c) => {
    const current = await webUserOf(deps, c);
    if (!current) return toSignIn(c);
    const userCode = c.req.query('user_code') ?? '';
    // With a code in hand, show what is actually being approved rather than
    // making the human confirm an opaque string.
    if (userCode) {
      try {
        const { grant, client } = await lookupDeviceGrant(ctx, hasher, userCode);
        const sig = consentSignature(consentKey, current.sub, [userCode]);
        return c.html(
          page(
            'Connect a device',
            `<h1>${esc(client.clientName)}</h1>
<p class="sub">is asking to connect as ${esc(current.email || current.sub)}</p>
${scopeList(grant.scopes)}
<form method="post" action="/oauth/device">
  <input type="hidden" name="user_code" value="${esc(userCode)}">
  ${spacePicker(await spacesForWebUser(ctx, current, { membersOnly: true }), c.req.query('space'))}
  <input type="hidden" name="consent" value="${esc(sig)}">
  <div class="row">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="approve" class="primary">Approve</button>
  </div>
</form>`,
          ),
        );
      } catch (err) {
        return c.html(
          deviceForm('', err instanceof OAuthError ? err.message : 'That code is not valid.'),
          400,
        );
      }
    }
    return c.html(deviceForm(''));
  });

  app.post('/oauth/device', async (c) => {
    const current = await webUserOf(deps, c);
    if (!current) return c.html(deviceForm('', 'Your session has expired.'), 401);
    const form = await c.req.parseBody();
    const userCode = typeof form.user_code === 'string' ? form.user_code : '';
    const decision = form.decision === 'deny' ? 'deny' : 'approve';
    const presented = typeof form.consent === 'string' ? form.consent : '';

    // The first POST (from the bare code-entry form) carries no signature; it
    // only re-renders the confirmation screen, so no authority is granted yet.
    if (!presented) {
      return c.redirect(`/oauth/device?user_code=${encodeURIComponent(userCode)}`);
    }
    if (!consentSignatureValid(consentKey, current.sub, [userCode], presented)) {
      return c.html(deviceForm('', 'This form is no longer valid. Start again.'), 400);
    }

    try {
      const space = typeof form.space === 'string' ? form.space : '';
      const approval = await approvalFor(deps, current, space);
      if (!approval) return c.html(deviceForm('', 'You cannot connect that space.'), 403);
      await decideDeviceAuthorization(ctx, hasher, userCode, decision, approval);
      return c.html(
        page(
          decision === 'approve' ? 'Device connected' : 'Request denied',
          decision === 'approve'
            ? '<h1>You&rsquo;re all set</h1><p class="sub">Return to your device — it will continue automatically.</p>'
            : '<h1>Request denied</h1><p class="sub">Nothing was shared with the application.</p>',
        ),
      );
    } catch (err) {
      return c.html(
        deviceForm(userCode, err instanceof OAuthError ? err.message : 'That code is not valid.'),
        400,
      );
    }
  });

  // -- token -----------------------------------------------------------------

  /** Client credentials may arrive in the body or via HTTP Basic (RFC 6749 §2.3.1). */
  function clientCredentials(
    c: Context,
    form: Record<string, unknown>,
  ): { clientId?: string; clientSecret?: string } {
    const header = c.req.header('authorization') ?? '';
    if (/^Basic\s+/i.test(header)) {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, idx)),
          clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
        };
      }
    }
    return {
      clientId: typeof form.client_id === 'string' ? form.client_id : undefined,
      clientSecret: typeof form.client_secret === 'string' ? form.client_secret : undefined,
    };
  }

  app.post('/oauth/token', async (c) =>
    guard(c, async () => {
      const form = (await c.req.parseBody()) as Record<string, unknown>;
      const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined);
      const { clientId, clientSecret } = clientCredentials(c, form);
      // Token responses must never be cached (RFC 6749 §5.1).
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      switch (str('grant_type')) {
        case 'authorization_code':
          return c.json(
            await exchangeAuthorizationCode(ctx, hasher, cfg, {
              clientId,
              clientSecret,
              code: str('code'),
              redirectUri: str('redirect_uri'),
              codeVerifier: str('code_verifier'),
              resource: str('resource'),
            }),
          );
        case 'refresh_token':
          return c.json(
            await refreshAccessToken(ctx, hasher, cfg, {
              clientId,
              clientSecret,
              refreshToken: str('refresh_token'),
              scope: str('scope'),
              resource: str('resource'),
            }),
          );
        case 'urn:ietf:params:oauth:grant-type:device_code':
          return c.json(
            await exchangeDeviceCode(ctx, hasher, cfg, {
              clientId,
              clientSecret,
              deviceCode: str('device_code'),
            }),
          );
        default:
          throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type');
      }
    }),
  );

  // -- revocation (RFC 7009) -------------------------------------------------

  app.post('/oauth/revoke', async (c) =>
    guard(c, async () => {
      const form = (await c.req.parseBody()) as Record<string, unknown>;
      const token = typeof form.token === 'string' ? form.token : '';
      // Always 200: reporting whether a token existed would be an oracle, and
      // the endpoint is defined as idempotent regardless.
      if (token) await revokeOAuthToken(ctx, hasher, token);
      return c.body(null, 200);
    }),
  );

  return app;
}

export type { OAuthClient };

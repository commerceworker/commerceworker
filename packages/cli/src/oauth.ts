import type { Io } from './io.js';
import { isSecureUrl, stripControl } from './origin.js';
import { CliError, EXIT } from './output.js';

/**
 * The OAuth device flow (RFC 8628) against a deployment's authorization server, the same one MCP
 * clients use. The api serves the metadata; its endpoints live on the admin origin, where a person
 * signs in and approves the code. The token is a space-bound key capped by that person's role.
 */

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/**
 * The pre-registered first-party public client every commerce deployment knows ("Official
 * CommerceWorker CLI" on its approval page). Commerce signs in as this client, with no
 * registration; content deployments still register one.
 */
export const FIRST_PARTY_CLIENT_ID = 'commerceworker-cli';
/** A refresh holds the credentials lock, so its requests give up well inside the lock's stale window. */
export const REFRESH_TIMEOUT_MS = 10_000;
/**
 * What a content deployment's registration is told this client is called. Not "CommerceWorker CLI":
 * the server refuses a registration that passes itself off as the first-party client.
 */
export const CLIENT_NAME = 'command-line client';

export interface ServerMetadata {
  readonly issuer: string;
  readonly token_endpoint: string;
  /** RFC 7591; a server without it takes a fixed public client id. */
  readonly registration_endpoint?: string;
  readonly device_authorization_endpoint: string;
  readonly revocation_endpoint?: string;
  /** The commerce authorization server's built-in client for this CLI: no registration needed. */
  readonly commerceworker_cli_client_id?: string;
  readonly scopes_supported?: readonly string[];
}

export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

const form = (values: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values).toString(),
});

async function oauthError(res: Response): Promise<{ error: string; description?: string }> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  };
  return {
    error: stripControl(String(body.error ?? `http_${res.status}`)),
    description:
      body.error_description === undefined
        ? undefined
        : stripControl(String(body.error_description)),
  };
}

/**
 * Fetches the RFC 8414 metadata. With `issuer` set, the document must name that origin as its
 * issuer (RFC 8414 §3.3): metadata that names another is refused, so a deployment can't send the
 * CLI to endpoints it doesn't speak for.
 */
export async function discover(
  io: Pick<Io, 'fetch'>,
  url: string,
  expectIssuer?: string,
  signal?: AbortSignal,
): Promise<ServerMetadata> {
  let res: Response;
  try {
    res = await io.fetch(`${url}/.well-known/oauth-authorization-server`, signal ? { signal } : {});
  } catch (err) {
    throw new CliError(
      `Can't reach ${url}: ${stripControl((err as Error).message)}`,
      EXIT.failure,
      'unreachable',
    );
  }
  if (res.status === 404) {
    throw new CliError(
      `${url} has no OAuth sign-in. Create a Management key in the admin (Settings → API keys), ` +
        'then run `commerceworker login --url <url> --token <key>` or set COMMERCEWORKER_TOKEN.',
      EXIT.auth,
      'oauth_unavailable',
    );
  }
  if (!res.ok) {
    throw new CliError(`OAuth discovery failed: ${res.status}`, EXIT.failure, 'discovery_failed');
  }
  const meta = (await res.json()) as ServerMetadata;
  if (expectIssuer !== undefined) assertIssuer(meta, expectIssuer);
  return meta;
}

/**
 * Whether the server is a commerce deployment: it is its own issuer (the admin origin) and its
 * scopes are roles. A content deployment may be its own issuer too, on one host, but its scopes
 * are `content:*`.
 */
export const isCommerceMetadata = (meta: ServerMetadata, origin: string): boolean =>
  meta.issuer === origin &&
  (meta.scopes_supported ?? []).some((s) => ['viewer', 'approver', 'operator'].includes(s));

/**
 * RFC 8414 §3.3, and for a commerce deployment more: every endpoint it names is on the issuer's
 * own origin and https, so nothing the CLI sends (a device code, a refresh token) goes elsewhere.
 */
export function assertIssuer(meta: ServerMetadata, origin: string): void {
  if (meta.issuer !== origin) {
    throw new CliError(
      `${origin} names ${stripControl(String(meta.issuer))} as its issuer, not itself; refusing to sign in (RFC 8414 §3.3).`,
      EXIT.auth,
      'issuer_mismatch',
    );
  }
  for (const key of [
    'token_endpoint',
    'device_authorization_endpoint',
    'registration_endpoint',
    'revocation_endpoint',
  ] as const) {
    const value = meta[key];
    if (value === undefined) continue;
    let ok = false;
    try {
      const url = new URL(value);
      ok = url.origin === origin && isSecureUrl(url);
    } catch {
      // not a URL
    }
    if (!ok) {
      throw new CliError(
        `${origin}'s ${key} (${stripControl(String(value))}) is not on ${origin} over https; refusing to sign in.`,
        EXIT.auth,
        'endpoint_mismatch',
      );
    }
  }
}

/** Registers this CLI as a public device-flow client (no secret, no redirect). */
export async function registerClient(io: Pick<Io, 'fetch'>, meta: ServerMetadata): Promise<string> {
  if (!meta.registration_endpoint) {
    throw new CliError('The server offers no client registration.', EXIT.auth, 'oauth_unavailable');
  }
  const res = await io.fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const { error, description } = await oauthError(res);
    throw new CliError(`Client registration failed: ${description ?? error}`, EXIT.auth, error);
  }
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function startDevice(
  io: Pick<Io, 'fetch'>,
  meta: ServerMetadata,
  clientId: string,
  scope?: string,
  /** RFC 8707: the API the token is for. */
  resource?: string,
): Promise<DeviceAuthorization> {
  const res = await io.fetch(
    meta.device_authorization_endpoint,
    form({
      client_id: clientId,
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
    }),
  );
  if (!res.ok) {
    const { error, description } = await oauthError(res);
    // A client registered on an earlier login may have been deleted since: the caller registers
    // a new one and starts again.
    throw new CliError(`Device authorization failed: ${description ?? error}`, EXIT.auth, error);
  }
  return (await res.json()) as DeviceAuthorization;
}

/**
 * Polls the token endpoint until the person approves, denies, or the code expires. Waits
 * `interval` seconds between polls (5 if the server names none) and five more on each
 * `slow_down`, as RFC 8628 §3.5 asks.
 */
export async function pollForToken(
  io: Pick<Io, 'fetch' | 'now' | 'sleep'>,
  meta: ServerMetadata,
  clientId: string,
  device: DeviceAuthorization,
  resource?: string,
): Promise<TokenResponse> {
  let interval = Math.max(1, device.interval ?? 5);
  const deadline = io.now() + device.expires_in * 1000;
  for (;;) {
    await io.sleep(interval * 1000);
    const res = await io.fetch(
      meta.token_endpoint,
      form({
        grant_type: DEVICE_GRANT,
        client_id: clientId,
        device_code: device.device_code,
        ...(resource ? { resource } : {}),
      }),
    );
    if (res.ok) return (await res.json()) as TokenResponse;
    const { error, description } = await oauthError(res);
    switch (error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5;
        break;
      case 'access_denied':
        throw new CliError('Sign-in was denied.', EXIT.auth, error);
      case 'expired_token':
        throw new CliError(
          'The code expired before it was approved. Run login again.',
          EXIT.auth,
          error,
        );
      default:
        throw new CliError(`Sign-in failed: ${description ?? error}`, EXIT.auth, error);
    }
    if (io.now() >= deadline) {
      throw new CliError(
        'The code expired before it was approved. Run login again.',
        EXIT.auth,
        'expired_token',
      );
    }
  }
}

export async function refresh(
  io: Pick<Io, 'fetch'>,
  meta: ServerMetadata,
  clientId: string,
  refreshToken: string,
  /** RFC 8707: sent on a commerce refresh, as on the grant. */
  resource?: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const res = await io.fetch(meta.token_endpoint, {
    ...form({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      ...(resource ? { resource } : {}),
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const { error } = await oauthError(res);
    throw new CliError(
      'Your session has expired. Run `commerceworker login` again.',
      EXIT.auth,
      error,
    );
  }
  return (await res.json()) as TokenResponse;
}

/** Best effort: always 200 by RFC 7009, and logging out locally doesn't depend on it. */
export async function revoke(
  io: Pick<Io, 'fetch'>,
  meta: ServerMetadata,
  clientId: string | undefined,
  token: string,
  hint?: 'refresh_token' | 'access_token',
): Promise<boolean> {
  if (!meta.revocation_endpoint) return false;
  try {
    const res = await io.fetch(
      meta.revocation_endpoint,
      form({
        token,
        ...(hint ? { token_type_hint: hint } : {}),
        ...(clientId ? { client_id: clientId } : {}),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

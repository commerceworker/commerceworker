import type { Io } from './io.js';
import { CliError, EXIT } from './output.js';

/**
 * The OAuth device flow (RFC 8628) against a deployment's authorization server, the same one MCP
 * clients use. The api serves the metadata; its endpoints live on the admin origin, where a person
 * signs in and approves the code. The token is a space-bound key capped by that person's role.
 */

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const CLIENT_NAME = 'commerceworker CLI';

export interface ServerMetadata {
  readonly issuer: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly device_authorization_endpoint: string;
  readonly revocation_endpoint?: string;
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
  return { error: body.error ?? `http_${res.status}`, description: body.error_description };
}

export async function discover(io: Pick<Io, 'fetch'>, url: string): Promise<ServerMetadata> {
  let res: Response;
  try {
    res = await io.fetch(`${url}/.well-known/oauth-authorization-server`);
  } catch (err) {
    throw new CliError(
      `Can't reach ${url}: ${(err as Error).message}`,
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
  return (await res.json()) as ServerMetadata;
}

/** Registers this CLI as a public device-flow client (no secret, no redirect). */
export async function registerClient(io: Pick<Io, 'fetch'>, meta: ServerMetadata): Promise<string> {
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
): Promise<DeviceAuthorization> {
  const res = await io.fetch(
    meta.device_authorization_endpoint,
    form({ client_id: clientId, ...(scope ? { scope } : {}) }),
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
): Promise<TokenResponse> {
  let interval = Math.max(1, device.interval ?? 5);
  const deadline = io.now() + device.expires_in * 1000;
  for (;;) {
    await io.sleep(interval * 1000);
    const res = await io.fetch(
      meta.token_endpoint,
      form({ grant_type: DEVICE_GRANT, client_id: clientId, device_code: device.device_code }),
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
): Promise<TokenResponse> {
  const res = await io.fetch(
    meta.token_endpoint,
    form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
  );
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
): Promise<boolean> {
  if (!meta.revocation_endpoint) return false;
  try {
    const res = await io.fetch(
      meta.revocation_endpoint,
      form({ token, ...(clientId ? { client_id: clientId } : {}) }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

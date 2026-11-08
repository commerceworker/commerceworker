import { createManagementClient, type ManagementClient } from '@commerceworker/sdk-management';
import { type Profile, readCredentials, writeCredentials } from './credentials.js';
import type { Io } from './io.js';
import { discover, refresh } from './oauth.js';
import { CliError, EXIT, usageError } from './output.js';

/** Flags every command accepts that pick the deployment, space and environment. */
export interface Target {
  readonly url?: string;
  readonly space?: string;
  readonly environment?: string;
  readonly profile?: string;
}

/** Who the CLI acts as for one command, and where. */
export interface Session {
  readonly url: string;
  readonly space: string;
  readonly environment: string;
  readonly token: string;
  /** `env` for COMMERCEWORKER_TOKEN, else the profile's name. */
  readonly source: string;
  readonly profile?: Profile;
}

/** Refresh this long before the access token expires, so a command doesn't start on a dying one. */
const REFRESH_MARGIN_MS = 60_000;

export const trimUrl = (url: string) => url.replace(/\/+$/, '');

export const profileName = (target: Target, io: Pick<Io, 'env'>, current?: string) =>
  target.profile ?? io.env.COMMERCEWORKER_PROFILE ?? current ?? 'default';

/**
 * Resolves the token and target for a command. `COMMERCEWORKER_TOKEN` wins (CI, agents), with the
 * deployment from `--url` or `COMMERCEWORKER_URL`; otherwise the stored profile, refreshed first
 * when its access token is about to expire. Flags override the profile's space and environment.
 */
export async function resolveSession(target: Target, io: Io): Promise<Session> {
  const envToken = io.env.COMMERCEWORKER_TOKEN;
  if (envToken) {
    const url = target.url ?? io.env.COMMERCEWORKER_URL;
    if (!url)
      throw usageError('COMMERCEWORKER_TOKEN is set: pass --url or set COMMERCEWORKER_URL.');
    const space =
      target.space ?? io.env.COMMERCEWORKER_SPACE ?? (await spaceOf(io, trimUrl(url), envToken));
    return {
      url: trimUrl(url),
      space,
      environment: target.environment ?? io.env.COMMERCEWORKER_ENVIRONMENT ?? 'main',
      token: envToken,
      source: 'env',
    };
  }

  const credentials = await readCredentials(io);
  const name = profileName(target, io, credentials.current);
  let profile = credentials.profiles[name];
  if (!profile) {
    throw new CliError(
      'Not signed in. Run `commerceworker login --url <api url>`, or set COMMERCEWORKER_TOKEN.',
      EXIT.auth,
      'not_signed_in',
    );
  }
  if (
    profile.refreshToken &&
    profile.clientId &&
    profile.expiresAt !== undefined &&
    profile.expiresAt - REFRESH_MARGIN_MS <= io.now()
  ) {
    const meta = await discover(io, profile.url);
    const tokens = await refresh(io, meta, profile.clientId, profile.refreshToken);
    profile = {
      ...profile,
      accessToken: tokens.access_token,
      // Refresh tokens rotate: the old one is spent once used.
      refreshToken: tokens.refresh_token ?? profile.refreshToken,
      expiresAt: tokens.expires_in ? io.now() + tokens.expires_in * 1000 : undefined,
    };
    const latest = await readCredentials(io);
    await writeCredentials(io, {
      ...latest,
      profiles: { ...latest.profiles, [name]: profile },
    });
  }
  return {
    url: target.url ? trimUrl(target.url) : profile.url,
    space: target.space ?? profile.space,
    environment: target.environment ?? profile.environment,
    token: profile.accessToken,
    source: name,
    profile,
  };
}

/** The space a token is bound to; an admin token (`*`) needs `--space`. */
async function spaceOf(io: Pick<Io, 'fetch'>, url: string, token: string): Promise<string> {
  const me = await whoAmI(io, url, token);
  if (!me.spaceId || me.spaceId === '*') {
    throw usageError('This token reaches every space: pass --space or set COMMERCEWORKER_SPACE.');
  }
  return me.spaceId;
}

export interface Me {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted: boolean;
}

export async function whoAmI(io: Pick<Io, 'fetch'>, url: string, token: string): Promise<Me> {
  const res = await io.fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    throw new CliError(
      'The token was refused (401). Run `commerceworker login` again.',
      EXIT.auth,
      'unauthorized',
    );
  }
  if (!res.ok) throw new CliError(`GET /auth/me failed: ${res.status}`, EXIT.failure, 'http_error');
  return (await res.json()) as Me;
}

export function clientFor(session: Session, io: Pick<Io, 'fetch'>): ManagementClient {
  return createManagementClient({
    baseUrl: session.url,
    space: session.space,
    environment: session.environment,
    token: session.token,
    fetch: io.fetch,
  });
}

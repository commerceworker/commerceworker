import { createManagementClient, type ManagementClient } from '@commerceworker/sdk-management';
import {
  type Product,
  type Profile,
  productOf,
  readCredentials,
  withCredentialsLock,
  writeCredentials,
} from './credentials.js';
import type { Io } from './io.js';
import { discover, REFRESH_TIMEOUT_MS, refresh } from './oauth.js';
import { assertSecureOrigin } from './origin.js';
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
    assertSecureOrigin(url);
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

  const { name, profile } = await storedProfile(target, io, 'content');
  const fresh = await refreshed(io, name, profile);
  const url = target.url ? trimUrl(target.url) : fresh.url;
  assertSecureOrigin(url);
  const space = target.space ?? fresh.space;
  if (!space) {
    throw usageError(`Profile "${name}" has no space: pass --space or sign in again.`);
  }
  return {
    url,
    space,
    environment: target.environment ?? fresh.environment ?? 'main',
    token: fresh.accessToken,
    source: name,
    profile: fresh,
  };
}

/** Who the CLI acts as for one commerce command: a token and the admin origin it is for. */
export interface CommerceSession {
  /** The admin origin (the REST API is at `${url}/api/v1`). */
  readonly url: string;
  readonly token: string;
  readonly source: string;
  readonly profile?: Profile;
}

/**
 * The commerce counterpart of {@link resolveSession}: `COMMERCEWORKER_TOKEN` (an API token, or an
 * access token) with `--url` or `COMMERCEWORKER_URL`, else the stored commerce profile, refreshed
 * when it is about to expire.
 */
export async function resolveCommerceSession(target: Target, io: Io): Promise<CommerceSession> {
  const envToken = io.env.COMMERCEWORKER_TOKEN;
  if (envToken) {
    const url = target.url ?? io.env.COMMERCEWORKER_URL;
    if (!url) {
      throw usageError('COMMERCEWORKER_TOKEN is set: pass --url or set COMMERCEWORKER_URL.');
    }
    return { url: assertSecureOrigin(url), token: envToken, source: 'env' };
  }
  const { name, profile } = await storedProfile(target, io, 'commerce');
  const fresh = await refreshed(io, name, profile);
  return {
    url: assertSecureOrigin(target.url ?? fresh.url),
    token: fresh.accessToken,
    source: name,
    profile: fresh,
  };
}

/** The origin of a URL the person gave, which must be one a token may be sent to. */
export const originOf = assertSecureOrigin;

/** The named profile, which must belong to the product the command is for. */
async function storedProfile(
  target: Target,
  io: Io,
  product: Product,
): Promise<{ name: string; profile: Profile }> {
  const credentials = await readCredentials(io);
  const name = profileName(target, io, credentials.current);
  const profile = credentials.profiles[name];
  if (!profile) {
    throw new CliError(
      product === 'commerce'
        ? 'Not signed in. Run `commerceworker login --url <admin url>`, or set COMMERCEWORKER_TOKEN.'
        : 'Not signed in. Run `commerceworker login --url <api url>`, or set COMMERCEWORKER_TOKEN.',
      EXIT.auth,
      'not_signed_in',
    );
  }
  if (productOf(profile) !== product) {
    const other = productOf(profile);
    throw new CliError(
      `Profile "${name}" is signed in to a ${other} deployment (${profile.url}), and this command works with ${product} ones. Pass --profile <name> for a ${product} profile, or sign in to one with \`commerceworker login --profile <name>\`.`,
      EXIT.usage,
      'wrong_product',
    );
  }
  // A stored token goes only where it was issued: `--url` can't redirect it.
  if (target.url && originOf(target.url) !== originOf(profile.url)) {
    throw usageError(
      `--url ${originOf(target.url)} is not where profile "${name}" signed in (${originOf(profile.url)}). Pass --profile for a profile signed in there, or use COMMERCEWORKER_TOKEN with --url.`,
    );
  }
  return { name, profile };
}

const needsRefresh = (profile: Profile, io: Pick<Io, 'now'>) =>
  profile.refreshToken !== undefined &&
  profile.clientId !== undefined &&
  profile.expiresAt !== undefined &&
  profile.expiresAt - REFRESH_MARGIN_MS <= io.now();

/**
 * The profile with a live access token, refreshing it first when it is about to expire. Under the
 * credentials lock, and from what is on disk by then: another CLI process may have refreshed while
 * this one waited, and its rotated refresh token is the only valid one left.
 */
async function refreshed(io: Io, name: string, profile: Profile): Promise<Profile> {
  if (!needsRefresh(profile, io)) return profile;
  return withCredentialsLock(io, async () => {
    const latest = await readCredentials(io);
    const stored = latest.profiles[name];
    if (!stored) {
      throw new CliError('Not signed in. Run `commerceworker login`.', EXIT.auth, 'not_signed_in');
    }
    if (!needsRefresh(stored, io) || !stored.refreshToken || !stored.clientId) return stored;
    const commerce = productOf(stored) === 'commerce';
    const meta = await discover(
      io,
      stored.url,
      commerce ? stored.url : undefined,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    );
    const tokens = await refresh(
      io,
      meta,
      stored.clientId,
      stored.refreshToken,
      commerce ? `${stored.url}/api/v1` : undefined,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    );
    const next: Profile = {
      ...stored,
      accessToken: tokens.access_token,
      // Refresh tokens rotate: the old one is spent once used.
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: tokens.expires_in ? io.now() + tokens.expires_in * 1000 : undefined,
    };
    await writeCredentials(io, { ...latest, profiles: { ...latest.profiles, [name]: next } });
    return next;
  });
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

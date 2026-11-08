/**
 * The calling platform's UCP profile, fetched from the URL it was registered with and kept on its
 * row for an hour (UCP asks at least a minute). The fetch follows UCP's rules, behind the egress
 * policy (`safeFetch`): https only, no redirects, a timeout and a size cap. A profile that can't be fetched or read refuses the request
 * (424 / 422); one that can is negotiated against ours.
 */

import {
  EgressRefused,
  type Negotiated,
  negotiate,
  type PlatformCaller,
  type PlatformProfile,
  parsePlatformProfile,
  readCappedText,
  safeFetch,
} from '@commerceworker/core';
import { ucpStore } from '../wire';

const TTL_MS = 3_600_000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 128 * 1024;

export class ProfileError extends Error {
  constructor(
    readonly status: 422 | 424,
    readonly code: 'profile_malformed' | 'profile_unreachable',
    message: string,
  ) {
    super(message);
  }
}

async function fetchProfile(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await safeFetch(url, { headers: { accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    throw new ProfileError(
      424,
      'profile_unreachable',
      `Fetching the platform profile failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ProfileError(
      424,
      'profile_unreachable',
      `The platform profile answered HTTP ${res.status}.`,
    );
  }
  let text: string;
  try {
    text = await readCappedText(res, MAX_BYTES);
  } catch (err) {
    if (err instanceof EgressRefused)
      throw new ProfileError(422, 'profile_malformed', 'The platform profile is too large.');
    throw new ProfileError(424, 'profile_unreachable', `Reading the platform profile failed.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProfileError(422, 'profile_malformed', 'The platform profile is not JSON.');
  }
}

/** The platform's profile, from the cache on its row or fetched again. */
export async function platformProfile(env: Env, caller: PlatformCaller): Promise<PlatformProfile> {
  const row = await ucpStore(env).platform(caller.id);
  let doc: unknown = null;
  if (row?.profile && row.profileFetchedAt && Date.now() - row.profileFetchedAt < TTL_MS)
    doc = JSON.parse(row.profile);
  else {
    doc = await fetchProfile(caller.profileUrl);
    await ucpStore(env).cacheProfile(caller.id, JSON.stringify(doc), Date.now());
  }
  const parsed = parsePlatformProfile(doc);
  if ('problem' in parsed) throw new ProfileError(422, 'profile_malformed', parsed.problem);
  return parsed;
}

/** The platform's profile and what it negotiates to. */
export async function negotiated(
  env: Env,
  caller: PlatformCaller,
): Promise<{ profile: PlatformProfile; negotiation: Negotiated }> {
  const profile = await platformProfile(env, caller);
  return { profile, negotiation: negotiate(profile) };
}

/** The webhook URL a platform's cached profile gives for order events, if any. */
export async function platformWebhook(env: Env, platformId: string) {
  const row = await ucpStore(env).platform(platformId);
  if (!row?.profile || row.revokedAt) return null;
  const parsed = parsePlatformProfile(JSON.parse(row.profile));
  return 'problem' in parsed ? null : parsed.webhookUrl;
}

/**
 * Agentic checkout over UCP, the web Worker's part: the platforms an admin lets in, the checkout
 * flow, and forwarding `/ucp/*` to the engine (apps/engine/src/ucp/).
 *
 * A platform calls with its API key (`X-API-Key`, or `Authorization: Bearer`) and names its UCP
 * profile in `UCP-Agent`, which must be the profile it was registered with. The key stays here:
 * the engine gets the platform in the signed principal header (`signPlatform`), never a key.
 * Discovery (`/.well-known/ucp`) is public and comes from the engine, which holds the signing key.
 */

import { env } from 'cloudflare:workers';
import {
  checkoutFlowProblem,
  DEV_PRINCIPAL_KEY,
  type FlowGraph,
  newId,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  readUcpSettings,
  signPlatform,
  UCP_MCP_PATH,
  UCP_PATH,
  UCP_PLATFORM_KEY_PREFIX,
  UCP_SETTINGS_KEY,
  type UcpSettings,
  ucpAgentProfile,
  ucpError,
} from '@commerceworker/core';
import type { UcpPlatform } from '@commerceworker/ports/commerce';
import type { z } from 'zod';
import type { platformInput } from './api-schemas';
import { randomToken, sha256Hex } from './credentials';
import { afterResponse, engine } from './env.server';
import { overBudget } from './rate-limit';
import { flowStore, ucpStore, workspaceStore } from './wire.server';

/** What the API shows: never the key. */
export async function listPlatforms() {
  return ucpStore().platforms(500);
}

/** The key is returned once, here; afterwards only the platform holds it. */
export async function addPlatform(input: z.infer<typeof platformInput>, by: string) {
  const key = `${UCP_PLATFORM_KEY_PREFIX}${randomToken()}`;
  const platform = {
    id: newId('ucp'),
    name: input.name,
    profileUrl: input.profileUrl,
    keyPrefix: key.slice(0, UCP_PLATFORM_KEY_PREFIX.length + 4),
    createdAt: Date.now(),
    createdBy: by,
  };
  await ucpStore().addPlatform({ ...platform, keyHash: await sha256Hex(key) });
  return { platform: { ...platform, lastUsedAt: null, revokedAt: null }, key };
}

/** Revoked at once. The row stays, so its checkouts and orders still name it. */
export async function revokePlatform(id: string) {
  return (await ucpStore().revokePlatform(id, Date.now())) ?? null;
}

const SETTINGS_CACHE_MS = 30_000;
let cachedSettings: { value: UcpSettings; at: number } | null = null;

/**
 * Agentic checkout's settings; off (no checkout flow) until an admin sets them. Every `/ucp`
 * call checks them and they change rarely, so each isolate keeps what it read for 30 seconds.
 * `fresh` reads D1 regardless, for the admin API: what an admin sees or changes is never a
 * copy another isolate read before their last save.
 */
export async function ucpSettings({ fresh = false } = {}): Promise<UcpSettings> {
  if (!fresh && cachedSettings && Date.now() - cachedSettings.at < SETTINGS_CACHE_MS)
    return cachedSettings.value;
  const value = readUcpSettings(await workspaceStore().setting(UCP_SETTINGS_KEY));
  cachedSettings = { value, at: Date.now() };
  return value;
}
export const forgetUcpSettings = () => {
  cachedSettings = null;
};

/** Why `flowId` can't take checkouts (unknown, unpublished, or never holds a card), or null. */
export async function checkoutFlowRefusal(flowId: string): Promise<string | null> {
  const version = await flowStore().version(flowId);
  if (!version) return `No published flow ${flowId}`;
  return checkoutFlowProblem(version as unknown as FlowGraph);
}

export async function setUcpSettings(next: UcpSettings, by: string) {
  await workspaceStore().setSetting(UCP_SETTINGS_KEY, JSON.stringify(next), by);
  cachedSettings = { value: next, at: Date.now() };
}

/** How often a platform's last use is written back. */
const TOUCH_MS = 5 * 60_000;

/** The platform behind a request's key, if the key is live. */
async function platformFor(request: Request): Promise<UcpPlatform | null> {
  const key =
    request.headers.get('x-api-key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!key.startsWith(UCP_PLATFORM_KEY_PREFIX)) return null;
  const row = await ucpStore().livePlatform(await sha256Hex(key));
  if (!row) return null;
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt > TOUCH_MS)
    afterResponse(ucpStore().touchPlatform(row.id, now));
  return row;
}

const refuse = (status: number, code: string, content: string, headers?: HeadersInit) =>
  Response.json(ucpError(code, content), { status, headers });

/**
 * Forwards a `/ucp/*` request from a registered platform to the engine, or refuses it: 401
 * without a live key, 400 without a profile in `UCP-Agent` (REST), 403 when it names a profile
 * other than the platform's, 404 while agentic checkout is off.
 */
export async function ucpFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const row = await platformFor(request);
  if (!row)
    return refuse(401, 'unauthorized', 'Send your API key in X-API-Key.', {
      'www-authenticate': 'Bearer',
    });
  // REST names the profile in UCP-Agent; MCP may name it only in each call's meta, which the
  // engine checks against the same registered profile.
  const header = request.headers.get('ucp-agent');
  const profile = ucpAgentProfile(header);
  if (!profile && (header || url.pathname !== UCP_MCP_PATH))
    return refuse(
      400,
      'invalid_profile_url',
      'Name your profile in UCP-Agent: profile="https://…".',
    );
  if (profile && profile !== row.profileUrl)
    return refuse(403, 'forbidden', 'UCP-Agent names a different profile than this key is for.');
  if (!(await ucpSettings()).checkoutFlowId)
    return refuse(404, 'not_found', 'Agentic checkout is not turned on for this workspace.');
  // Each platform has its own budget, like an MCP or A2A client.
  const limited = await overBudget('AGENT_LIMIT', `${UCP_PATH}:${row.id}`);
  if (limited) return limited;

  const caller: PlatformCaller = {
    id: row.id,
    name: row.name,
    profileUrl: row.profileUrl,
    origin: url.origin,
  };
  const headers = new Headers(request.headers);
  // The engine trusts the signed header; the platform's key stays here.
  headers.delete('authorization');
  headers.delete('x-api-key');
  headers.delete('cookie');
  headers.delete(PRINCIPAL_HEADER);
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  headers.set(PRINCIPAL_HEADER, await signPlatform(key, caller, url.pathname));
  return engine().fetch(
    new Request(`https://engine${url.pathname}${url.search}`, new Request(request, { headers })),
  );
}

/**
 * The business profile, public like the Agent Card: built by the engine for this origin. 404
 * while agentic checkout is off. UCP asks for a public cache of at least a minute.
 */
export async function ucpDiscovery(url: URL): Promise<Response> {
  const profile = await engine().ucpProfile(url.origin);
  if (!profile)
    return Response.json(ucpError('not_found', 'This business does not offer UCP checkout.'), {
      status: 404,
      headers: { 'cache-control': 'public, max-age=60' },
    });
  return Response.json(profile, { headers: { 'cache-control': 'public, max-age=300' } });
}

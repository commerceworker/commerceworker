/**
 * Agentic checkout over UCP, the storefront's part: the platforms an admin lets in (registered on
 * the admin, `apps/web/app/lib/ucp.server.ts`), the checkout flow, and forwarding `/ucp/*` to the
 * engine (apps/engine/src/ucp/).
 *
 * A platform calls with its API key (`X-API-Key`, or `Authorization: Bearer`) and names its UCP
 * profile in `UCP-Agent`, which must be the profile it was registered with. Only the key's hash
 * leaves this Worker, to the engine's `StorefrontApi`, which holds the platforms; the engine gets
 * the platform in the signed header (`signPlatform`, under the storefront key), never a key.
 * Discovery (`/.well-known/ucp`) is public and comes from the engine, which holds the signing key.
 */

import {
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_MCP_PATH,
  UCP_PATH,
  UCP_PLATFORM_KEY_PREFIX,
  type UcpPlatformRef,
  ucpAgentProfile,
  ucpError,
} from '@commerceworker/core';
import { sha256Hex } from '@commerceworker/security/credentials';
import { engine } from './env.server';
import { signingKey } from './principal.server';
import { overBudget } from './rate-limit';

const SETTINGS_CACHE_MS = 30_000;
let cachedOn: { value: boolean; at: number } | null = null;

/**
 * Whether agentic checkout is on (the engine reads it from the workspace's settings); off until
 * an admin sets a checkout flow. Every `/ucp` call checks it and it changes rarely, so each isolate
 * keeps what it read for 30 seconds: a change an admin saves reaches the storefront within that time.
 */
async function checkoutOn(): Promise<boolean> {
  if (cachedOn && Date.now() - cachedOn.at < SETTINGS_CACHE_MS) return cachedOn.value;
  const value = await engine().ucpCheckoutOn();
  cachedOn = { value, at: Date.now() };
  return value;
}
export const forgetUcpSettings = () => {
  cachedOn = null;
};

/** The platform behind a request's key, if the key is live (the engine looks it up and records its use). */
async function platformFor(request: Request): Promise<UcpPlatformRef | null> {
  const key =
    request.headers.get('x-api-key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!key.startsWith(UCP_PLATFORM_KEY_PREFIX)) return null;
  return engine().ucpPlatform(await sha256Hex(key));
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
  if (!(await checkoutOn()))
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
  headers.set(PRINCIPAL_HEADER, await signPlatform(await signingKey(), caller, url.pathname));
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

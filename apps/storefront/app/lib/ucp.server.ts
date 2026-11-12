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
  LINK_USER_TOKEN_HEADER,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_CATALOG_TOOLS,
  UCP_MCP_PATH,
  UCP_PATH,
  UCP_PLATFORM_KEY_PREFIX,
  type UcpPlatformRef,
  ucpAgentProfile,
  ucpCatalogOp,
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

/** The most of a body read to price it: the engine's own limit on one. */
const PEEK_MAX = 256 * 1024;
/** The most ids a lookup takes (`LOOKUP_IDS_MAX` in core's catalog mapping), and so its cost. */
const LOOKUP_UNITS_MAX = 50;

const isJson = (request: Request) =>
  /^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '');

/**
 * A request's body as JSON, read from a copy so the engine still gets the request whole, or null
 * when it is not declared JSON, is too large or doesn't parse. The engine refuses all three, so a
 * body this can't read is never a catalog call it would serve.
 */
async function peekJson(request: Request): Promise<unknown> {
  if (!isJson(request) || request.method !== 'POST' || !request.body) return null;
  if (Number(request.headers.get('content-length') ?? 0) > PEEK_MAX) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PEEK_MAX) {
      // Not awaited: a cancelled branch of a tee settles only when the other one is done too.
      reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  }
}

/** A lookup costs one unit an id (at least one, at most the most it takes). */
const lookupUnits = (request: unknown) => {
  const ids = (request as { ids?: unknown } | null | undefined)?.ids;
  return Array.isArray(ids) ? Math.min(Math.max(ids.length, 1), LOOKUP_UNITS_MAX) : 1;
};

/**
 * What a request costs of a platform's catalog budget: 0 when it is not a catalog read (it spends
 * `AGENT_LIMIT`), else one unit, or one an id for a lookup, since a lookup reads each id. A catalog
 * read is a REST path of the catalog or an MCP `tools/call` of one of its tools; a lookup's ids are
 * counted from its body (`peekJson`), and a body that can't be read costs the one unit it is
 * refused for.
 */
async function catalogUnits(request: Request, pathname: string): Promise<number> {
  const op = ucpCatalogOp(pathname);
  if (op) return op === 'lookup_catalog' ? lookupUnits(await peekJson(request)) : 1;
  if (pathname !== UCP_MCP_PATH) return 0;
  const rpc = (await peekJson(request)) as {
    method?: unknown;
    params?: { name?: unknown; arguments?: { catalog?: unknown } };
  } | null;
  const name = String(rpc?.params?.name);
  if (rpc?.method !== 'tools/call' || !UCP_CATALOG_TOOLS.includes(name)) return 0;
  return name === 'lookup_catalog' ? lookupUnits(rpc.params?.arguments?.catalog) : 1;
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
  // Each platform has its own budget, like an MCP or A2A client; its catalog reads another, so a
  // platform browsing can't use up what its checkouts need, and the reverse.
  const units = await catalogUnits(request, url.pathname);
  let limited: Response | null = null;
  // The rate limiter counts one a call, so a lookup of n ids makes n calls and stops at the first refusal.
  for (let i = 0; i < units && !limited; i++)
    limited = await overBudget('CATALOG_LIMIT', `${UCP_PATH}/catalog:${row.id}`);
  if (!units) limited = await overBudget('AGENT_LIMIT', `${UCP_PATH}:${row.id}`);
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
  headers.delete(LINK_USER_TOKEN_HEADER);
  // With the key in X-API-Key, `Authorization: Bearer` is the slot for a linked shopper's access
  // token (identity linking). The engine checks it against the platform it signs for below; it
  // is no credential alone.
  const bearer = /^Bearer\s+(\S{1,512})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (bearer && request.headers.has('x-api-key') && !bearer.startsWith(UCP_PLATFORM_KEY_PREFIX))
    headers.set(LINK_USER_TOKEN_HEADER, bearer);
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

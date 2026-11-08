/**
 * Who may reach an assistant: only its own person. The web gateway signs `x-cw-principal` for the
 * exact path a request takes (`/agents/assistant-agent/<person>`, and its `/get-messages`), good
 * for 60 seconds; the api checks it here before forwarding to the engine's object, and the object
 * checks it again itself (./agent.ts), so neither trusts the other's word for who is calling.
 *
 * These paths are signed with the assistant's own key, derived from PRINCIPAL_KEY with HKDF
 * (`@commerceworker/security/assistant-key`), not with PRINCIPAL_KEY: the engine holds only the
 * derived key (ASSISTANT_PRINCIPAL_KEY), and a principal signed with it never verifies on the api's
 * REST surface, which keeps to the main key.
 */

import { ASSISTANT_AGENT } from '@commerceworker/domain';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  verifyPrincipal,
  type WebPrincipal,
} from '@commerceworker/security/principal';
import { routeAgentRequest } from 'agents';

const present = (keys: (string | undefined)[]) => keys.filter((k): k is string => Boolean(k));

/**
 * The api's keys for the assistant's paths: derived from PRINCIPAL_KEY, then from
 * PRINCIPAL_KEY_PREVIOUS while a rotation finishes. Never the main keys themselves: a principal
 * signed with one is good for the REST surface only.
 */
export async function gateKeys(env: EdgeEnv): Promise<string[]> {
  return Promise.all(
    present([env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS]).map(deriveAssistantPrincipalKey),
  );
}

/**
 * The engine's keys: ASSISTANT_PRINCIPAL_KEY, then ASSISTANT_PRINCIPAL_KEY_PREVIOUS while a
 * rotation finishes. The engine holds no other principal key.
 */
export function engineKeys(env: EdgeEnv): string[] {
  return present([env.ASSISTANT_PRINCIPAL_KEY, env.ASSISTANT_PRINCIPAL_KEY_PREVIOUS]);
}

/** True for a path the assistant's routing owns (`/agents/assistant-agent/…`). */
export const isAssistantPath = (pathname: string) =>
  pathname.startsWith(`/agents/${ASSISTANT_AGENT}/`);

/** The person an assistant path names, decoded; null when it names none (or a malformed one). */
export function assistantName(pathname: string): string | null {
  const [agents, agent, name] = pathname.split('/').filter(Boolean);
  if (agents !== 'agents' || agent !== ASSISTANT_AGENT || !name) return null;
  try {
    const decoded = decodeURIComponent(name);
    return decoded && encodeURIComponent(decoded) === name ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The SDK would hand `/agents/<agent>/<name>/sub/<class>/<name>` on to a child object, past this
 * gate; the assistant has no children.
 */
export const namesSubAgent = (pathname: string) =>
  pathname.split('/').filter(Boolean).slice(3).includes('sub');

const refuse = (status: 401 | 403 | 404, message: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * The signed principal of a request to an assistant, when it is signed for this very path and
 * names the person whose assistant it is; otherwise the response that refuses it.
 */
export async function assistantCaller(
  keys: readonly string[],
  request: Request,
): Promise<WebPrincipal | Response> {
  const { pathname } = new URL(request.url);
  const name = assistantName(pathname);
  if (!name || namesSubAgent(pathname)) return refuse(404, 'Not found');
  if (!keys.length)
    console.error('No assistant principal key is set: refusing every assistant request');
  const claims = await verifyPrincipal(
    keys,
    request.headers.get(PRINCIPAL_HEADER),
    principalTarget(request.method, pathname),
  );
  if (!claims) return refuse(401, 'Sign in to use Coworker.');
  if (claims.sub !== name) return refuse(403, 'Not your Coworker.');
  return claims;
}

/**
 * The api's forward to the engine's AssistantAgent: checked here first, then routed by the SDK
 * with only the assistant's binding in reach, so no path can address another Durable Object.
 */
export async function routeAssistant(request: Request, env: EdgeEnv): Promise<Response> {
  const namespace = env.ASSISTANT_AGENT;
  if (!namespace) return refuse(404, 'Not found');
  const claims = await assistantCaller(await gateKeys(env), request);
  if (claims instanceof Response) return claims;
  // Keyed on the route the SDK matched, not on the path's spelling.
  const gate = (_req: Request, route: { className: string; name: string }) =>
    route.className === 'ASSISTANT_AGENT' &&
    (route.name === claims.sub || route.name === encodeURIComponent(claims.sub))
      ? undefined
      : refuse(403, 'Not your Coworker.');
  // The SDK's own routing headers are set by it alone, never by a caller.
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()])
    if (name.startsWith('x-agents-') || name.startsWith('x-partykit-')) headers.delete(name);
  const routed = await routeAgentRequest(
    new Request(request, { headers }),
    { ASSISTANT_AGENT: namespace },
    { onBeforeConnect: gate, onBeforeRequest: gate },
  );
  return routed ?? refuse(404, 'Not found');
}

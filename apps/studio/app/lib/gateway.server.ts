/**
 * The API gateway: the web Worker fronts the api Worker over the `API` service binding, so the
 * admin, the REST and GraphQL APIs, MCP, OAuth and the docs share one origin.
 *
 * Credentials never cross the binding as the browser sent them:
 * 1. A request with `Authorization: Bearer …` (an API key, a personal access token, an OAuth
 *    token) goes through as it is; the api authenticates it. Only a caller-supplied
 *    `x-cw-principal` is removed, so a bearer request can never carry a principal.
 * 2. Otherwise, a request from this origin with a live web session has its cookies removed and a
 *    signed `x-cw-principal` added (`@commerceworker/security`), good for 60 seconds and for that
 *    path only. A cross-site request never gets one, so a page elsewhere can't borrow the session.
 * 3. Otherwise it goes through with no credentials at all, and the api answers 401 where it needs
 *    one.
 *
 * `x-cw-bookmark` (read-your-writes) passes through both ways untouched. A WebSocket upgrade
 * (the assistant's socket, `/agents/…`) goes the same way: the binding carries the upgrade and
 * hands back the api's socket.
 */

import { PRINCIPAL_HEADER, principalTarget } from '@commerceworker/security/principal';
import { crossOrigin } from './origin';
import type { SignedPrincipal } from './principal.server';

/** Exact paths the api serves. */
const EXACT = new Set([
  '/spaces',
  '/starters',
  '/mcp',
  '/openapi.json',
  '/docs',
  '/health/api',
  '/auth/me',
]);

/** Path prefixes the api serves (each already ends in `/` or names a family, like `/guides`). */
const PREFIXES = [
  '/spaces/',
  '/preview/',
  '/delivery/',
  '/oauth/',
  '/.well-known/oauth-',
  '/media/',
  '/docs/',
  '/guides',
  // The assistant's socket and its message history (`/agents/assistant-agent/<person>`).
  '/agents/',
];

/** Whether the gateway forwards `pathname` to the api rather than rendering a page. */
export function isApiPath(pathname: string): boolean {
  return EXACT.has(pathname) || PREFIXES.some((p) => pathname.startsWith(p));
}

/** The bearer credential a request carries, if any (the api checks it, never this Worker). */
export const hasBearer = (request: Request) =>
  /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '');

export type GatewayDeps = {
  /** The api Worker's binding. */
  api: Pick<Fetcher, 'fetch'>;
  /**
   * The delivery Worker's binding, when bound: a bearer-key `/delivery/*` call goes there, through
   * the same cache and gateway as on the cdn host. It trusts API keys only, so a session call
   * (signed principal) still goes to the api.
   */
  delivery?: Pick<Fetcher, 'fetch'>;
  /** The signed-in person for a browser request (with their session's id), or null. */
  principal: (request: Request) => Promise<(SignedPrincipal & { due?: string | null }) | null>;
  /** Sets the signed principal header for `path`. */
  sign: (headers: Headers, p: SignedPrincipal, path: string) => Promise<void>;
};

/**
 * Forwards `request` to the api with the credentials the rules above allow. A person whose
 * two-factor sign-in or own password is due may use only their Account page: they get a 403.
 */
export async function forwardToApi(request: Request, deps: GatewayDeps): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete(PRINCIPAL_HEADER);
  // Cookies never cross the binding, whatever else the request carries.
  headers.delete('cookie');

  if (hasBearer(request)) {
    const target =
      deps.delivery && url.pathname.startsWith('/delivery/') ? deps.delivery : deps.api;
    return target.fetch(new Request(request, { headers }));
  }

  // A cross-site request is forwarded without the session: there is nothing ambient to forge.
  const who = crossOrigin(request, url.origin) ? null : await deps.principal(request);
  if (who?.due) return Response.json({ error: who.due }, { status: 403 });
  if (who) {
    const { due: _due, ...p } = who;
    await deps.sign(headers, p, principalTarget(request.method, url.pathname));
  }
  return deps.api.fetch(new Request(request, { headers }));
}

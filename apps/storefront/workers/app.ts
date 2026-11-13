import { env } from 'cloudflare:workers';
import {
  LINK_METADATA_PATH,
  runHealthChecks,
  UCP_PATH,
  UCP_PROFILE_PATH,
} from '@commerceworker/core';
import { withSecurityHeaders } from '@commerceworker/security/csp';
import { crossOrigin } from '@commerceworker/security/origin';
import { opsMetrics, routeGroup } from '@commerceworker/telemetry/metrics';
import { createRequestHandler } from 'react-router';
import { APPLE_PAY_PATH, applePayFile } from '../app/lib/apple-pay.server';
import { cartGuest } from '../app/lib/cart-guest.server';
import { engine } from '../app/lib/env.server';
import { setGuestHeader } from '../app/lib/principal.server';
import { ucpDiscovery, ucpFetch } from '../app/lib/ucp.server';
import { linkEndpoint, linkEndpointOf, linkMetadata } from '../app/lib/ucp-link.server';

/**
 * The deploy smoke test's check: the engine's D1 and R2 (over the service binding, so a broken
 * engine deploy fails it too); this Worker has no data of its own. 503 when anything is down.
 */
async function deepHealth(): Promise<Response> {
  const report = await runHealthChecks('commerceworker-storefront', {
    engine: async () => {
      const r = await engine().health();
      if (!r.ok) throw new Error('engine unhealthy');
    },
  });
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

/** Request outcomes are counted by these groups, never by path: an id in a URL is no label. */
const ROUTE_GROUPS = [
  ['/health', 'health'],
  [UCP_PATH, 'ucp'],
  [UCP_PROFILE_PATH, 'ucp'],
  ['/agents', 'agents'],
  ['/assets', 'assets'],
] as const;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const ops = opsMetrics(env.METRICS, 'storefront');
    const group = routeGroup(url.pathname, ROUTE_GROUPS);
    const started = Date.now();
    let response: Response;
    try {
      response = await route(request);
    } catch (err) {
      ops.request(group, 500, Date.now() - started);
      throw err;
    }
    ops.request(group, response.status, Date.now() - started);
    return withSecurityHeaders(response, url);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health')
    return Response.json({ ok: true, service: 'commerceworker-storefront' });
  if (url.pathname === '/health/deep') return deepHealth();
  if (url.pathname === APPLE_PAY_PATH && request.method === 'GET') return applePayFile();

  // UCP (agentic checkout): the business profile is public; checkout and orders under /ucp take
  // a registered platform's key (app/lib/ucp.server.ts). Ahead of the cross-site check, as a
  // platform is no browser and holds no cookie.
  if (url.pathname === UCP_PROFILE_PATH && request.method === 'GET') return ucpDiscovery(url);
  if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
    return ucpFetch(request);

  // Identity linking's authorization server: its metadata is public and its token and revocation
  // endpoints take a platform's key (app/lib/ucp-link.server.ts), so they too are ahead of the
  // cross-site check. The consent page is a route below, and so under it.
  if (url.pathname === LINK_METADATA_PATH && request.method === 'GET') return linkMetadata();
  const linkKind = linkEndpointOf(url.pathname);
  if (linkKind) return linkEndpoint(request, linkKind);

  // A browser's state-changing requests and a cart's socket must come from this origin: the
  // buyer's cookie is SameSite=None (their procurement system frames the cart), so another site
  // could otherwise post with it.
  if (crossOrigin(request, url.origin))
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 });

  // A cart page's live connection to its CartAgent (Agents SDK WebSocket + RPC), for the buyer
  // only: staff reach a cart's socket on the admin. The envelope is signed for this path alone and
  // the cookie never leaves this Worker.
  if (url.pathname.startsWith('/agents/cart-agent/')) {
    // The raw segment: a cart id has nothing to decode, and cartGuest refuses anything else
    // (decoding a malformed escape would throw before the refusal).
    const guest = await cartGuest(request, url.pathname.split('/')[3] ?? '');
    if (!guest) return new Response('Unauthorized', { status: 401 });
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    await setGuestHeader(headers, guest, url.pathname);
    return engine().fetch(
      new Request(`https://engine${url.pathname}${url.search}`, new Request(request, { headers })),
    );
  }

  const res = await requestHandler(request);
  // A cart is per buyer and changes as they work: a browser may keep a page, but asks first.
  if (res.headers.get('content-type')?.startsWith('text/html') && !res.headers.has('cache-control'))
    res.headers.set('cache-control', 'private, no-cache');
  return res;
}

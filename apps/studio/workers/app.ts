import { createRequestHandler } from 'react-router';
import { awaitingSetup, principal, sessionId, setupDue } from '../app/lib/auth.server';
import { withSecurityHeaders } from '../app/lib/csp';
import { api, delivery } from '../app/lib/env.server';
import { forwardToApi, hasBearer, isApiPath } from '../app/lib/gateway.server';
import { runHealthChecks } from '../app/lib/health';
import { crossOrigin } from '../app/lib/origin';
import { setPrincipalHeader } from '../app/lib/principal.server';
import { SCIM_PATH } from '../app/lib/scim';
import { scimFetch } from '../app/lib/scim.server';
import { answersBeforeSetup } from '../app/lib/setup-gate';

/**
 * The deploy smoke test's check: this Worker's D1, and the api's health (over the service binding,
 * so a broken api deploy fails it too). 503 when anything is down.
 */
async function deepHealth(env: Env): Promise<Response> {
  const report = await runHealthChecks('commerceworker-studio', {
    db: () => env.DB.prepare('select 1').first(),
    api: async () => {
      const r = await env.API.fetch('https://api/health');
      await r.body?.cancel();
      if (!r.ok) throw new Error('api unhealthy');
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

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await route(request, env, ctx), new URL(request.url));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health')
    return Response.json({ ok: true, service: 'commerceworker-studio' });
  if (url.pathname === '/health/deep') return deepHealth(env);

  // The api's own surfaces (REST, GraphQL, delivery, preview, MCP, OAuth, media, docs), forwarded
  // with a signed principal or the caller's bearer token (app/lib/gateway.server.ts). A bearer
  // call works whether or not the admin is set up: the api checks its key.
  if (isApiPath(url.pathname)) {
    if (!hasBearer(request) && (await awaitingSetup(url)))
      return Response.json({ error: 'This deployment is not set up yet.' }, { status: 503 });
    const deliveryWorker = delivery();
    return forwardToApi(request, {
      api: api(),
      ...(deliveryWorker ? { delivery: deliveryWorker } : {}),
      principal: async (r) => {
        const p = await principal(r);
        if (!p) return null;
        // The session it came on, so what outlives this request (the assistant's socket) can
        // check that session is still live; open local development has none.
        const sid = p.kind === 'user' ? await sessionId(r) : undefined;
        return { ...p, due: setupDue(p), ...(sid ? { sid } : {}) };
      },
      sign: (headers, p, path) => setPrincipalHeader(headers, p, path),
    });
  }

  // With no people yet, a deployed workspace is waiting for its first admin: only the setup page
  // (and its assets) answer. On localhost the same state is open, for local development.
  if (!answersBeforeSetup(url.pathname) && (await awaitingSetup(url)))
    return request.method === 'GET' && request.headers.get('accept')?.includes('text/html')
      ? Response.redirect(new URL('/setup', url).href, 302)
      : Response.json({ error: 'This deployment is not set up yet.' }, { status: 503 });

  // SCIM provisioning from the identity provider, with its own bearer token.
  if (url.pathname === SCIM_PATH || url.pathname.startsWith(`${SCIM_PATH}/`))
    return scimFetch(request);

  // A browser's state-changing requests must come from this origin.
  if (crossOrigin(request, url.origin))
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 });

  const res = await requestHandler(request);
  // Pages are per person: a browser may keep one, but asks first.
  if (res.headers.get('content-type')?.startsWith('text/html') && !res.headers.has('cache-control'))
    res.headers.set('cache-control', 'private, no-cache');
  return res;
}

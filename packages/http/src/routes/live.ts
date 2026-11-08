import { SCOPES } from '@commerceworker/domain';
import { LIVE_ACCESS_HEADER, liveHubName } from '@commerceworker/platform/do/live-access';
import type { LiveHubDO } from '@commerceworker/platform/do/live-hub';
import { Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../api/auth';

/**
 * Cloudflare-native Live Content API: authorizes exactly like the stock
 * delivery route (same middleware chain, same path), then forwards the request
 * to the scope's LiveHubDO, which serves the SSE stream itself, showing each
 * subscriber only what its principal may read (`liveEventFor`). Mounted BEFORE
 * the stock delivery routes so it wins first-match.
 */
export function liveRoutes(deps: AuthDeps, ns: DurableObjectNamespace<LiveHubDO>): Hono<AuthVars> {
  const app = new Hono<AuthVars>();
  app.get(
    '/delivery/:space/:env/live',
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.deliveryRead),
    (c) => {
      const spaceId = c.req.param('space');
      const environmentId = c.get('environmentId') ?? c.req.param('env');
      const scope = { spaceId, environmentId };
      const stub = ns.get(ns.idFromName(liveHubName(scope)));
      // The hub filters and masks each event for this subscriber by the principal's content
      // grants (no grants: unrestricted), set here and never taken from the caller.
      const headers = new Headers(c.req.raw.headers);
      headers.set(
        LIVE_ACCESS_HEADER,
        JSON.stringify({ scope, contentGrants: c.get('principal').contentGrants }),
      );
      return stub.fetch(new Request(c.req.raw, { headers }));
    },
  );
  return app;
}

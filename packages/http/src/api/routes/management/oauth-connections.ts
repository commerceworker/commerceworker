import { listConnectedApps, revokeConnectedApp } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { parseBody, revokeConnectionBody } from '../../validation';

export function oauthConnectionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- connected OAuth applications (admin) --------------------------------
  app.get(
    '/spaces/:space/oauth/connections',
    doc('Auth', 'List applications connected via OAuth'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json({ items: await listConnectedApps(ctx, c.req.param('space')) }),
  );
  /**
   * Disconnects an application. POST rather than DELETE because the subject is
   * an identity string (usually an email) that has no business being a path
   * segment.
   */
  app.post(
    '/spaces/:space/oauth/connections/revoke',
    doc('Auth', 'Disconnect an OAuth application', {
      body: revokeConnectionBody,
      description:
        'Revokes every access token the client holds for that subject, and the grants behind them.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, revokeConnectionBody);
      const result = await revokeConnectedApp(
        ctx,
        c.req.param('space'),
        body.clientId,
        body.subject,
      );
      return c.json(result);
    },
  );

  return app;
}

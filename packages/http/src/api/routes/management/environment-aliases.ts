import {
  deleteEnvironmentAlias,
  listEnvironmentAliases,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { parseBody, setAliasBody } from '../../validation';

export function environmentAliasesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- environment aliases (blue/green) ----------------------------------
  app.get('/spaces/:space/environment-aliases', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironmentAliases(ctx, c.req.param('space')) }),
  );
  // Create or repoint an alias (atomic cutover).
  app.put(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, setAliasBody);
      return c.json(
        await setEnvironmentAlias(
          ctx,
          c.req.param('space'),
          c.req.param('alias'),
          body.targetEnvironmentId,
        ),
      );
    },
  );
  app.delete(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      await deleteEnvironmentAlias(ctx, c.req.param('space'), c.req.param('alias'));
      return c.body(null, 204);
    },
  );

  return app;
}

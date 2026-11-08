import {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  updateRole,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as roleDocs from '../../docs/schemas/roles';
import { parseBody, roleBody } from '../../validation';

const GRANT_RULES =
  'Each content grant lists `read`, `write` and `publish`. `delete` (trash and purge) comes with ' +
  '`write` or `publish`, and `unpublish` with `publish`, unless the grant withholds them in ' +
  '`deniedActions`: so a role can write but not delete, or publish but not unpublish.';

export function rolesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- roles (granular RBAC, admin) ----------------------------------------
  app.get(
    '/spaces/:space/roles',
    doc('Roles & permissions', 'List roles', { ok: roleDocs.roleList }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json({ items: await listRoles(ctx, c.req.param('space')) }),
  );
  app.post(
    '/spaces/:space/roles',
    doc('Roles & permissions', 'Create a role', {
      description: GRANT_RULES,
      body: roleBody,
      ok: roleDocs.role,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(await createRole(ctx, c.req.param('space'), await parseBody(c, roleBody)), 201),
  );
  app.get(
    '/spaces/:space/roles/:id',
    doc('Roles & permissions', 'Get a role', { ok: roleDocs.role }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json(await getRole(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.put(
    '/spaces/:space/roles/:id',
    doc('Roles & permissions', 'Replace a role', {
      description: `Keys and people holding it pick the change up live. ${GRANT_RULES}`,
      body: roleBody,
      ok: roleDocs.role,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        await updateRole(
          ctx,
          c.req.param('space'),
          c.req.param('id'),
          await parseBody(c, roleBody),
          deps.accessPolicy,
          c.get('principal'),
        ),
      ),
  );
  app.delete('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteRole(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}

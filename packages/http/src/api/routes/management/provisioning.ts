import {
  createEnvironment,
  deleteEnvironment,
  getStarterInstall,
  listEnvironments,
  listSpacesFor,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { availableStarters, createSpaceWithStarter } from '@commerceworker/seed';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as spaceDocs from '../../docs/schemas/spaces';
import { createEnvironmentBody, createSpaceBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function provisioningRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const allowEnterprise = deps.demoStarters === true;
  const app = new Hono<AuthVars>();

  // --- provisioning (admin) ----------------------------------------------
  // Authenticated principals see the spaces they can reach: admin → all, a signed-in member →
  // their teams, a scoped key → just its own. (No requireScope: there is no :space here.)
  app.get('/spaces', async (c) => {
    const items = await listSpacesFor(ctx, c.get('principal'));
    return c.json({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
  });
  app.post(
    '/spaces',
    doc('Spaces & environments', 'Create a space', {
      description:
        'Creates a space with its locales and environments (`main` by default), optionally with ' +
        'sample content (`starter: "sample"`), installed before the response returns. Where the ' +
        'deployment offers it (GET /starters), `starter: "enterprise"` adds a large demo brand: ' +
        'its locales and fallbacks join the space, and its content installs in the background, ' +
        'so the response carries `installing` (follow it at GET …/starter-installs/{install}); ' +
        'elsewhere it is a 422. Deployment administrators only: the admin token, or a person ' +
        "signed in to the admin as a deployment admin. A space's own API keys can't create " +
        'spaces. Creating a space whose id exists updates its name and locales; repeating a ' +
        '`sample` or `enterprise` create finishes an install that failed part-way without ' +
        'duplicating anything.',
      body: createSpaceBody,
      ok: spaceDocs.createdSpace,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createSpaceBody);
      // Acting as the caller, so the starter content is credited to them, as on MCP.
      const created = await createSpaceWithStarter(
        actingCtx(ctx, c),
        body,
        { blob },
        { allowEnterprise },
      );
      return c.json(
        {
          id: created.space.spaceId,
          name: created.space.name,
          starter: created.starter,
          ...(created.installed ? { installed: created.installed } : {}),
          ...(created.installing ? { installing: created.installing } : {}),
        },
        201,
      );
    },
  );
  // What a new space can start with here: the same check as creating one, since only a
  // deployment administrator is ever offered the choice.
  app.get(
    '/starters',
    doc('Spaces & environments', 'List the starters a new space can use', {
      ok: spaceDocs.starterList,
      description:
        'The starters `POST /spaces` accepts on this deployment, in the order a picker lists ' +
        'them: `sample` and `empty` everywhere, and `enterprise` (a large demo brand that ' +
        'installs in the background, `background: true`) where the deployment offers it. ' +
        'Deployment administrators only, as creating a space is.',
    }),
    requireScope(SCOPES.spaceAdmin),
    (c) => c.json({ items: availableStarters(allowEnterprise) }),
  );
  // A background starter's progress, read from the environment's bulk jobs (one per phase).
  app.get(
    `${BASE}/starter-installs/:install`,
    doc('Spaces & environments', 'Follow a starter install', {
      ok: spaceDocs.starterInstall,
      description:
        'Where a background starter install (the `installing.install` of `POST /spaces`) has ' +
        'got to: the phase running now (`step` of `steps`), and `status`: `running`, ' +
        '`completed` once the last phase finished cleanly, or `failed` when a phase finished ' +
        'with a failure or was stopped (the phases after it never start; `failures` says what ' +
        'went wrong, and creating the space again with the same starter finishes the install). ' +
        'Readable by any `content:write` caller, as bulk jobs are.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => c.json(await getStarterInstall(ctx, scopeOf(c), c.req.param('install'))),
  );

  app.get('/spaces/:space/environments', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironments(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, createEnvironmentBody);
    await createEnvironment(ctx, c.req.param('space'), body.id, body.name);
    return c.json({ id: body.id }, 201);
  });
  app.delete(
    '/spaces/:space/environments/:env',
    doc('Spaces & environments', 'Delete an environment and everything in it', {
      query: { confirm: 'The environment id again (required: deleting is irreversible)' },
      description:
        'Removes the environment, its content model, entries, versions, assets, releases, ' +
        'workflows and the rest (its audit history stays); search documents, vectors and the ' +
        'delivery cache are cleaned up asynchronously. Refuses `main` and any environment an ' +
        'alias points at (409).',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        await deleteEnvironment(ctx, c.req.param('space'), c.req.param('env'), {
          confirm: c.req.query('confirm'),
          principal: c.get('principal'),
        }),
      ),
  );

  return app;
}

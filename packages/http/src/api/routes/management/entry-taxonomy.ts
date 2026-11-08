import { getEntryMetadata, setEntryMetadata } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { entryMetadataBody, parseBody } from '../../validation';
import { BASE, entryAccess, scopeOf } from './shared';

export function entryTaxonomyRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- entry taxonomy associations ---------------------------------------
  app.get(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(
      (await getEntryMetadata(ctx, scopeOf(c), c.req.param('id'))) ?? { tags: [], concepts: [] },
    );
  });
  app.put(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await setEntryMetadata(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, entryMetadataBody),
      ),
    ),
  );

  return app;
}

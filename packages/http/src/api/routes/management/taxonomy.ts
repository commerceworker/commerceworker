import {
  createConcept,
  createScheme,
  createTag,
  deleteConcept,
  deleteScheme,
  deleteTag,
  listConceptsWithUsage,
  listSchemes,
  listTagsWithUsage,
  repairTaxonomy,
  setConceptBroader,
  updateConcept,
  updateTag,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as taxonomyDocs from '../../docs/schemas/taxonomy';
import {
  broaderBody,
  conceptBody,
  conceptPatchBody,
  parseBody,
  schemeBody,
  tagBody,
  tagPatchBody,
} from '../../validation';
import { BASE, scopeOf } from './shared';

export function taxonomyRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- taxonomy (controlled vocabulary) ----------------------------------
  app.get(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listSchemes(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createScheme(ctx, scopeOf(c), await parseBody(c, schemeBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/schemes/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteScheme(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(
    `${BASE}/taxonomy/concepts`,
    doc('Taxonomy', 'List concepts with their published usage', {
      ok: taxonomyDocs.conceptList,
      query: { scheme: 'Only this scheme’s concepts' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({ items: await listConceptsWithUsage(ctx, scopeOf(c), c.req.query('scheme')) }),
  );
  app.post(
    `${BASE}/taxonomy/concepts`,
    doc('Taxonomy', 'Create a concept', {
      status: 201,
      body: conceptBody,
      ok: taxonomyDocs.concept,
      description:
        'A slug is made from prefLabel when omitted (numbered past the scheme’s taken ones); a ' +
        'slug asked for that another concept of the scheme has is refused (409). labels must be ' +
        'locales of the space (422 otherwise).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => c.json(await createConcept(ctx, scopeOf(c), await parseBody(c, conceptBody)), 201),
  );
  app.patch(
    `${BASE}/taxonomy/concepts/:id`,
    doc('Taxonomy', 'Change a concept’s label, slug, description or localized labels', {
      body: conceptPatchBody,
      ok: taxonomyDocs.concept,
      description:
        'Only the keys sent change. The slug stays when the label changes (an archive URL ' +
        'never moves by itself); a slug another concept of the scheme has is refused (409).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await updateConcept(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, conceptPatchBody),
        ),
      ),
  );
  app.put(
    `${BASE}/taxonomy/concepts/:id/broader`,
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, broaderBody);
      return c.json(
        await setConceptBroader(ctx, scopeOf(c), c.req.param('id'), body.broaderId ?? null),
      );
    },
  );
  app.delete(`${BASE}/taxonomy/concepts/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteConcept(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(
    `${BASE}/taxonomy/tags`,
    doc('Taxonomy', 'List tags with their published usage', { ok: taxonomyDocs.tagList }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listTagsWithUsage(ctx, scopeOf(c)) }),
  );
  app.post(
    `${BASE}/taxonomy/tags`,
    doc('Taxonomy', 'Create a tag', {
      status: 201,
      body: tagBody,
      ok: taxonomyDocs.tag,
      description:
        'A slug is made from name when omitted (numbered past the taken ones); a slug asked for ' +
        'that another tag has is refused (409). labels must be locales of the space (422 ' +
        'otherwise).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => c.json(await createTag(ctx, scopeOf(c), await parseBody(c, tagBody)), 201),
  );
  app.patch(
    `${BASE}/taxonomy/tags/:id`,
    doc('Taxonomy', 'Change a tag’s name, slug, description or localized labels', {
      body: tagPatchBody,
      ok: taxonomyDocs.tag,
      description:
        'Only the keys sent change. The slug stays when the name changes (an archive URL never ' +
        'moves by itself); a slug another tag has is refused (409).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(await updateTag(ctx, scopeOf(c), c.req.param('id'), await parseBody(c, tagPatchBody))),
  );
  app.delete(`${BASE}/taxonomy/tags/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteTag(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.post(
    `${BASE}/taxonomy/repair`,
    doc('Taxonomy', 'Recount published usage and fill missing slugs', {
      ok: taxonomyDocs.taxonomyRepair,
      description:
        'Rebuilds the environment’s usage counts from its published entries and gives a slug ' +
        'to any term without one. Counts are kept as entries publish, so this only matters ' +
        'after something wrote snapshots without them; the engine runs it daily. Safe to repeat.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => c.json(await repairTaxonomy(ctx, scopeOf(c))),
  );

  return app;
}

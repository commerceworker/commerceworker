import {
  auditActor,
  createAssetShareLink,
  getAssetShareLink,
  listAssetShareLinks,
  revokeAssetShareLink,
} from '@commerceworker/application';
import { SCOPES, ValidationError } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as shareLinkDocs from '../../docs/schemas/share-links';
import { parseBody, shareLinkBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function shareLinksRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- share links ----------------------------------------------------------
  // A link opens published files to anyone holding it, so making, listing (the list carries the
  // URLs) and revoking one all need content:publish, as publishing does.
  app.get(
    `${BASE}/share-links`,
    doc('Assets', 'List share links', {
      ok: shareLinkDocs.shareLinkList,
      description: 'Newest first; active links only unless includeInactive=true.',
      query: {
        targetType: 'asset | collection',
        targetId: 'An asset or collection id',
        includeInactive: 'true to list expired and revoked links too',
      },
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const targetType = c.req.query('targetType');
      if (targetType !== undefined && targetType !== 'asset' && targetType !== 'collection') {
        throw new ValidationError([{ field: 'targetType', message: 'asset or collection' }]);
      }
      const targetId = c.req.query('targetId');
      return c.json({
        items: await listAssetShareLinks(ctx, scopeOf(c), {
          ...(targetType ? { targetType } : {}),
          ...(targetId ? { targetId } : {}),
          includeInactive: c.req.query('includeInactive') === 'true',
        }),
      });
    },
  );
  app.post(
    `${BASE}/share-links`,
    doc('Assets', 'Create a share link to an asset or a collection', {
      body: shareLinkBody,
      ok: shareLinkDocs.shareLink,
      status: 201,
      description:
        'A read-only page on the media origin listing what the target publishes now (never a ' +
        'draft), for anyone with the URL until it expires or is revoked. An asset must be ' +
        'published. With a password, the page asks for it first.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const body = await parseBody(c, shareLinkBody);
      return c.json(
        await createAssetShareLink(ctx, scopeOf(c), body, {
          createdBy: auditActor(c.get('principal')),
        }),
        201,
      );
    },
  );
  app.get(
    `${BASE}/share-links/:id`,
    doc('Assets', 'Get a share link', { ok: shareLinkDocs.shareLink }),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await getAssetShareLink(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(
    `${BASE}/share-links/:id`,
    doc('Assets', 'Revoke a share link', {
      ok: shareLinkDocs.shareLink,
      description:
        'It stops opening within a minute, and its cached page is purged. Revoking it again ' +
        'changes nothing.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await revokeAssetShareLink(ctx, scopeOf(c), c.req.param('id'))),
  );

  return app;
}

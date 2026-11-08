import {
  findDuplicates,
  getEntryEmbedding,
  moderateEntry,
  publishEntry,
  relatedEntries,
  requestReindex,
  searchIndexHealth,
  unpublishEntry,
} from '@commerceworker/application';
import { SCOPES, ValidationError } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as entryDocs from '../../docs/schemas/entries';
import { parseBody, reindexBody } from '../../validation';
import { actingCtx, BASE, entryAccess, expectedVersionOf, scopeOf } from './shared';

export function semanticsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, rag, agents } = deps;
  const { guardEntry } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- content semantics (vector-backed) ---------------------------------
  app.get(`${BASE}/entries/:id/related`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const topK = c.req.query('top_k');
    return c.json({
      items: await relatedEntries(rag, ctx, scopeOf(c), c.req.param('id'), {
        topK: topK ? Number(topK) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/duplicates`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const threshold = c.req.query('threshold');
    return c.json({
      items: await findDuplicates(rag, ctx, scopeOf(c), c.req.param('id'), {
        threshold: threshold ? Number(threshold) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/embedding`, requireScope(SCOPES.searchRead), async (c) =>
    c.json(
      await getEntryEmbedding(rag, ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
      }),
    ),
  );
  app.get(
    `${BASE}/search/index`,
    doc('AI & agents', 'Report lexical search index health', {
      description:
        'Compares the documents the SearchShard lexical index holds for this environment ' +
        'against the number of published entries. `bound: false` means the index is ' +
        "not bound and the lexical leg runs on the store's built-in term matching. A negative " +
        '`drift` means published entries are missing from the index; a positive one ' +
        'means it holds documents for entries that are no longer published. The remedy ' +
        'is POST search/reindex, which rewrites both the vector and lexical legs.',
    }),
    // content:manage, not search:read: a CDA token carries search:read and
    // ships in browsers, and this reports operational posture — how much is
    // published, and whether indexing has quietly stopped.
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await searchIndexHealth(ctx, scopeOf(c), rag?.searchIndex, {
          contentType: c.req.query('content_type'),
        }),
      ),
  );
  // Bulk re-embed the scope's published entries (e.g. after an extraction or
  // embedding-model change). Idempotent per entry; safe to re-run.
  app.post(
    `${BASE}/search/reindex`,
    doc('AI & agents', 'Request a reindex of all published entries', {
      body: reindexBody,
      status: 202,
      description:
        'Enqueues a background reindex (via the outbox → queue) that re-embeds every ' +
        'published entry in the environment (optionally one content type). Returns 202; ' +
        'the work runs on the worker. Rate-limited per scope (429 if requested too soon).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, reindexBody);
      const result = await requestReindex(ctx, scopeOf(c), {
        contentTypeApiId: body.contentTypeApiId,
      });
      return c.json(result, 202);
    },
  );
  app.post(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Publish an entry', {
      ok: entryDocs.entry,
      description:
        'Writes the delivery read model and appends entry.published to the transactional outbox atomically. ' +
        'Refused with 409 `publish_gated` when a workflow that gates publishing covers the entry: only a run of that workflow publishes it.',
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const id = c.req.param('id');
      await guardEntry(c, id, 'publish');
      // Optional synchronous pre-publish moderation gate: reject flagged content
      // before it ever reaches the delivery read model.
      //
      // SCOPE: this route only. Bulk publish, bulk jobs, release publish and
      // scheduled publishes deliberately do NOT gate — one inline model call
      // per entry is incompatible with their throughput — and rely on
      // post-publish moderation retracting a flagged entry instead. Do not
      // read this flag as "flagged content can never reach delivery".
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(actingCtx(ctx, c), agents, scopeOf(c), id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return c.json(await publishEntry(actingCtx(ctx, c), scopeOf(c), id, expectedVersionOf(c)));
    },
  );
  app.delete(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Unpublish an entry', {
      ok: entryDocs.entry,
      description:
        'A role needs `unpublish` on the type: it comes with `publish` unless the grant withholds it.',
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'unpublish');
      return c.json(
        await unpublishEntry(
          actingCtx(ctx, c),
          scopeOf(c),
          c.req.param('id'),
          expectedVersionOf(c),
        ),
      );
    },
  );

  return app;
}

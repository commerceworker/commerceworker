import { listDocs, readDoc, searchDocs } from '@commerceworker/docs-index';
import { NotFoundError } from '@commerceworker/domain';
import { Hono } from 'hono';
import type { AuthVars } from '../../auth';
import { doc } from '../../docs/openapi';

export function docsRoutes(): Hono<AuthVars> {
  const app = new Hono<AuthVars>();

  // --- documentation ------------------------------------------------------
  app.get(
    '/guides',
    doc('Guides', 'List documentation pages', {
      description:
        "Lists commerceworker's documentation pages with their headings and sizes, so a " +
        'client can find which page covers a topic before reading it. Requires any valid ' +
        'token; there is no space in the path and nothing space-specific in the response.',
    }),
    async (c) => c.json({ items: listDocs() }),
  );
  app.get(
    '/guides/search',
    doc('Guides', 'Search the documentation', {
      description:
        'Full-text search across every page (`q`, optional `path` and `limit`). Every term ' +
        'must appear on the same line. Each match names the page, the nearest heading above ' +
        'it, and the line, so a hit can be followed with a section read.',
    }),
    async (c) => {
      const limit = Number(c.req.query('limit'));
      return c.json({
        items: searchDocs(c.req.query('q') ?? '', {
          path: c.req.query('path'),
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      });
    },
  );
  app.get(
    '/guides/:path',
    doc('Guides', 'Read a documentation page', {
      description:
        'Returns one page as Markdown, or one section of it when `section` names a heading ' +
        'slug from the listing — that heading down to the next of the same level.',
    }),
    async (c) => {
      const path = c.req.param('path');
      const section = c.req.query('section');
      const body = readDoc(path, { section });
      if (body === undefined) throw new NotFoundError('Documentation page', section ?? path);
      return c.json({ path, section, body });
    },
  );

  return app;
}

import { listDocs, readDoc, searchDocs } from '@commerceworker/docs-index';
import { NotFoundError } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, toolSchema } from './shared';

export function registerDocsTools(server: McpServer): void {
  // --- documentation ------------------------------------------------------
  // No scope guard and no space: these serve the product's own published
  // documentation, which is identical for every space and discloses nothing
  // about anyone's content. Being authenticated at all is the gate.
  server.registerTool(
    'docs_list',
    {
      description:
        "List commerceworker's documentation pages with their headings and sizes. Start here to " +
        'find which page covers a topic, then docs_read that page or one section of it. ' +
        'Use these tools before guessing at conventions: scopes, ids, locales and the ' +
        'publish model all have specific rules that the docs state exactly.',
      inputSchema: toolSchema('docs_list', () => z.object({})),
      annotations: { readOnlyHint: true },
    },
    async () => ok(listDocs()),
  );

  server.registerTool(
    'docs_read',
    {
      description:
        'Read one documentation page, or one section of it. `section` takes a heading slug from ' +
        'docs_list and returns that heading down to the next one of the same level — prefer it ' +
        'for the larger pages rather than reading tens of KB into context.',
      inputSchema: toolSchema('docs_read', () =>
        z.object({ path: z.string(), section: z.string().optional() }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const body = readDoc(args.path, { section: args.section });
      if (body === undefined) {
        throw new NotFoundError('Documentation page', args.section ?? args.path);
      }
      return ok({ path: args.path, section: args.section, body });
    },
  );

  server.registerTool(
    'docs_search',
    {
      description:
        'Full-text search across the documentation. Every term must appear on the same line. ' +
        'Returns the page, the nearest heading above the match, and the matching line, so a ' +
        'hit can be followed with docs_read on just that section.',
      inputSchema: toolSchema('docs_search', () =>
        z.object({
          query: z.string(),
          path: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(searchDocs(args.query, { path: args.path, limit: args.limit })),
  );
}

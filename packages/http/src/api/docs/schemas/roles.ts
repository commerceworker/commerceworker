import { z } from 'zod';

export const contentGrant = z.object({
  contentTypeApiId: z.string().describe("A content type's apiId, or '*' for every type"),
  actions: z
    .array(z.enum(['read', 'write', 'publish']))
    .describe('`write` also grants `delete`; `publish` also grants `delete` and `unpublish`'),
  deniedActions: z
    .array(z.enum(['delete', 'unpublish']))
    .optional()
    .describe(
      'Finer actions the grant withholds. Trashing needs `write` and `delete`, purging ' +
        '`publish` and `delete`, unpublishing `unpublish`',
    ),
  deniedFields: z.array(z.string()).optional().describe('Masked on read, refused on write'),
  readOnlyFields: z.array(z.string()).optional().describe('Readable, refused on write'),
});

export const role = z.object({
  id: z.uuid(),
  spaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  scopes: z.array(z.string()).describe('Permission scopes, e.g. content:write'),
  contentGrants: z.array(contentGrant),
  preset: z
    .enum(['viewer', 'approver', 'editor', 'manager', 'admin'])
    .optional()
    .describe('Set on the built-in roles seeded into every space'),
});

export const roleList = z.object({ items: z.array(role) });

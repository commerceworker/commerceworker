import { z } from 'zod';

// --- audit log --------------------------------------------------------------

const entryChange = z.object({
  entryId: z.string(),
  contentType: z.string().describe('The content type’s api id'),
  kind: z.enum(['created', 'updated']),
  version: z.number().int().describe('The version the write made'),
  paths: z
    .array(z.string())
    .describe(
      'The content model’s paths that changed: `fields.title`, `fields.hero.alt`, ' +
        '`fields.sections[].heading` for an element of a list. Rich text and JSON stop at the field',
    ),
  locales: z.array(z.string()).describe('The space’s locales the change touched'),
  undeclaredFields: z
    .number()
    .int()
    .optional()
    .describe('How many fields the type no longer declares changed; they are not named'),
});

const auditDetail = z.object({
  entries: z.array(entryChange).describe('The entries the action saved'),
  truncated: z
    .literal(true)
    .optional()
    .describe('Some of what changed is not listed: the row reached its size or entry cap'),
});

export const auditEntry = z.object({
  id: z.string(),
  spaceId: z.string(),
  environmentId: z.string().optional().describe('The environment acted in, when it was scoped'),
  actor: z.string().describe('A person’s id, admin-token, or the kind of key'),
  action: z.string().describe('`<METHOD> <route>` for REST, `MCP <tool>` for a tool call'),
  targetType: z
    .string()
    .optional()
    .describe('The kind of thing acted on (entry, release, content_type, …)'),
  targetId: z.string().optional(),
  status: z.number().int().describe('The action’s result status'),
  at: z.iso.datetime(),
  detail: auditDetail
    .optional()
    .describe('What the action changed: paths and never values. Older rows have none'),
});

export const auditLogPage = z.object({
  items: z.array(auditEntry),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass back as cursor for the next page; absent on the last one'),
});

/** An entry's activity: the audit log's page, its rows the ones about that entry. */
export const entryActivityPage = auditLogPage;

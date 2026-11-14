import {
  createConcept,
  createScheme,
  createTag,
  getDeliveredConcept,
  getDeliveredTag,
  listConceptsWithUsage,
  listTagsWithUsage,
  repairTaxonomy,
  scheduleAction,
  setEntryMetadata,
  updateConcept,
  updateTag,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerTaxonomyTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, guard } = t;
  // --- taxonomy ----------------------------------------------------------
  // What a tag or concept carries beside its label (the HTTP bodies' fields).
  const termArgs = {
    slug: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('URL slug (a-z, 0-9, hyphens); made from the label when omitted on create'),
    description: z.string().max(2000).nullable().optional().describe('Plain text; null clears'),
    labels: z
      .record(z.string(), z.string().max(256))
      .optional()
      .describe(
        'Labels by locale (the whole set; each a locale of the space). The default locale’s ' +
          'sets the term’s own label; an empty value removes that locale’s label',
      ),
  };
  const termFieldsOf = (args: {
    slug?: string | undefined;
    description?: string | null | undefined;
    labels?: Record<string, string> | undefined;
  }) => ({
    ...(args.slug !== undefined ? { slug: args.slug } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.labels !== undefined ? { labels: args.labels } : {}),
  });
  const termLookupArgs = {
    slug: z.string().min(1).max(200),
    locale: z.string().optional().describe('Resolve the label for one locale (with fallbacks)'),
    contentType: z.string().optional().describe('Count published entries of this type only'),
  };

  server.registerTool(
    'taxonomy_list_tags',
    {
      description:
        'List the flat tags defined in a space/environment, each with its slug, description, ' +
        'localized labels and published usage (how many published entries carry it, in all and ' +
        'per content type).',
      inputSchema: toolSchema('taxonomy_list_tags', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTagsWithUsage(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'taxonomy_get_tag',
    {
      description:
        'Get a tag by its slug, as Delivery serves it: label (resolved for locale), description ' +
        'and published usage counts.',
      inputSchema: toolSchema('taxonomy_get_tag', () =>
        z.object({ ...termLookupArgs, ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await getDeliveredTag(ctx, scopeOf(args), args.slug, {
          ...(args.locale !== undefined ? { locale: args.locale } : {}),
          ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'taxonomy_create_tag',
    {
      description:
        'Create a flat tag. Its slug is made from the name unless given (a given slug another ' +
        'tag has is a conflict).',
      inputSchema: toolSchema('taxonomy_create_tag', () =>
        z.object({ name: z.string(), ...termArgs, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createTag(ctx, scopeOf(args), { name: args.name, ...termFieldsOf(args) }));
    },
  );

  server.registerTool(
    'taxonomy_update_tag',
    {
      description:
        'Change a tag’s name, slug, description or localized labels; only the arguments given ' +
        'change. The slug stays when the name changes.',
      inputSchema: toolSchema('taxonomy_update_tag', () =>
        z.object({ id: z.string(), name: z.string().optional(), ...termArgs, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await updateTag(ctx, scopeOf(args), args.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...termFieldsOf(args),
        }),
      );
    },
  );

  server.registerTool(
    'taxonomy_create_scheme',
    {
      description: 'Create a concept scheme (a controlled vocabulary).',
      inputSchema: toolSchema('taxonomy_create_scheme', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createScheme(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.registerTool(
    'taxonomy_list_concepts',
    {
      description:
        'List concepts, optionally limited to one scheme, each with its slug, description, ' +
        'localized labels and published usage counts.',
      inputSchema: toolSchema('taxonomy_list_concepts', () =>
        z.object({ scheme: z.string().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listConceptsWithUsage(ctx, scopeOf(args), args.scheme));
    },
  );

  server.registerTool(
    'taxonomy_get_concept',
    {
      description:
        'Get a concept by its slug, as Delivery serves it. A slug is unique within a scheme: ' +
        'pass scheme when two schemes share it.',
      inputSchema: toolSchema('taxonomy_get_concept', () =>
        z.object({ ...termLookupArgs, scheme: z.string().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await getDeliveredConcept(ctx, scopeOf(args), args.slug, {
          ...(args.scheme !== undefined ? { schemeId: args.scheme } : {}),
          ...(args.locale !== undefined ? { locale: args.locale } : {}),
          ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'taxonomy_create_concept',
    {
      description:
        'Create a concept within a scheme, optionally nested under a broader concept. Its slug ' +
        'is made from prefLabel unless given (unique within the scheme).',
      inputSchema: toolSchema('taxonomy_create_concept', () =>
        z.object({
          schemeId: z.string(),
          prefLabel: z.string(),
          broaderId: z.string().optional(),
          ...termArgs,
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createConcept(ctx, scopeOf(args), {
          schemeId: args.schemeId,
          prefLabel: args.prefLabel,
          broaderId: args.broaderId,
          ...termFieldsOf(args),
        }),
      );
    },
  );

  server.registerTool(
    'taxonomy_update_concept',
    {
      description:
        'Change a concept’s prefLabel, slug, description or localized labels; only the ' +
        'arguments given change. The slug stays when the label changes.',
      inputSchema: toolSchema('taxonomy_update_concept', () =>
        z.object({ id: z.string(), prefLabel: z.string().optional(), ...termArgs, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await updateConcept(ctx, scopeOf(args), args.id, {
          ...(args.prefLabel !== undefined ? { prefLabel: args.prefLabel } : {}),
          ...termFieldsOf(args),
        }),
      );
    },
  );

  server.registerTool(
    'taxonomy_repair',
    {
      description:
        'Recount the environment’s published usage counts from its published entries and give ' +
        'a slug to any term without one. Counts are kept as entries publish; the engine runs ' +
        'this daily. Safe to repeat.',
      inputSchema: toolSchema('taxonomy_repair', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await repairTaxonomy(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'entries_set_metadata',
    {
      description:
        "Set an entry's taxonomy associations (tag ids + concept ids). Takes effect " +
        'on the next publish.',
      inputSchema: toolSchema('entries_set_metadata', () =>
        z.object({
          entryId: z.string(),
          tags: z.array(z.string()).optional(),
          concepts: z.array(z.string()).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setEntryMetadata(ctx, scopeOf(args), args.entryId, {
          tags: args.tags,
          concepts: args.concepts,
        }),
      );
    },
  );

  server.registerTool(
    'schedule_action',
    {
      description:
        "Schedule a publish/unpublish of an entry or release for a future ISO-8601 instant. A publish a gated workflow covers is refused (publish_gated) now, and fails if gating is on when it fires. Your role must grant the action on the entry's type (or every release member's).",
      inputSchema: toolSchema('schedule_action', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          entityType: z.enum(['Entry', 'Release']),
          entityId: z.string(),
          scheduledFor: z.string().describe('ISO-8601 instant'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await scheduleAction(
          ctx,
          scopeOf(args),
          {
            action: args.action,
            entityType: args.entityType,
            entityId: args.entityId,
            scheduledFor: args.scheduledFor,
          },
          { principal: t.principal },
        ),
      );
    },
  );
}

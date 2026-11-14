import {
  authorizeBulkJob,
  cloneContentType,
  contentTypeDependents,
  createContentType,
  createEntry,
  createPreviewLink,
  deleteContentType,
  deleteContentTypeWithEntries,
  getPreviewEntry,
  moderateEntry,
  moveEntry,
  publishContentType,
  publishEntry,
  unpublishEntry,
  updateEntry,
  validateEntry,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  CONTENT_TYPE_LIMITS,
  type EntryFields,
  MAX_PREVIEW_TEMPLATE_LENGTH,
  MAX_URL_PATTERN_LENGTH,
  maskDeniedFields,
  SCOPES,
  unwritableFieldsFor,
  ValidationError,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { entryFields, fieldSchema, ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerWriteTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, agents, principal, guard, guardEntry } = t;
  // --- write -------------------------------------------------------------
  server.registerTool(
    'model_create_content_type',
    {
      description:
        'Create or update a content type definition. A field can carry guidance for whoever ' +
        'fills it: `description` (what it means), `help` (how to fill it, shown under the ' +
        'input), `placeholder` (an example), labelled options in `validations.in` as ' +
        '{ value, label }, and `validations.messages` to replace a rule’s default error text. ' +
        '`rules` hide or disable a field while a sibling matches: a hidden field is not ' +
        'required, and a disabled one keeps its stored value. The type can carry a `group` and ' +
        '`icon` (how the admin lists it), a `description`, an editor-only `layout` of tabs ' +
        'and field groups for the entry form, and a `preview` URL template for the frontend ' +
        'the admin previews entries on.',
      inputSchema: toolSchema('model_create_content_type', () =>
        z.object({
          apiId: z.string(),
          name: z.string(),
          displayField: z.string(),
          fields: z.array(fieldSchema),
          urlPattern: z
            .string()
            .max(MAX_URL_PATTERN_LENGTH)
            .nullable()
            .optional()
            .describe(
              'where its entries live on the site, e.g. /blog/{slug} ({id}, {locale} or a Slug ' +
                'field); a publish that changes the slug redirects the old path. null clears it',
            ),
          singleton: z
            .boolean()
            .optional()
            .describe(
              'holds at most one entry (site settings, a home page), read with singleton_get; ' +
                'refused while the type has more than one entry. Left out, unchanged',
            ),
          group: z
            .string()
            .max(CONTENT_TYPE_LIMITS.group)
            .nullable()
            .optional()
            .describe('the admin sidebar lists types under their group; null clears it'),
          description: z
            .string()
            .max(CONTENT_TYPE_LIMITS.description)
            .nullable()
            .optional()
            .describe('what the type is for, for editors and agents; null clears it'),
          icon: z
            .string()
            .max(CONTENT_TYPE_LIMITS.icon)
            .nullable()
            .optional()
            .describe('a kebab-case icon name the admin draws, e.g. newspaper; null clears it'),
          agentInstructions: z
            .string()
            .max(CONTENT_TYPE_LIMITS.agentInstructions)
            .nullable()
            .optional()
            .describe(
              'how an agent should write entries of this type, in plain text; never delivered; ' +
                'null clears it',
            ),
          layout: z
            .record(z.string(), z.any())
            .nullable()
            .optional()
            .describe(
              'editor-only entry form layout, never delivered: { tabs: [{ apiId, name, groups: ' +
                '[{ name?, fields: [top-level field apiIds], collapsed? }] }] }; each field ' +
                'placed at most once, unplaced fields follow on the first tab; null clears it',
            ),
          preview: z
            .object({ urlTemplate: z.string().max(MAX_PREVIEW_TEMPLATE_LENGTH) })
            .nullable()
            .optional()
            .describe(
              'editor-only, never delivered: where the admin previews entries on the frontend. ' +
                'urlTemplate is an https URL (http to localhost on a local stack only) with a fixed ' +
                'host, e.g. https://site.example/__preview?entry={id}#token={token}; ' +
                'placeholders {id}, {token} (required), {locale}, {space}, {environment}, ' +
                '{field:<apiId>} (a Symbol, Slug, Integer, Number or Date field), filled ' +
                'URL-encoded; null clears it',
            ),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createContentType(ctx, principal, scopeOf(args), {
          apiId: args.apiId,
          name: args.name,
          displayField: args.displayField,
          ...(args.urlPattern !== undefined ? { urlPattern: args.urlPattern } : {}),
          ...(args.singleton !== undefined ? { singleton: args.singleton } : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.icon !== undefined ? { icon: args.icon } : {}),
          ...(args.agentInstructions !== undefined
            ? { agentInstructions: args.agentInstructions }
            : {}),
          // biome-ignore lint/suspicious/noExplicitAny: zod record → domain ContentTypeLayout, checked there
          ...(args.layout !== undefined ? { layout: args.layout as any } : {}),
          ...(args.preview !== undefined ? { preview: args.preview } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: zod field shape → domain FieldDefinition
          fields: args.fields as any,
        }),
      );
    },
  );

  server.registerTool(
    'model_publish_content_type',
    {
      description:
        'Publish a content type: its current definition becomes what Delivery serves (GraphQL, ' +
        'routes, sitemap, menus). Until then a live type keeps serving its last published ' +
        'definition; a type never published is left out of routes, sitemap and menus, but ' +
        'GraphQL already serves it. Entries can be written and published either way.',
      inputSchema: toolSchema('model_publish_content_type', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_content_type_dependents',
    {
      description:
        'What depends on a content type, so why model_delete_content_type would refuse it: its ' +
        'entries (live and in the trash), other types whose links are restricted to it, menus ' +
        'and slug redirects naming its entries, and its URL pattern.',
      inputSchema: toolSchema('model_content_type_dependents', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      authorizeContent(principal, 'read', args.apiId);
      return ok(await contentTypeDependents(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_delete_content_type',
    {
      description:
        'Delete a content type. Refused, naming every reason, while anything depends on it (see ' +
        'model_content_type_dependents). purgeEntries: true deletes its entries too, as a ' +
        'resumable bulk job (each trashed, then purged; needs content:write and content:publish; ' +
        'follow it with bulk_job_status): the type goes when the job completes cleanly, and the ' +
        "job's config.typeDeletion then says { deleted: true } or { deleted: false, reason }. " +
        'Answers { deleted } and, for a job, { job }.',
      inputSchema: toolSchema('model_delete_content_type', () =>
        z.object({
          apiId: z.string(),
          purgeEntries: z
            .boolean()
            .optional()
            .describe('delete its entries (the trash included) first, as a job'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      if (!args.purgeEntries) {
        await deleteContentType(ctx, scopeOf(args), args.apiId);
        return ok({ deleted: true });
      }
      guard(SCOPES.contentWrite, scopeOf(args));
      guard(SCOPES.contentPublish, scopeOf(args));
      authorizeBulkJob(principal, 'content_type_delete');
      return ok(await deleteContentTypeWithEntries(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_clone_content_type',
    {
      description:
        'Copy a content type’s definition (fields, display field, singleton, group, description, ' +
        'icon, agent instructions, layout, preview URL) under a new apiId and name, as a draft with no ' +
        'entries. Not its URL ' +
        'pattern.',
      inputSchema: toolSchema('model_clone_content_type', () =>
        z.object({
          apiId: z.string().describe('the type to copy'),
          newApiId: z.string(),
          name: z.string(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await cloneContentType(ctx, principal, scopeOf(args), args.apiId, args.newApiId, args.name),
      );
    },
  );

  server.registerTool(
    'entries_create',
    {
      description: 'Create a draft entry. Fields are validated against the content model.',
      inputSchema: toolSchema('entries_create', () =>
        z.object({ contentType: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      authorizeContent(principal, 'write', args.contentType);
      assertWritableFields(principal, args.contentType, args.fields ?? {});
      return ok(
        await createEntry(ctx, scopeOf(args), {
          contentTypeApiId: args.contentType,
          fields: args.fields as EntryFields,
        }),
      );
    },
  );

  server.registerTool(
    'entries_update',
    {
      description: 'Save new field values as a new draft version of an entry.',
      inputSchema: toolSchema('entries_update', () =>
        z.object({ id: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      let unwritable: readonly string[] = [];
      if (principal.contentGrants) {
        const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
        authorizeContent(principal, 'write', entry.contentType);
        assertWritableFields(principal, entry.contentType, args.fields ?? {});
        unwritable = unwritableFieldsFor(principal, entry.contentType);
      }
      const saved = await updateEntry(ctx, scopeOf(args), args.id, args.fields as EntryFields, {
        unwritable,
      });
      // The save kept the fields this writer may not write; the ones it may not read stay hidden.
      return ok({
        ...saved,
        fields: maskDeniedFields(principal, saved.entry.contentTypeApiId, saved.fields),
      });
    },
  );

  server.registerTool(
    'entries_validate',
    {
      description:
        'Validate entry fields without saving: exactly the checks entries_create (with ' +
        'contentType) or entries_update (with id) would make, failing with the same errors. ' +
        'Writes nothing. Answers the fields as they would be stored, and skippedHooks: plugins ' +
        'that hold capabilities and so did not run (a real save may still rewrite or refuse).',
      inputSchema: toolSchema('entries_validate', () =>
        z
          .object({
            contentType: z.string().optional().describe('Validate as a new entry of this type'),
            id: z.string().optional().describe('Validate as a new version of this entry'),
            fields: entryFields,
            ...scopeArgs,
          })
          .refine((a) => (a.contentType === undefined) !== (a.id === undefined), {
            message: 'Give contentType (a new entry) or id (a new version), not both',
          }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const fields = (args.fields ?? {}) as EntryFields;
      if (args.id !== undefined) {
        let unwritable: readonly string[] = [];
        let type = '';
        if (principal.contentGrants) {
          const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
          type = entry.contentType;
          authorizeContent(principal, 'write', type);
          assertWritableFields(principal, type, fields);
          unwritable = unwritableFieldsFor(principal, type);
        }
        const result = await validateEntry(
          ctx,
          scopeOf(args),
          { entryId: args.id, fields },
          { unwritable },
        );
        // Judged with the stored values of the fields this writer may not write; answered without
        // the ones it may not read.
        return ok({ ...result, fields: maskDeniedFields(principal, type, result.fields) });
      }
      const contentTypeApiId = args.contentType ?? '';
      authorizeContent(principal, 'write', contentTypeApiId);
      assertWritableFields(principal, contentTypeApiId, fields);
      return ok(await validateEntry(ctx, scopeOf(args), { contentTypeApiId, fields }));
    },
  );

  server.registerTool(
    'entries_move',
    {
      description:
        "Move an entry in its content type's manual order (what order=sys.position sorts by): " +
        'right after another entry of the same type (after: id, or null for first) or right ' +
        'before one (before: id, or null for last); send exactly one. Live, like a menu: no new ' +
        "version and no publish, and Delivery serves a published entry's new place at once. " +
        'Needs write on the type.',
      inputSchema: toolSchema('entries_move', () =>
        z.object({
          id: z.string(),
          after: z.string().nullable().optional().describe('Place it right after this entry'),
          before: z.string().nullable().optional().describe('Place it right before this entry'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      if ((args.after === undefined) === (args.before === undefined)) {
        throw new ValidationError([
          { field: 'after', message: 'Send exactly one of after and before' },
        ]);
      }
      const place =
        args.after !== undefined ? { after: args.after } : { before: args.before ?? null };
      return ok(await moveEntry(ctx, scopeOf(args), args.id, place));
    },
  );

  server.registerTool(
    'entries_preview_link',
    {
      description:
        'Mint an expiring preview link for one entry (default 72 hours): a token that reads ' +
        'that entry, drafts included, returned once. `url` is the entry on the Preview API ' +
        '(`previewPath` instead, a path, when the deployment has no public origin); ' +
        'when its content type has a preview URL template, `frontendUrl` is the entry on the ' +
        'site, in `locale` (the space default if absent). Share it only with whoever should see ' +
        'the draft. Needs content:write and read on the entry.',
      inputSchema: toolSchema('entries_preview_link', () =>
        z.object({
          id: z.string(),
          ttlHours: z.number().positive().max(8760).optional(),
          locale: z.string().min(1).max(35).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'read');
      const link = await createPreviewLink(ctx, deps.hasher, scopeOf(args), args.id, {
        ...(args.ttlHours !== undefined ? { ttlHours: args.ttlHours } : {}),
        ...(args.locale !== undefined ? { locale: args.locale } : {}),
        // The admin fronts the Preview API, as the HTTP route's caller (its Origin) does.
        previewBaseUrl: deps.inviteOrigin ?? '',
      });
      if (deps.inviteOrigin) return ok(link);
      // No public origin is configured (OAUTH_ISSUER unset): a relative URL would read as a link
      // to nowhere, so only the path is returned, named as one.
      const { url, ...rest } = link;
      return ok({ ...rest, previewPath: url });
    },
  );

  server.registerTool(
    'entries_publish',
    {
      description:
        'Publish an entry (validates references; emits an entry.published event). Refused (publish_gated) when a workflow that gates publishing covers the entry: only a run of that workflow publishes it.',
      inputSchema: toolSchema('entries_publish', () =>
        z.object({
          id: z.string(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(ctx, agents, scopeOf(args), args.id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return ok(
        await publishEntry(ctx, scopeOf(args), args.id, { expectedVersion: args.expectedVersion }),
      );
    },
  );

  server.registerTool(
    'entries_unpublish',
    {
      description:
        'Withdraw an entry from the Delivery API. A role needs unpublish on the type, which ' +
        'comes with publish unless its grant withholds it.',
      inputSchema: toolSchema('entries_unpublish', () =>
        z.object({
          id: z.string(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'unpublish');
      return ok(
        await unpublishEntry(ctx, scopeOf(args), args.id, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );
}

import {
  applyEntryTags,
  auditEntry,
  authorizeBulkJob,
  authorizeBulkJobAccess,
  authorizeSetFieldsJob,
  autofillField,
  BULK_JOB_MAX_ITEMS,
  bulkEntryAction,
  cancelBulkJob,
  getBulkJob,
  getBulkJobReport,
  listBulkJobs,
  moderateEntry,
  startBulkJob,
  startSetFieldsJob,
  suggestEntryTags,
  summarizeEntry,
  translateEntry,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { setFieldsJobBody } from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerAiContentTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, ai, agents, principal, guard, guardEntry } = t;
  // --- AI content operations over an entry -------------------------------
  server.registerTool(
    'entry_translate',
    {
      description:
        'Translate an entry’s localized text fields into a target locale; ' +
        'apply=true saves a new draft version.',
      inputSchema: toolSchema('entry_translate', () =>
        z.object({
          id: z.string(),
          targetLocale: z.string(),
          sourceLocale: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await translateEntry(ctx, ai, scopeOf(args), args.id, {
          targetLocale: args.targetLocale,
          sourceLocale: args.sourceLocale,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_summarize',
    {
      description: 'Summarize an entry’s text content; apply=true writes it to targetField.',
      inputSchema: toolSchema('entry_summarize', () =>
        z.object({
          id: z.string(),
          locale: z.string().optional(),
          maxWords: z.number().int().positive().optional(),
          targetField: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await summarizeEntry(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          maxWords: args.maxWords,
          targetField: args.targetField,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_autofill_field',
    {
      description:
        'Generate a value for one scalar field from the entry’s other fields; ' +
        'apply=true saves it. Validated against the content model.',
      inputSchema: toolSchema('entry_autofill_field', () =>
        z.object({
          id: z.string(),
          field: z.string(),
          locale: z.string().optional(),
          instructions: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await autofillField(ctx, ai, scopeOf(args), args.id, {
          field: args.field,
          locale: args.locale,
          instructions: args.instructions,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_suggest_tags',
    {
      description:
        'Suggest taxonomy tags for an entry (matching the vocabulary, proposing ' +
        'new names); apply=true creates + assigns them.',
      inputSchema: toolSchema('entry_suggest_tags', () =>
        z.object({ id: z.string(), apply: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await suggestEntryTags(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  server.registerTool(
    'entry_apply_tags',
    {
      description:
        'Persist a reviewed tag suggestion exactly as approved: assigns the given ' +
        'existing-tag ids and creates the given new tag names (no model re-run).',
      inputSchema: toolSchema('entry_apply_tags', () =>
        z.object({
          id: z.string(),
          tagIds: z.array(z.string().max(128)).max(1000).optional(),
          newTags: z.array(z.string().max(256)).max(100).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await applyEntryTags(ctx, scopeOf(args), args.id, {
          tagIds: args.tagIds,
          newTags: args.newTags,
        }),
      );
    },
  );

  server.registerTool(
    'entry_audit',
    {
      description:
        'Audit an entry for gaps/inconsistencies/quality issues. createTasks=true ' +
        'emits a work-package task per finding at/above taskSeverity.',
      inputSchema: toolSchema('entry_audit', () =>
        z.object({
          id: z.string(),
          createTasks: z.boolean().optional(),
          taskSeverity: z.enum(['info', 'warning', 'error']).optional(),
          assignee: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await auditEntry(ctx, ai, scopeOf(args), args.id, {
          createTasks: args.createTasks,
          taskSeverity: args.taskSeverity,
          assignee: args.assignee,
        }),
      );
    },
  );

  server.registerTool(
    'entry_moderate',
    {
      description:
        'Run the moderation agent against an entry: classifies its text and ' +
        'records a hold when flagged (flagged=true); no state change is made.',
      inputSchema: toolSchema('entry_moderate', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await moderateEntry(ctx, agents, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_bulk_action',
    {
      description:
        'Publish or unpublish many entries in one call; returns a per-item summary (an entry a gated workflow covers fails as its own item).',
      inputSchema: toolSchema('entries_bulk_action', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          ids: z.array(z.string()),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      for (const id of args.ids) await guardEntry(scopeOf(args), id, args.action);
      return ok(await bulkEntryAction(ctx, scopeOf(args), args.action, args.ids));
    },
  );

  // Start/cancel/report take a role holding the job's actions on every content type alike
  // (`authorizeBulkJob`): per-item RBAC guards are impractical at bulk cardinality, and reports
  // expose entry ids across all content types; an import job goes by what it reached
  // (`authorizeBulkJobAccess`). The API routes' rule exactly.
  const guardJob = async (id: string, s: ReturnType<typeof scopeOf>, access: 'report' | 'cancel') =>
    authorizeBulkJobAccess(principal, await getBulkJob(ctx, s, id), access);

  server.registerTool(
    'bulk_job_start',
    {
      description:
        'Start a durable bulk job over a large entry-id set: publish, unpublish, trash, ' +
        'restore, or purge (permanent: only entries already in the trash, never one that ' +
        'published entries link to). Processed in chunks on the queue; poll bulk_job_status ' +
        'for progress and bulk_job_report for the per-item compliance report.',
      inputSchema: toolSchema('bulk_job_start', () =>
        z.object({
          action: z.enum(['publish', 'unpublish', 'trash', 'restore', 'purge']),
          entryIds: z.array(z.string()).min(1).max(BULK_JOB_MAX_ITEMS),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      authorizeBulkJob(principal, args.action);
      return ok(
        await startBulkJob(ctx, scopeOf(args), {
          action: args.action,
          entryIds: args.entryIds,
        }),
      );
    },
  );

  server.registerTool(
    'bulk_job_set_fields',
    {
      description:
        'Start a durable bulk job that sets the same field values on many entries of one ' +
        'content type, each saved as a new draft with the checks an edit makes (validation, ' +
        'field rules, plugins). fields is field apiId → locale → value; only the fields and ' +
        'locales sent change, and null clears a locale. Unknown fields or locales and unique ' +
        'fields are refused up front; an entry that refuses its save, is missing or is of ' +
        'another type is a failure in bulk_job_report. Needs write on the type and every field ' +
        'sent. Poll bulk_job_status for progress.',
      inputSchema: toolSchema('bulk_job_set_fields', () =>
        // The route's body, so the two surfaces take the same input.
        z.object({ ...setFieldsJobBody.shape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      authorizeSetFieldsJob(principal, args.contentTypeApiId, args.fields);
      return ok(
        await startSetFieldsJob(ctx, scopeOf(args), {
          contentTypeApiId: args.contentTypeApiId,
          entryIds: args.entryIds,
          fields: args.fields,
        }),
      );
    },
  );

  server.registerTool(
    'bulk_job_status',
    {
      description:
        'Get a bulk job (status, chunk progress, succeeded/failed counts), or list recent jobs when no id is given.',
      inputSchema: toolSchema('bulk_job_status', () =>
        z.object({ id: z.string().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(
        // content:write, as GET …/bulk/jobs, so whoever may start a job (an import, a field edit)
        // can follow it; or content:publish, which these tools took before.
        principal.scopes.includes(SCOPES.contentWrite)
          ? SCOPES.contentWrite
          : SCOPES.contentPublish,
        scopeOf(args),
      );
      return ok(
        args.id
          ? await getBulkJob(ctx, scopeOf(args), args.id)
          : await listBulkJobs(ctx, scopeOf(args)),
      );
    },
  );

  server.registerTool(
    'bulk_job_report',
    {
      description:
        'Per-chunk completion report for a bulk job, including every per-item failure (compliance evidence).',
      inputSchema: toolSchema('bulk_job_report', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(
        // content:write, as GET …/bulk/jobs, so whoever may start a job (an import, a field edit)
        // can follow it; or content:publish, which these tools took before.
        principal.scopes.includes(SCOPES.contentWrite)
          ? SCOPES.contentWrite
          : SCOPES.contentPublish,
        scopeOf(args),
      );
      await guardJob(args.id, scopeOf(args), 'report');
      return ok(await getBulkJobReport(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'bulk_job_cancel',
    {
      description:
        'Cancel a running bulk job: pending chunks are skipped; in-flight chunks finish. Idempotent.',
      inputSchema: toolSchema('bulk_job_cancel', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardJob(args.id, scopeOf(args), 'cancel');
      return ok(
        await cancelBulkJob(ctx, scopeOf(args), args.id, deps.blob ? { blob: deps.blob } : {}),
      );
    },
  );
}

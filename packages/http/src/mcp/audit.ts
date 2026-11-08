import {
  type AppContext,
  auditActor,
  createdEntryOf,
  recordAudit,
} from '@commerceworker/application';
import type { AuditDetail, Principal } from '@commerceworker/domain';

/**
 * The MCP half of the audit trail. REST's `auditMiddleware` records every successful mutating
 * request; a tool call is the same capability reached another way, so a tool that changed
 * something records the same row: who, what, which space and environment, which target. The
 * action is `MCP <tool>` where REST's is `<METHOD> <route>`.
 *
 * Reads never write here (one writer per database: no per-request writes on read paths). A tool
 * is a read when it declares so itself, with the MCP annotation `readOnlyHint: true` beside its
 * schema; anything else is a write, so a new tool is audited until someone decides otherwise.
 */
export function declaresReadOnly(config: unknown): boolean {
  return (
    (config as { annotations?: { readOnlyHint?: unknown } } | undefined)?.annotations
      ?.readOnlyHint === true
  );
}

type Args = Record<string, unknown>;

/** Tools that write only when asked to; otherwise they return a proposal or a report. */
export const WRITES_WHEN: Readonly<Record<string, (args: Args) => boolean>> = {
  entry_translate: (a) => a.apply === true,
  entry_summarize: (a) => a.apply === true,
  entry_autofill_field: (a) => a.apply === true,
  entry_suggest_tags: (a) => a.apply === true,
  entry_audit: (a) => a.createTasks === true,
  ai_action_run: (a) => a.apply === true,
  asset_generate_alt_text: (a) => a.apply === true,
  asset_auto_tag: (a) => a.apply === true,
  environment_import: (a) => a.dryRun !== true,
  environment_clone: (a) => a.dryRun !== true,
};

/**
 * Whether a call to `tool` with `args` changes anything, and so belongs in the audit trail.
 * `readOnly` is the tool's own `readOnlyHint` (`declaresReadOnly`).
 */
export function toolMutates(tool: string, args: Args, readOnly: boolean): boolean {
  if (readOnly) return false;
  return WRITES_WHEN[tool]?.(args) ?? true;
}

/** A tool's target by its name, first match wins, in the words REST's rows use (`routeTargetType`). */
const TOOL_TARGET_TYPES: readonly (readonly [RegExp, string])[] = [
  [/^entr(y|ies)_/, 'entry'],
  [/_content_type$/, 'content_type'],
  [/^agent_schedule_/, 'agent_schedule'],
  [/^agent_review_/, 'agent_review'],
  [/^ai_action_/, 'ai_action'],
  [/^bulk_job_/, 'job'],
  [/^api_key_/, 'api_key'],
  [/^app_extension_/, 'app_extension'],
  [/^asset_collections?_/, 'asset_collection'],
  [/^asset_folders?_/, 'asset_folder'],
  [/^assets?_/, 'asset'],
  [/^share_link_/, 'share_link'],
  [/^tasks?_/, 'task'],
  [/^environment_alias_/, 'environment_alias'],
  [/^function_/, 'function'],
  [/^invite_/, 'invite'],
  [/^menus?_/, 'menu'],
  [/^plugin_/, 'plugin'],
  [/^promotion_/, 'promotion'],
  [/^redirects?_/, 'redirect'],
  [/^releases?_/, 'release'],
  [/^roles?_/, 'role'],
  [/^views_/, 'saved_view'],
  [/^taxonomy_\w+_tag$/, 'tag'],
  [/^taxonomy_\w+_concept$/, 'concept'],
  [/^webhooks?_/, 'webhook'],
];

/** What kind of thing a tool acts on, for its audit row; undefined when no table entry names it. */
export function toolTargetType(tool: string): string | undefined {
  return TOOL_TARGET_TYPES.find(([name]) => name.test(tool))?.[1];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Which of a tool's arguments its input schema declares (a Zod object's shape). */
export function declaredArgs(inputSchema: unknown): ReadonlySet<string> {
  const shape = (inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return new Set(shape ? Object.keys(shape) : []);
}

export interface ToolAuditInput {
  readonly tool: string;
  /** The arguments after environment resolution: an alias already names its target. */
  readonly args: Args;
  /** The arguments the tool's schema declares, to tell a defaulted scope from no scope. */
  readonly declared: ReadonlySet<string>;
  /** The tool declares `readOnlyHint: true`: a read, never audited. */
  readonly readOnly: boolean;
  readonly principal: Principal;
  readonly defaultSpace: string;
  readonly defaultEnvironment: string;
  /** What the call created, when its arguments can't name it (`api_key_create`'s new key). */
  readonly targetId?: string;
  /** What the call's saves changed, from the `ChangeLog` it ran with. */
  readonly detail?: AuditDetail;
}

/**
 * Records one successful mutating tool call. The space and environment are the ones the tool
 * acted in (the server's defaults when the call left them out, as `scopeOf` does); a tool with
 * no space (none declared, no `spaceId` named) has nowhere to file a row and records none. Like
 * REST's, a failed audit write never fails the call.
 */
export async function auditToolCall(ctx: AppContext, input: ToolAuditInput): Promise<void> {
  const { tool, args, declared } = input;
  if (!toolMutates(tool, args, input.readOnly)) return;
  const spaceId = declared.has('space')
    ? (str(args.space) ?? input.defaultSpace)
    : str(args.spaceId);
  if (!spaceId) return;
  const named = input.targetId ?? str(args.id) ?? str(args.apiId) ?? str(args.alias);
  // A create's arguments can't name what it made; what it saved can, as on REST.
  const created = named ? undefined : createdEntryOf(input.detail);
  try {
    await recordAudit(ctx, {
      spaceId,
      environmentId: declared.has('environment')
        ? (str(args.environment) ?? input.defaultEnvironment)
        : undefined,
      actor: auditActor(input.principal),
      action: `MCP ${tool}`,
      targetType: named ? toolTargetType(tool) : created && 'entry',
      targetId: named ?? created?.entryId,
      status: 200,
      detail: input.detail,
    });
  } catch {
    /* auditing must never break the tool call */
  }
}

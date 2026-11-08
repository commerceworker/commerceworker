import {
  type ContentType,
  type EntryFields,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { AIProvider, ModelTier } from '@commerceworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import { conforms } from './ai-json';
import { UNTRUSTED_CONTENT_GUARD, wrapUntrusted } from './ai-prompt';
import type { AppContext } from './context';
import { getEntry } from './entries';
import { unpublishEntry } from './publishing';
import { createTask } from './tasks';

/**
 * Structural view of the agent-workflow runtime (`AgentRuntime` in
 * `@commerceworker/agent-runtime` satisfies it). Declared here because the runtime package
 * depends on this one, so the application layer names only the shape it needs
 * and the composition roots bind the concrete runtime.
 */
export interface AgentRunner {
  run(
    workflow: 'enrich' | 'moderate' | 'curate' | 'repurpose',
    input: { readonly scope: Scope; readonly entryId: string; readonly autoApply?: boolean },
  ): Promise<AgentRunOutcome>;
  /**
   * Optional (durable runtimes only): starts the whole on-publish agent pass
   * for a chunk of entries and returns as soon as it is durably started — the
   * run records its own outcome. Callers that have it should prefer it over
   * {@link runPublishAgents}, which must await each result and therefore pins
   * the calling invocation open. Absent, the inline path applies.
   */
  startPublishRuns?(input: {
    readonly scope: Scope;
    readonly entryIds: readonly string[];
    readonly enrich: boolean;
    readonly moderate: boolean;
    readonly autoApply?: boolean;
  }): Promise<void>;
  /**
   * Optional (durable runtimes only): starts the detached HITL watcher for a
   * pending review, which waits for the human decision as a signal/event and
   * applies on approval. Absent, decisions apply through the direct path.
   */
  watchReview?(input: {
    readonly scope: Scope;
    readonly reviewId: string;
    readonly entryId: string;
    readonly timeoutMs?: number;
  }): Promise<void>;
}

export interface AgentRunOutcome {
  readonly status: 'completed' | 'needs_review' | 'held' | 'skipped' | 'rejected';
  readonly decisions: string[];
  readonly usage: { inputTokens: number; outputTokens: number };
  /** Persisted review awaiting a human decision (when needs_review). */
  readonly reviewId?: string;
}

export type FindingSeverity = 'info' | 'warning' | 'error';

/** One issue an audit surfaced about an entry. */
export interface AuditFinding {
  /** Field apiId the finding concerns, if specific. */
  readonly field?: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  /** A concrete next step an editor could take. */
  readonly suggestedAction: string;
}

export interface AuditEntryInput {
  /** Create a task ("work package") for each finding at/above this severity. */
  readonly createTasks?: boolean;
  readonly taskSeverity?: FindingSeverity;
  readonly assignee?: string;
  readonly tier?: ModelTier;
}

export interface AuditEntryResult {
  readonly entryId: string;
  readonly findings: readonly AuditFinding[];
  /** Ids of tasks created as work packages, if requested. */
  readonly taskIds: readonly string[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, warning: 1, error: 2 };

function describeEntry(ct: ContentType, fields: EntryFields, locale: string): string {
  const lines: string[] = [];
  for (const f of ct.fields) {
    const value = fields[f.apiId]?.[locale];
    const shown =
      value === undefined ? '(empty)' : typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`- ${f.name} (${f.apiId}, ${f.type}${f.required ? ', required' : ''}): ${shown}`);
  }
  return lines.join('\n');
}

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'error'] },
    message: { type: 'string' },
    suggestedAction: { type: 'string' },
  },
  required: ['severity', 'message', 'suggestedAction'],
  additionalProperties: false,
};

/**
 * Agent Action: audits an entry against its content model and editorial best
 * practices, returning structured findings (gaps, inconsistencies, quality
 * issues). With `createTasks`, emits a task ("work package") per qualifying
 * finding via the P13 collaboration layer. Recorded in the agent cost ledger.
 */
export async function auditEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  entryId: string,
  input: AuditEntryInput = {},
): Promise<AuditEntryResult> {
  const { entry, fields } = await getEntry(ctx, scope, entryId);
  const ct = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  const locale = config?.defaultLocale ?? 'en-US';

  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You are a meticulous content editor. Audit the entry for gaps, inconsistencies, missing required information, and quality issues. Return concrete, actionable findings. Use severity "error" for blocking problems, "warning" for quality issues, "info" for nits. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt: `Content type: ${ct.name}.\nFields:\n${wrapUntrusted(describeEntry(ct, fields, locale))}\n\nList the findings.`,
    tier: input.tier ?? 'balanced',
    maxTokens: 2048,
    outputSchema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: FINDING_SCHEMA,
        },
      },
      required: ['findings'],
      additionalProperties: false,
    },
  });

  const obj = result.object as { findings?: AuditFinding[] } | undefined;
  if (!obj || !Array.isArray(obj.findings)) {
    throw new ValidationError([{ field: '', message: 'Model did not return findings' }]);
  }
  // A finding without the shape asked for (not an object, an unknown severity) is left out: it
  // would fail on its fields, or rank as no severity at all and slip past taskSeverity.
  const findings = (obj.findings as unknown[]).filter(
    (f): f is AuditFinding =>
      conforms(f, { ...FINDING_SCHEMA, additionalProperties: true }) &&
      Boolean((f as AuditFinding).message && (f as AuditFinding).suggestedAction),
  );

  const taskIds: string[] = [];
  if (input.createTasks) {
    const min = SEVERITY_RANK[input.taskSeverity ?? 'warning'];
    for (const f of findings) {
      if (SEVERITY_RANK[f.severity] < min) continue;
      const body = `[${f.severity}] ${f.field ? `${f.field}: ` : ''}${f.message}\n→ ${f.suggestedAction}`;
      const task = await createTask(ctx, scope, { entryId, body, assignee: input.assignee });
      taskIds.push(task.id);
    }
  }

  await recordAgentRun(ctx, scope, {
    workflow: 'audit',
    entryId,
    status: 'completed',
    decisions: [`Audited ${ct.name}: ${findings.length} finding(s), ${taskIds.length} task(s)`],
    usage: result.usage,
  });

  return { entryId, findings, taskIds, usage: result.usage };
}

export interface ModerateEntryResult {
  readonly entryId: string;
  readonly status: AgentRunOutcome['status'];
  /** True when the classifier held the entry for a policy violation. */
  readonly flagged: boolean;
  readonly decisions: readonly string[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Agent Action: runs the `moderate` workflow against an entry on demand —
 * classifies its text and records a hold when flagged. Recorded in the agent
 * cost ledger like every other run.
 */
export async function moderateEntry(
  ctx: AppContext,
  agents: AgentRunner,
  scope: Scope,
  entryId: string,
): Promise<ModerateEntryResult> {
  // Surface a 404 for unknown entries instead of the workflow's soft 'skipped'.
  await getEntry(ctx, scope, entryId);
  const r = await agents.run('moderate', { scope, entryId });
  await recordAgentRun(ctx, scope, {
    workflow: 'moderate',
    entryId,
    status: r.status,
    decisions: r.decisions,
    usage: r.usage,
  });
  return {
    entryId,
    status: r.status,
    flagged: r.status === 'held',
    decisions: r.decisions,
    usage: r.usage,
  };
}

export interface PublishAgentsConfig {
  readonly enrich: boolean;
  readonly moderate: boolean;
  /** Enrich autonomy: apply generated fields automatically vs. human review. */
  readonly autoApply: boolean;
}

export interface PublishAgentRunSummary {
  readonly workflow: 'enrich' | 'moderate';
  readonly status: AgentRunOutcome['status'];
  readonly decisions: readonly string[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Runs the configured agents against a newly published entry and records each
 * run in the agent ledger. Enrich runs before moderate so moderation classifies
 * the enriched content. A workflow failure propagates (the queue retries the
 * event), matching the previous enrich-only behavior.
 */
export async function runPublishAgents(
  ctx: AppContext,
  agents: AgentRunner,
  scope: Scope,
  entryId: string,
  config: PublishAgentsConfig,
): Promise<PublishAgentRunSummary[]> {
  const workflows: ('enrich' | 'moderate')[] = [];
  if (config.enrich) workflows.push('enrich');
  if (config.moderate) workflows.push('moderate');

  const runs: PublishAgentRunSummary[] = [];
  for (const workflow of workflows) {
    const r = await agents.run(workflow, { scope, entryId, autoApply: config.autoApply });
    if (r.status === 'needs_review' && r.reviewId) {
      // Durable runtimes arm the detached HITL watcher; failures fall back to
      // the direct-apply decision path, so best-effort is safe.
      await agents.watchReview?.({ scope, reviewId: r.reviewId, entryId }).catch(() => {});
    }
    await recordAgentRun(ctx, scope, {
      workflow,
      entryId,
      status: r.status,
      decisions: r.decisions,
      usage: r.usage,
    });
    runs.push({ workflow, status: r.status, decisions: r.decisions, usage: r.usage });
  }

  // Moderation runs post-publish (agents dispatch off entry.published), so a
  // flagged entry is briefly live. Retract it from the delivery read model as
  // soon as the classifier holds it, instead of only recording an advisory note,
  // so unsafe content does not stay published. (A synchronous pre-publish gate
  // remains a follow-up.)
  if (runs.some((r) => r.workflow === 'moderate' && r.status === 'held')) {
    await unpublishEntry(ctx, scope, entryId).catch(() => {
      /* already unpublished or gone — nothing to retract */
    });
    await recordAgentRun(ctx, scope, {
      workflow: 'moderate',
      entryId,
      status: 'held',
      decisions: ['retracted from delivery pending review'],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
  return runs;
}

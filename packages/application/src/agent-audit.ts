import type { Scope } from '@commerceworker/domain';
import type { AgentRunRecord, AgentUsageSummary } from '@commerceworker/ports';
import type { AppContext } from './context';

export interface RecordAgentRunInput {
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: readonly string[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

/** Persists an agent run as an audit record (with token usage for the ledger). */
export async function recordAgentRun(
  ctx: AppContext,
  scope: Scope,
  input: RecordAgentRunInput,
): Promise<AgentRunRecord> {
  const run: AgentRunRecord = {
    id: ctx.ids.newId(),
    workflow: input.workflow,
    entryId: input.entryId,
    status: input.status,
    decisions: input.decisions,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.agentRuns.record(scope, run);
  return run;
}

export async function listAgentRuns(
  ctx: AppContext,
  scope: Scope,
  query: { workflow?: string; limit?: number } = {},
): Promise<AgentRunRecord[]> {
  return ctx.store.agentRuns.list(scope, query);
}

/** The cost-ledger view: aggregated token usage across agent runs. */
export async function agentUsage(
  ctx: AppContext,
  scope: Scope,
  query: { workflow?: string; since?: string } = {},
): Promise<AgentUsageSummary> {
  return ctx.store.agentRuns.usage(scope, query);
}

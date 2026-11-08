import type { Principal, Scope } from '@commerceworker/domain';
import { canAccessContentType } from '@commerceworker/domain';
import type { PendingCount } from '@commerceworker/ports';
import type { AppContext } from './context';

/** What waits on a decision in a scope, as the Approvals inbox lists it. */
export interface PendingApprovalsCount {
  /** Workflow steps paused for a person (approvals, reviews, event waits). */
  readonly workflowTasks: number;
  /** Agent proposals awaiting review. */
  readonly agentReviews: number;
  readonly total: number;
}

/**
 * Counts what waits in Approvals without listing it: uncapped, two grouped reads. A role-bound
 * principal counts only items on content types it may read, matching what `listWorkflowTasks`
 * and `listAgentReviews` show it (a review whose entry is gone counts for unrestricted callers
 * only). Without a principal nothing is filtered.
 */
export async function countPendingApprovals(
  ctx: AppContext,
  scope: Scope,
  principal?: Principal,
): Promise<PendingApprovalsCount> {
  const [tasks, reviews] = await Promise.all([
    ctx.store.workflowTasks.countPending(scope),
    ctx.store.agentReviews.countPending(scope),
  ]);
  const visible = (rows: readonly PendingCount[]) =>
    rows
      .filter(
        (r) =>
          !principal?.contentGrants ||
          (r.contentTypeApiId !== null &&
            canAccessContentType(principal, 'read', r.contentTypeApiId)),
      )
      .reduce((sum, r) => sum + r.count, 0);
  const workflowTasks = visible(tasks);
  const agentReviews = visible(reviews);
  return { workflowTasks, agentReviews, total: workflowTasks + agentReviews };
}

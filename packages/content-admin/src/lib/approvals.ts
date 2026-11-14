import { useClient } from './client-context';
import { useScopedQuery } from './queries';

type PendingOpts = {
  readonly silent?: boolean;
  readonly enabled?: boolean;
};

/** The most a list asks for (the API's cap). */
const PENDING_LIMIT = 200;

/**
 * What waits on a person in this space, as the Approvals inbox lists it: workflow steps paused
 * for a decision, and agent proposals awaiting review.
 */
export function usePendingWorkflowTasks(opts?: PendingOpts) {
  const { client } = useClient();
  return useScopedQuery(
    ['workflow-tasks', 'pending'],
    () => client.listWorkflowTasks({ status: 'pending', limit: PENDING_LIMIT }),
    opts,
  );
}

export function usePendingAgentReviews(opts?: PendingOpts) {
  const { client } = useClient();
  return useScopedQuery(
    ['agent-reviews', 'pending'],
    () => client.listAgentReviews({ status: 'pending' }),
    opts,
  );
}

/** The shell's count's query key: the inbox invalidates it when it decides an item. */
export const APPROVALS_COUNT_KEY = ['approvals-count'] as const;

/** How often the shell asks again while the tab is visible: work arrives from agents and runs. */
const COUNT_REFRESH_MS = 60_000;

/**
 * How many items wait on a decision (`GET …/approvals/count`): uncapped, counted on the server,
 * and limited to the content types this person may read, as the inbox's lists are. Undefined
 * until it answers, or when it can't (a role without the scope), so the shell shows no number
 * rather than a wrong one. It refreshes every minute while the tab is visible, on focus, and when
 * the inbox decides an item. `enabled` waits for the scope (the shell mounts before the space is
 * known).
 */
export function usePendingApprovalsCount(enabled = true): number | undefined {
  const { client } = useClient();
  return useScopedQuery(APPROVALS_COUNT_KEY, () => client.countPendingApprovals(), {
    silent: true,
    enabled,
    refetchInterval: COUNT_REFRESH_MS,
  }).data?.total;
}

/** The count as the shell writes it: 99+ past two digits. */
export const approvalsCountLabel = (n: number) => (n > 99 ? '99+' : String(n));

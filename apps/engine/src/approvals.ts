/**
 * Who may vote on an Approval step, resolved when its wait opens (`approvalPlan`), and what a vote
 * needs to know of the order and its company (`voteContext`). The rules are core's
 * (`packages/core/src/b2b/approvals.ts`); this reads the company's members and the team's people
 * from D1. The Workflow still waits for one event: the OrderAgent records votes and sends it only
 * once the votes decide the step.
 */
import {
  APPROVAL_SEPARATION_KEY,
  type ApprovalDecision,
  type ApprovalPlan,
  type ApprovalTally,
  approvalsRequired,
  type CompanyMember,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_APPROVERS,
  eligibleApprovers,
  evaluateApprovalStatus,
  isMemberRule,
  type Order,
  orderBuyerId,
  planSpec,
  type Role,
  readApprovalSpec,
  type VoteLike,
  type Voter,
  voteProblem,
} from '@commerceworker/core';
import { companyDirectory, workspaceStore } from './wire';

const ALL = { all: true } as const;
const PAGE = 100;

/** Every active member of a company, a page at a time. */
async function activeMembers(
  env: Pick<Env, 'DB'>,
  companyId: string,
  role?: CompanyMember['role'],
) {
  const out: CompanyMember[] = [];
  let after: { name: string; id: string } | undefined;
  do {
    const page = await companyDirectory(env).members(ALL, {
      companyId,
      status: 'active',
      ...(role ? { role } : {}),
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    out.push(...page.rows);
    after = page.next ?? undefined;
  } while (after);
  return out;
}

/**
 * The plan an Approval step's wait carries: its approvers as written, its mode and who may vote.
 * Staff approvers are counted (from the team's people) only for a mode that counts; `any` is open
 * to every staff member with the role. Company approvers are the order's company's active members,
 * so an order with no company, or one whose company isn't active, has nobody and waits for the
 * step to time out. A node's fields were checked when its flow published; an error here is a flow
 * that bypassed that.
 */
export async function approvalPlan(
  env: Pick<Env, 'DB'>,
  config: Record<string, unknown>,
  order: Pick<Order, 'customerId'>,
): Promise<ApprovalPlan> {
  const read = readApprovalSpec(config);
  if ('error' in read) throw new Error(read.error);
  const { spec } = read;
  const plan = {
    approvers: String(config.approvers ?? '').trim() || 'staff:approver',
    mode: spec.mode,
    ...(spec.quorum ? { quorum: spec.quorum } : {}),
    ...(spec.mode === 'majority' ? { majorityPercent: spec.majorityPercent } : {}),
  };
  const rule = spec.approvers;
  if (rule.kind === 'staff') {
    if (spec.mode === 'any') return { ...plan, eligible: null };
    const { people } = await workspaceStore(env).team();
    return { ...plan, eligible: eligibleApprovers(spec, undefined, [], { staff: people }) };
  }
  const companyId = order.customerId;
  const company = companyId ? await companyDirectory(env).company(ALL, companyId) : undefined;
  if (!companyId || !company) return { ...plan, eligible: [] };
  const [members, teams] = await Promise.all([
    activeMembers(env, companyId, rule.kind === 'company' ? rule.role : undefined),
    rule.kind === 'team' ? companyDirectory(env).teams(ALL, companyId) : undefined,
  ]);
  return {
    ...plan,
    companyId,
    eligible: eligibleApprovers(spec, company, members, { ...(teams ? { teams } : {}) }),
  };
}

/** The votes still needed of the plan's approvers, for the approval's row. */
export const planRequired = (plan: ApprovalPlan, spec: Parameters<typeof approvalsRequired>[0]) =>
  approvalsRequired(spec, plan.eligible ? plan.eligible.length : null);

/** What `voteProblem` reads beyond the plan and the votes: separation, the buyer, the company. */
export async function voteContext(
  env: Pick<Env, 'DB'>,
  plan: ApprovalPlan,
  order: Pick<Order, 'meta'> | null | undefined,
) {
  const [separation, company] = await Promise.all([
    workspaceStore(env).setting(APPROVAL_SEPARATION_KEY),
    plan.companyId ? companyDirectory(env).company(ALL, plan.companyId) : undefined,
  ]);
  return {
    separation: separation === 'on',
    buyerId: order ? (orderBuyerId(order.meta) ?? null) : null,
    companyStatus: company?.status ?? null,
  };
}

/** What an approval waited for before approvers were named: any one staff approver. */
export const plainPlan = (): ApprovalPlan => ({
  approvers: DEFAULT_APPROVERS,
  mode: DEFAULT_APPROVAL_MODE,
  eligible: null,
});

/**
 * Who is voting: the member a staff principal records a vote for, or the principal themselves.
 * An RPC caller with no principal id (the engine's own) votes as the name it gave.
 */
export function voterOf(who: {
  id?: string | undefined;
  by: string;
  role?: Role | undefined;
  onBehalfOf?: string | undefined;
}): Voter {
  return who.onBehalfOf
    ? { id: who.onBehalfOf, kind: 'member' }
    : { id: who.id ?? `by:${who.by}`, kind: 'staff', role: who.role ?? 'approver' };
}

/**
 * Why this voter can't vote on the wait now, or null: `onBehalfOf` on a staff approval, or any of
 * core's `voteProblem`. A vote already cast, sent again with the same `decision`, is fine. The OrderAgent checks it on every vote; the assistant's preview runs it
 * first, so a card says so before anyone confirms.
 */
export async function voteRefusal(
  env: Pick<Env, 'DB'>,
  plan: ApprovalPlan,
  votes: readonly VoteLike[],
  voter: Voter,
  order: Pick<Order, 'meta'> | null | undefined,
  onBehalfOf?: string,
  decision?: ApprovalDecision,
): Promise<string | null> {
  // The same vote sent again (a retry after a lost answer) is the one already cast.
  if (decision && votes.some((v) => v.voterId === voter.id && v.decision === decision)) return null;
  if (onBehalfOf !== undefined && !isMemberRule(planSpec(plan).approvers))
    return 'onBehalfOf is for a company approval; staff decide this one themselves.';
  return voteProblem({ plan, votes, voter, ...(await voteContext(env, plan, order)) });
}

/** Where the vote would stand with this one added: for a card to say what confirming does. */
export function tallyWith(
  plan: ApprovalPlan,
  votes: readonly VoteLike[],
  voter: Voter,
  decision: ApprovalDecision,
): ApprovalTally {
  return evaluateApprovalStatus(planSpec(plan), plan.eligible, [
    ...votes,
    { voterId: voter.id, decision },
  ]);
}

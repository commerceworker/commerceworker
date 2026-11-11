/**
 * Who may vote on an Approval step and how a vote is taken (`b2b/approvals.ts` in core holds the
 * rules). `planApproval` resolves the approvers when the step's wait opens, from the order's
 * company's members or the team's people; `castApprovalVote` judges a vote, records it once per
 * voter and reads the tally back, and the OrderAgent only sends the Workflow's one event when
 * that tally says approved or rejected. `voteRefusal` is the judging alone, so the assistant's
 * card can say what confirming would do. Time comes in as an argument.
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
import type {
  CompanyDirectory,
  OrderRecords,
  WorkspaceStore,
} from '@commerceworker/ports/commerce';

export type ApprovalPorts = {
  readonly records: Pick<OrderRecords, 'votes' | 'recordVote'>;
  readonly companies: CompanyDirectory;
  readonly workspace: Pick<WorkspaceStore, 'team' | 'setting'>;
};

const ALL = { all: true } as const;
const PAGE = 100;

/** Every active member of a company, a page at a time. */
async function activeMembers(
  companies: CompanyDirectory,
  companyId: string,
  role?: CompanyMember['role'],
) {
  const out: CompanyMember[] = [];
  let after: { name: string; id: string } | undefined;
  do {
    const page = await companies.members(ALL, {
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
export async function planApproval(
  ports: Pick<ApprovalPorts, 'companies' | 'workspace'>,
  config: Record<string, unknown>,
  order: Pick<Order, 'customerId'>,
): Promise<ApprovalPlan> {
  const read = readApprovalSpec(config);
  if ('error' in read) throw new Error(read.error);
  const { spec } = read;
  const plan = {
    approvers: String(config.approvers ?? '').trim() || DEFAULT_APPROVERS,
    mode: spec.mode,
    ...(spec.quorum ? { quorum: spec.quorum } : {}),
    ...(spec.mode === 'majority' ? { majorityPercent: spec.majorityPercent } : {}),
  };
  const rule = spec.approvers;
  if (rule.kind === 'staff') {
    if (spec.mode === 'any') return { ...plan, eligible: null };
    const { people } = await ports.workspace.team();
    return { ...plan, eligible: eligibleApprovers(spec, undefined, [], { staff: people }) };
  }
  const companyId = order.customerId;
  const company = companyId ? await ports.companies.company(ALL, companyId) : undefined;
  if (!companyId || !company) return { ...plan, eligible: [] };
  const [members, teams] = await Promise.all([
    activeMembers(ports.companies, companyId, rule.kind === 'company' ? rule.role : undefined),
    rule.kind === 'team' ? ports.companies.teams(ALL, companyId) : undefined,
  ]);
  return {
    ...plan,
    companyId,
    eligible: eligibleApprovers(spec, company, members, { ...(teams ? { teams } : {}) }),
  };
}

/** The votes still needed of the plan's approvers, for the approval's row. */
export const planRequired = (plan: ApprovalPlan) =>
  approvalsRequired(planSpec(plan), plan.eligible ? plan.eligible.length : null);

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

/** What `voteProblem` reads beyond the plan and the votes: separation, the buyer, the company. */
async function voteContext(
  ports: Pick<ApprovalPorts, 'companies' | 'workspace'>,
  plan: ApprovalPlan,
  order: Pick<Order, 'meta'> | null | undefined,
) {
  const [separation, company] = await Promise.all([
    ports.workspace.setting(APPROVAL_SEPARATION_KEY),
    plan.companyId ? ports.companies.company(ALL, plan.companyId) : undefined,
  ]);
  return {
    separation: separation === 'on',
    buyerId: order ? (orderBuyerId(order.meta) ?? null) : null,
    companyStatus: company?.status ?? null,
  };
}

/**
 * Why this voter can't vote on the wait now, or null: `onBehalfOf` on a staff approval, or any of
 * core's `voteProblem`. A vote already cast, sent again with the same `decision`, is fine.
 */
export async function voteRefusal(
  ports: Pick<ApprovalPorts, 'companies' | 'workspace'>,
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
  return voteProblem({ plan, votes, voter, ...(await voteContext(ports, plan, order)) });
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

export type CastVote = {
  readonly orderId: string;
  /** The wait's event type, which names its approval. */
  readonly eventType: string;
  readonly plan: ApprovalPlan;
  readonly order: Pick<Order, 'meta'> | null | undefined;
  readonly voter: Voter;
  readonly decision: ApprovalDecision;
  readonly note?: string | undefined;
  /** The member whose vote staff record, if any. */
  readonly onBehalfOf?: string | undefined;
  /** The name the caller gave, for the timeline. */
  readonly by: string;
  /** The principal deciding, when there is one: who is named as having recorded a member's vote. */
  readonly deciderId?: string | undefined;
};

export type VoteOutcome =
  | {
      ok: true;
      tally: ApprovalTally;
      /** The voter's name for the timeline: the member's when staff recorded it for them. */
      voted: string;
      /** Whether the audit row should carry the outcome and tally (more than one voice decides). */
      audited: boolean;
    }
  | { ok: false; error: string };

/**
 * Judge a vote, record it once per voter and read the tally back: of two votes racing, the later
 * read sees both. A vote sent again (a retry after a lost answer) is the one already recorded, so
 * it only evaluates. A vote that can't be taken is answered, not thrown.
 */
export async function castApprovalVote(
  ports: ApprovalPorts,
  v: CastVote,
  now: number,
): Promise<VoteOutcome> {
  const before = await ports.records.votes(v.orderId, v.eventType);
  const problem = await voteRefusal(
    ports,
    v.plan,
    before,
    v.voter,
    v.order,
    v.onBehalfOf,
    v.decision,
  );
  if (problem) return { ok: false, error: problem };
  await ports.records.recordVote(v.orderId, v.eventType, {
    voterId: v.voter.id,
    voterKind: v.voter.kind,
    onBehalfBy: v.onBehalfOf ? (v.deciderId ?? v.by) : null,
    decision: v.decision,
    note: v.note ?? null,
    at: now,
  });
  const tally = evaluateApprovalStatus(
    planSpec(v.plan),
    v.plan.eligible,
    await ports.records.votes(v.orderId, v.eventType),
  );
  const member =
    v.onBehalfOf && v.plan.companyId
      ? await ports.companies.member(ALL, v.plan.companyId, v.onBehalfOf)
      : undefined;
  return {
    ok: true,
    tally,
    voted: v.onBehalfOf ? (member?.name ?? v.onBehalfOf) : v.by,
    // A single staff decision is what every approval was: its audit row says no more.
    audited: v.plan.mode !== 'any' || !!v.onBehalfOf,
  };
}

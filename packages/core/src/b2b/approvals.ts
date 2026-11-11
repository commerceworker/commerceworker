/**
 * Approvals with more than one voice: who may vote on an Approval step (`approvers`), how many
 * votes decide it (`mode`), and what a vote must be to count. The rules here, with no storage, are
 * the approvers' text form, who is eligible, whether a vote is allowed (`voteProblem`) and where a
 * vote stands (`evaluateApprovalStatus`). The Workflow still waits for one event: the OrderAgent
 * records votes and sends the decision only once this says approved or rejected. Ported from v1's
 * approval evaluation with its bugs fixed: `all` compares identities, not counts; `majority` means
 * more than `majorityPercent`, as documented; and a rejection ends the vote. `docs/b2b.md` (D3,
 * D4) is the plan: a member's vote is recorded by staff on their behalf until buyers can sign in,
 * and thresholds are flow logic (a Condition over `order.baseTotal` and `company.*`), not a table.
 */
import { atLeast, isRole, ROLES, type Role } from '../roles';
import { COMPANY_ROLES, type CompanyMember, type CompanyRole, type CompanyTeam } from './companies';

export const APPROVAL_MODES = ['any', 'all', 'majority', 'quorum'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  any: 'Any one approver',
  all: 'Every approver',
  majority: 'A majority',
  quorum: 'A quorum',
};

/** Today's approvers: staff with the Approver role or higher, any one of whom decides. */
export const DEFAULT_APPROVERS = 'staff:approver';
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'any';
/** `majority` needs more than this share of the eligible approvers. */
export const DEFAULT_MAJORITY_PERCENT = 50;
/** The most members one `members:` list names. */
export const MAX_APPROVER_MEMBERS = 50;

/** Who may vote. `staff` people sign in to the workspace; the rest are a company's members. */
export type ApproverRule =
  | { kind: 'staff'; role: Role }
  | { kind: 'company'; role: CompanyRole }
  | { kind: 'team'; teamId: string }
  | { kind: 'members'; ids: string[] };

const ID = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Reads the approvers a flow names: `staff:<role>`, `company:<role>`, `team:<id>` or
 * `members:<id>,<id>`. An error says what is wrong, in the editor's words.
 */
export function parseApprovers(text: unknown): { rule: ApproverRule } | { error: string } {
  if (typeof text !== 'string') return { error: 'Approvers must be text, like staff:approver' };
  const raw = text.trim();
  const at = raw.indexOf(':');
  const kind = at < 0 ? raw : raw.slice(0, at);
  const rest = at < 0 ? '' : raw.slice(at + 1).trim();
  switch (kind) {
    case 'staff':
      return isRole(rest)
        ? { rule: { kind: 'staff', role: rest } }
        : { error: `staff:<role> takes one of ${ROLES.join(', ')}` };
    case 'company':
      return (COMPANY_ROLES as readonly string[]).includes(rest)
        ? { rule: { kind: 'company', role: rest as CompanyRole } }
        : { error: `company:<role> takes one of ${COMPANY_ROLES.join(', ')}` };
    case 'team':
      return ID.test(rest)
        ? { rule: { kind: 'team', teamId: rest } }
        : { error: 'team:<id> takes a team id' };
    case 'members': {
      const ids = [...new Set(rest.split(',').map((s) => s.trim()))];
      if (!ids.length || ids.some((i) => !ID.test(i)))
        return { error: 'members:<id>,<id> takes member ids' };
      if (ids.length > MAX_APPROVER_MEMBERS)
        return { error: `members: names at most ${MAX_APPROVER_MEMBERS} members` };
      return { rule: { kind: 'members', ids } };
    }
    default:
      return { error: 'Approvers start with staff:, company:, team: or members:' };
  }
}

export interface ApprovalSpec {
  readonly approvers: ApproverRule;
  readonly mode: ApprovalMode;
  /** The approvals `quorum` mode needs; null for the other modes. */
  readonly quorum: number | null;
  readonly majorityPercent: number;
}

const wholeNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

/** A node's approval fields as a spec, with today's behaviour for any left out. */
export function readApprovalSpec(
  config: Record<string, unknown>,
): { spec: ApprovalSpec } | { error: string } {
  const text =
    config.approvers === undefined || config.approvers === ''
      ? DEFAULT_APPROVERS
      : config.approvers;
  const parsed = parseApprovers(text);
  if ('error' in parsed) return parsed;
  const mode =
    config.mode === undefined || config.mode === '' ? DEFAULT_APPROVAL_MODE : config.mode;
  if (!(APPROVAL_MODES as readonly unknown[]).includes(mode))
    return { error: `Mode takes one of ${APPROVAL_MODES.join(', ')}` };
  const percent =
    config.majorityPercent === undefined ||
    config.majorityPercent === null ||
    config.majorityPercent === ''
      ? DEFAULT_MAJORITY_PERCENT
      : wholeNumber(config.majorityPercent);
  if (percent === null || percent < 1 || percent > 99)
    return { error: 'Majority percent is a whole number from 1 to 99' };
  const quorum =
    config.quorum === undefined || config.quorum === null || config.quorum === ''
      ? null
      : wholeNumber(config.quorum);
  if (mode === 'quorum') {
    if (quorum === null || quorum < 1) return { error: 'Quorum is a whole number of at least 1' };
    if (parsed.rule.kind === 'members' && quorum > parsed.rule.ids.length)
      return { error: `Quorum ${quorum} is more than the ${parsed.rule.ids.length} members named` };
  }
  return {
    spec: {
      approvers: parsed.rule,
      mode: mode as ApprovalMode,
      quorum: mode === 'quorum' ? quorum : null,
      majorityPercent: percent,
    },
  };
}

/** Errors in a node's approval fields, for the catalog's own check. */
export function approvalConfigErrors(config: Record<string, unknown>): string[] {
  const r = readApprovalSpec(config);
  return 'error' in r ? [r.error] : [];
}

/** Whether voters are a company's members rather than staff. */
export const isMemberRule = (rule: ApproverRule) => rule.kind !== 'staff';

/**
 * The index's `waiting_for` token for an approval wait. Staff approvers keep `person:<assignee>`, as
 * every approval did before approvers were named; the others name their rule.
 */
export function approvalWaitingFor(w: { approval?: ApprovalPlan; assignee?: string }): string {
  const rule = w.approval ? parseApprovers(w.approval.approvers) : undefined;
  return w.approval && rule && 'rule' in rule && rule.rule.kind !== 'staff'
    ? `approvers:${w.approval.approvers.trim()}`
    : `person:${w.assignee ?? ''}`;
}

/** Who the approvers are, in words: "Company approvers", "Staff operators", "Named members". */
export function approversLabel(text: string): string {
  const p = parseApprovers(text);
  if ('error' in p) return 'Approvers';
  const r = p.rule;
  switch (r.kind) {
    case 'staff':
      return `Staff ${r.role}s`;
    case 'company':
      return `Company ${r.role.replace('_', ' ')}s`;
    case 'team':
      return 'A team’s members';
    case 'members':
      return r.ids.length === 1 ? 'A named member' : `${r.ids.length} named members`;
  }
}

/** What an Approval step's wait carries: who may vote and how many votes decide it. */
export interface ApprovalPlan {
  /** The approvers as the flow wrote them. */
  approvers: string;
  mode: ApprovalMode;
  quorum?: number;
  majorityPercent?: number;
  /** The company whose members vote, for company, team and members approvers. */
  companyId?: string;
  /**
   * The ids who may vote, resolved when the wait opened; null when it is open to any staff with
   * the role (only `any` mode, where nobody needs counting).
   */
  eligible: string[] | null;
}

/**
 * Who decides a wait and how, in a line, or empty for today's approvers: any one staff approver.
 * "Company approvers, 2 of 3 decide": the timeline and the order page read it.
 */
export function describePlan(plan: ApprovalPlan): string {
  if (plan.approvers.trim() === DEFAULT_APPROVERS && plan.mode === 'any') return '';
  const spec = planSpec(plan);
  const n = plan.eligible?.length;
  const needed = approvalsRequired(spec, n ?? null);
  const how =
    plan.mode === 'any'
      ? 'any one decides'
      : plan.mode === 'all'
        ? 'all must approve'
        : `${needed}${n === undefined ? '' : ` of ${n}`} must approve`;
  return `${approversLabel(plan.approvers)}, ${how}`;
}

export const planSpec = (plan: ApprovalPlan): ApprovalSpec => {
  const parsed = parseApprovers(plan.approvers);
  return {
    approvers: 'rule' in parsed ? parsed.rule : { kind: 'staff', role: 'approver' },
    mode: plan.mode,
    quorum: plan.quorum ?? null,
    majorityPercent: plan.majorityPercent ?? DEFAULT_MAJORITY_PERCENT,
  };
};

export type ApprovalDecision = 'approved' | 'rejected';

export interface VoteLike {
  readonly voterId: string;
  readonly decision: string;
}

export type ApprovalStatus = 'pending' | ApprovalDecision;

export interface ApprovalTally {
  status: ApprovalStatus;
  approvals: number;
  rejections: number;
  /** The approvals that decide it; for `all` and `majority`, from the eligible approvers. */
  required: number;
  /** How many approvers there are, or null when it is open to anyone with the staff role. */
  of: number | null;
  /** "1 of 2": the approvals so far, of those needed. */
  label: string;
}

/** The approvals `spec` needs from `n` eligible approvers (`any`: one, even with nobody to count). */
export function approvalsRequired(spec: ApprovalSpec, n: number | null): number {
  switch (spec.mode) {
    case 'any':
      return 1;
    case 'all':
      return n ?? 1;
    case 'majority':
      // More than the share: floor(n × p / 100) + 1, so 2 of 4 at 50% is not yet a majority.
      return Math.floor(((n ?? 0) * spec.majorityPercent) / 100) + 1;
    case 'quorum':
      return spec.quorum ?? 1;
  }
}

/**
 * Where a vote stands. Only votes by an eligible approver count, once each (the first of a voter's
 * votes). Any counted rejection ends it as rejected, whatever else has been said. Otherwise it is
 * approved when `any` has one approval, `all` has an approval from every eligible approver (by
 * identity, so an outsider's or a repeated vote can't stand in for one), `majority` has more than
 * `majorityPercent` of them, or `quorum` has its number. With nobody eligible nothing can be
 * approved: it stays pending until the step times out. `eligible` null is open to any staff.
 */
export function evaluateApprovalStatus(
  spec: ApprovalSpec,
  eligible: readonly string[] | null,
  votes: readonly VoteLike[],
): ApprovalTally {
  const pool = eligible ? new Set(eligible) : null;
  const first = new Map<string, string>();
  for (const v of votes) {
    if (pool && !pool.has(v.voterId)) continue;
    if (!first.has(v.voterId)) first.set(v.voterId, v.decision);
  }
  const approved = [...first].filter(([, d]) => d === 'approved').map(([id]) => id);
  const rejections = [...first.values()].filter((d) => d === 'rejected').length;
  const n = pool ? pool.size : null;
  const required = approvalsRequired(spec, n);
  let status: ApprovalStatus = 'pending';
  if (rejections > 0) status = 'rejected';
  else if (spec.mode === 'any') status = approved.length >= 1 ? 'approved' : 'pending';
  else if (n === 0 || n === null) status = 'pending';
  else if (spec.mode === 'all')
    status = eligible!.every((id) => approved.includes(id)) ? 'approved' : 'pending';
  else if (spec.mode === 'majority')
    status = approved.length * 100 > spec.majorityPercent * n ? 'approved' : 'pending';
  else status = approved.length >= required ? 'approved' : 'pending';
  return {
    status,
    approvals: approved.length,
    rejections,
    required,
    of: n,
    label: `${approved.length} of ${required}`,
  };
}

/** A voter as a vote names them: staff by their principal's id, a member by their id. */
export interface Voter {
  readonly id: string;
  readonly kind: 'staff' | 'member';
  /** A staff voter's workspace role. */
  readonly role?: Role | null;
}

/**
 * The members and teams a company's approvers are drawn from. Only active members of an active
 * company can be eligible. `team:<id>` takes the team and the teams under it when `teams` are
 * given. Staff approvers are the `staff` (the workspace's people, not disabled) with the role or
 * higher, resolved only when a mode needs them counted.
 */
export function eligibleApprovers(
  spec: ApprovalSpec,
  company: { status: string } | null | undefined,
  members: readonly Pick<CompanyMember, 'id' | 'role' | 'teamId' | 'status'>[],
  extra: {
    teams?: readonly Pick<CompanyTeam, 'id' | 'path'>[];
    staff?: readonly { id: string; role: string; disabledAt?: number | null }[];
  } = {},
): string[] {
  const r = spec.approvers;
  if (r.kind === 'staff')
    return (extra.staff ?? [])
      .filter((s) => !s.disabledAt && isRole(s.role) && atLeast(s.role, r.role))
      .map((s) => s.id);
  if (company?.status !== 'active') return [];
  const active = members.filter((m) => m.status === 'active');
  switch (r.kind) {
    case 'company':
      return active.filter((m) => m.role === r.role).map((m) => m.id);
    case 'members':
      return active.filter((m) => r.ids.includes(m.id)).map((m) => m.id);
    case 'team': {
      const root = extra.teams?.find((t) => t.id === r.teamId);
      const inside = new Set(
        root
          ? (extra.teams ?? []).filter((t) => t.path.startsWith(root.path)).map((t) => t.id)
          : [r.teamId],
      );
      return active.filter((m) => m.teamId && inside.has(m.teamId)).map((m) => m.id);
    }
  }
}

/** What `voteProblem` needs of the approval, its votes and who is voting. */
export interface VoteCheck {
  plan: ApprovalPlan;
  votes: readonly VoteLike[];
  voter: Voter;
  /** The company member who placed the order (`meta.buyerId`), if it names one. */
  buyerId?: string | null;
  /** The workspace's separation of duties setting. */
  separation: boolean;
  /** The company's status, for company approvers; undefined when the order has no company. */
  companyStatus?: string | null;
}

export const OWN_ORDER_MEMBER_REFUSAL = 'A buyer can’t decide their own order.';

/**
 * Why a vote can't be taken, or null: the vote is already decided, the voter has already voted,
 * isn't one of the approvers, would decide their own order (separation, for a member as for staff),
 * or the company isn't active. A replay of the same vote is the caller's to recognize first.
 */
export function voteProblem(c: VoteCheck): string | null {
  const spec = planSpec(c.plan);
  const rule = spec.approvers;
  if (evaluateApprovalStatus(spec, c.plan.eligible, c.votes).status !== 'pending')
    return 'That approval is already decided.';
  if (c.votes.some((v) => v.voterId === c.voter.id)) return 'This person has already voted.';
  if (isMemberRule(rule)) {
    if (c.voter.kind !== 'member')
      return 'This approval is decided by a company’s members. Record a member’s vote with onBehalfOf.';
    if (c.companyStatus !== 'active') return 'The company isn’t active, so its members can’t vote.';
    if (!c.plan.eligible?.includes(c.voter.id))
      return 'That member isn’t one of this approval’s approvers.';
    if (c.separation && c.buyerId && c.buyerId === c.voter.id) return OWN_ORDER_MEMBER_REFUSAL;
    return null;
  }
  if (c.voter.kind !== 'staff')
    return 'This approval is decided by staff, not a company’s members.';
  if (rule.kind === 'staff' && !atLeast(c.voter.role, rule.role))
    return `This approval needs the ${rule.role} role.`;
  if (c.plan.eligible && !c.plan.eligible.includes(c.voter.id))
    return 'This person isn’t one of this approval’s approvers.';
  return null;
}

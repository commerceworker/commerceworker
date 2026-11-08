/**
 * The shapes a workflow run is reported and stored in: per-node run detail, the timeline, pending
 * waits (approvals and event waits) and the report the interpreter sends after every step.
 *
 * A run is about one entry; an approval carries `requiredScope`, `separateDuties` and
 * `instructions`.
 */

import type { Principal } from '../auth/auth';
import type { Scope } from '../types';
import type { WorkflowNodeStatus, WorkflowRunStatus } from './graph-types';
import type { RunEntry } from './logic';
import type { PlanState } from './planner';

/** One node's live detail in a run. Times are epoch ms. */
export interface NodeRun {
  status: WorkflowNodeStatus;
  runs: number;
  branches?: string[];
  summary?: string;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** The node's label in the pinned graph, so run lists can say where a run waits or stopped. */
  label?: string;
  /** The node's catalog type. */
  type?: string;
  /** Audit identity of whoever the node ran as (the starter, or the approver upstream of it). */
  ranBy?: string;
}

/** An event delivered before any node waited for it, held until a wait for it opens. */
export interface EarlyEvent {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  /** Epoch ms. */
  readonly at: number;
}

/** At most this many early events are held per run; older ones drop first. */
export const EARLY_EVENT_CAP = 20;
/** An early event older than this is dropped instead of delivered. */
export const EARLY_EVENT_TTL_MS = 7 * 86_400_000;

export type TimelineKind = 'run' | 'node' | 'ai' | 'approval' | 'event' | 'rollback';

/** One line of a run's history. A keyed entry replaces its earlier copy (replays stay single). */
export interface TimelineEntry {
  /** Epoch ms. */
  at: number;
  nodeId?: string;
  kind: TimelineKind;
  message: string;
  key?: string;
}

/** Keep at most this many timeline entries per run (oldest dropped). */
export const TIMELINE_CAP = 500;

export type PendingWaitKind = 'approval' | 'event' | 'review';

/** What a waiting node waits on. `eventType` is unique per run (it embeds the effect key). */
export interface PendingWait {
  nodeId: string;
  eventType: string;
  kind: PendingWaitKind;
  title: string;
  /** The event name an `event` wait listens for (e.g. `entry.saved`). */
  event?: string;
  assignee?: string;
  instructions?: string;
  /** Who may decide an approval (a `SCOPES` value). */
  requiredScope?: string;
  /** The run's starter may not decide. */
  separateDuties?: boolean;
  /** The agent review a `review` wait is for. */
  reviewId?: string;
  /** Epoch ms. */
  deadline: number;
  /** Epoch ms. */
  since: number;
}

/**
 * What the interpreter reports. Plan snapshots carry a `seq` (per generation) and are dropped when
 * not newer than what the run already has; node detail and timeline entries are exactly-once
 * because they come from memoized steps (or are keyed).
 */
export interface RunReport {
  seq?: number;
  generation?: number;
  status?: WorkflowRunStatus;
  reason?: string;
  plan?: PlanState;
  entry?: RunEntry;
  vars?: Record<string, unknown>;
  node?: { id: string; type?: string } & Partial<NodeRun>;
  log?: TimelineEntry;
}

/** Event payloads (decisions, delivered events) are small: they land in vars and every report. */
export const MAX_EVENT_PAYLOAD_BYTES = 16_384;

export function payloadFits(payload: unknown): boolean {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (json === undefined) return false;
  // UTF-8 length without TextEncoder (the domain package declares no runtime libs).
  let bytes = 0;
  for (const ch of json) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) return false;
  }
  return true;
}

/**
 * The key a node's effects are idempotent on: its step name, plus the generation after the first.
 * Run counts restart in every generation, so step names repeat across generations while their
 * effects must not.
 */
export const effectKey = (generation: number, stepKey: string): string =>
  generation > 1 ? `${stepKey}@g${generation}` : stepKey;

/** Durable event types allow only [a-zA-Z0-9_-] (Cloudflare Workflows' rule), at most 100. */
export const eventTypeFor = (prefix: string, stepKey: string): string =>
  `${prefix}-${stepKey}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);

/** "entry.saved" → "entry_saved": where an event's payload lands in vars. */
export const eventVar = (event: string): string => event.replace(/[^a-zA-Z0-9]+/g, '_');

/**
 * Who a run acts as. Every node calls the same use-cases a person would, checked against this
 * principal with the same `authorize`/`authorizeContent` rules as the API. It is the starter's
 * principal as resolved when the run started.
 */
export interface WorkflowRunActor {
  /** Audit identity: the subject for a person, `admin-token`, or the key kind. */
  readonly id: string;
  readonly principal: Principal;
}

/**
 * Whether a principal is a person (a user with a subject). Only a person's approval changes who a
 * run acts as: an API token is never a person.
 */
export function isPersonPrincipal(principal: Principal): boolean {
  return principal.kind === 'user' && typeof principal.subject === 'string' && !!principal.subject;
}

/**
 * The approver an approval's decision payload names, when it names a person; else null. The run
 * acts as this approver downstream of the approval ("starter, then approver").
 */
export function approverOf(payload: unknown): WorkflowRunActor | null {
  if (!payload || typeof payload !== 'object') return null;
  const actor = (payload as { actor?: unknown }).actor;
  if (!actor || typeof actor !== 'object') return null;
  const { id, principal } = actor as { id?: unknown; principal?: unknown };
  if (typeof id !== 'string' || !principal || typeof principal !== 'object') return null;
  const p = principal as Principal;
  if (!Array.isArray(p.scopes) || typeof p.spaceId !== 'string' || !isPersonPrincipal(p)) {
    return null;
  }
  return { id, principal: p };
}

/** The audit identity of a principal (the same rule the API's audit trail uses). */
export function principalActorId(principal: Principal): string {
  if (principal.kind === 'admin') return 'admin-token';
  if (principal.kind === 'user' && principal.subject) return principal.subject;
  return principal.kind;
}

/** Everything a run needs to (re)start; Cloudflare persists it as the instance payload. */
export interface WorkflowRunParams {
  readonly runId: string;
  readonly scope: Scope;
  readonly workflowId: string;
  readonly version: number;
  readonly generation: number;
  readonly entryId: string;
  readonly actor: WorkflowRunActor;
  readonly vars: Record<string, unknown>;
  /** The trigger's payload. */
  readonly input: Record<string, unknown>;
  /** Epoch ms the run (generation) started; expressions read it as `now` until a step refreshes it. */
  readonly startedAt: number;
  /** Start at this node instead of the trigger (the legacy transition shim; see `seedAt`). */
  readonly startAt?: string;
}

/** The durable instance id of a run's generation. */
export const runInstanceId = (runId: string, generation: number): string =>
  generation > 1 ? `${runId}-g${generation}` : runId;

export type WorkflowTaskStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'received'
  | 'timeout'
  | 'applied'
  | 'cancelled';

/** A human task or event wait a run holds open. */
export interface WorkflowTask {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  /** Unique per run: the durable event type the decision is sent as. */
  readonly eventType: string;
  readonly kind: PendingWaitKind;
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly title: string;
  readonly instructions: string;
  readonly assignee: string | null;
  /** For `event` waits: the event name. */
  readonly event: string | null;
  /** For approvals and reviews: the scope a decider must hold. */
  readonly requiredScope: string | null;
  readonly separateDuties: boolean;
  readonly reviewId: string | null;
  /** ISO-8601. */
  readonly deadline: string;
  readonly status: WorkflowTaskStatus;
  /** ISO-8601. */
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly note: string | null;
  /** Audit identity of whoever started the run (separation of duties). */
  readonly startedBy: string;
}

/** A workflow run as stored and returned. */
export interface WorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly generation: number;
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly status: WorkflowRunStatus;
  readonly reason: string | null;
  readonly plan: PlanState;
  /** Live per-node detail. */
  readonly nodes: Record<string, NodeRun>;
  readonly vars: Record<string, unknown>;
  readonly input: Record<string, unknown>;
  /** The latest plan snapshot's sequence number within `generation`. */
  readonly seq: number;
  // ── Index fields: lists filter and sort on them, and the
  // row's `updatedAt` moves only when one of them (or the status/reason) changes.
  /** Titles of what the run waits on, joined with " · "; null when it waits on nothing. */
  readonly waitingOn: string | null;
  /** Labels of the nodes the run waits at (approvals, event waits, timers), " · "-joined. */
  readonly waitingAt: string | null;
  /** ISO-8601: when the oldest current wait began. */
  readonly waitingSince: string | null;
  /** ISO-8601: when the soonest open wait times out; null when nothing waits on a deadline. */
  readonly waitingDue: string | null;
  /** What it waits for: `person:<assignee>`, `event:<name>` or `timer`, " · "-joined. */
  readonly waitingFor: string | null;
  /** Where a run that ended badly stopped (node labels); null otherwise. */
  readonly stoppedAt: string | null;
  /** Events delivered before a wait for them opened, oldest first (see `EARLY_EVENT_CAP`). */
  readonly earlyEvents: readonly EarlyEvent[];
  readonly startedBy: WorkflowRunActor;
  readonly triggerEventId: string | null;
  /** The durable instance currently running the run (`runId`, then `runId-gN`). */
  readonly instanceId: string;
  /** ISO-8601. */
  readonly createdAt: string;
  /** ISO-8601. */
  readonly updatedAt: string;
  /** The last timeline sequence number handed out (timeline rows order by it). */
  readonly logSeq: number;
  /** Optimistic-concurrency revision; every write bumps it. */
  readonly rev: number;
}

/** One finished node run: timing and output, for dashboards and undo. */
export interface WorkflowNodeRunRecord {
  readonly runId: string;
  readonly generation: number;
  readonly nodeId: string;
  /** The iteration (1-based). */
  readonly run: number;
  readonly nodeType: string;
  /**
   * For AI nodes, what answered: the model tier (`fast`, `balanced`, `flagship`) or `heuristic`.
   * Null for every other node.
   */
  readonly model: string | null;
  /** Audit identity of whoever the node ran as. */
  readonly ranBy: string | null;
  readonly status: 'succeeded' | 'failed' | 'rolled_back';
  readonly summary: string | null;
  readonly output: unknown;
  readonly error: string | null;
  /** Epoch ms. */
  readonly startedAt: number;
  /** Epoch ms. */
  readonly endedAt: number;
  readonly durationMs: number;
}

/** A stored timeline entry, ordered by `seq` within its run. */
export interface WorkflowTimelineRecord extends TimelineEntry {
  readonly seq: number;
  readonly key: string;
}

// ── Words: the reasons a run keeps ───────────────────────────────────────────────────────────

/** The longest reason a run keeps: it shows on one line in lists and goes out in webhooks. */
export const RUN_REASON_MAX = 200;

/** Errors from a database driver: a statement and its parameters, never for people. */
const DATABASE_ERROR = /Failed query:|\bSQLSTATE\b|\bduplicate key value\b|\bD1_[A-Z_]*ERROR\b/;

/** One line of at most `max` characters, cut at a word with "…". */
export function capReason(text: string, max = RUN_REASON_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.·-]+$/, '')}…`;
}

/**
 * The reason a failed step gives its run ("Publish: Entry is archived"). A database error names
 * only where it happened; anything else keeps its first line, capped.
 */
export function failureReason(label: string, message: string): string {
  if (DATABASE_ERROR.test(message)) return capReason(`Database error at ${label}`);
  const first = message.split('\n').find((l) => l.trim()) ?? '';
  return capReason(first.trim() ? `${label}: ${first}` : `${label} failed`);
}

/** Any reason as a run keeps it, whoever reported it. */
export function runReason(text: string): string {
  const db = DATABASE_ERROR.exec(text);
  if (!db) return capReason(text);
  const where = text.slice(0, db.index).replace(/[\s:]+$/, '');
  return capReason(where ? `Database error at ${where}` : 'Database error');
}

const sentenceCase = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** What a `control.set` step assigned, in words: `{ cycle: 2, year: null }` → "Cycle 2". */
export function varsSummary(vars: Record<string, unknown>): string {
  const words = Object.entries(vars)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${sentenceCase(k)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return words.join(', ') || 'Nothing set';
}

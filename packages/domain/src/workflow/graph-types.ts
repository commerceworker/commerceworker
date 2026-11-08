/**
 * The workflow graph model: nodes, edges and the definitions/versions that hold them.
 *
 * Edge fields use React Flow's names so the admin canvas binds them without mapping. The shapes
 * are plain types plus the hand-written {@link parseWorkflowGraph}, because the domain package has no runtime dependencies.
 */

/** Node ids are 1–40 letters, digits, `_` or `-` (they become durable step names). */
export const WORKFLOW_NODE_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
export const WORKFLOW_NODE_LABEL_MAX = 80;
export const WORKFLOW_NODE_RETRIES_MAX = 10;

export interface WorkflowNode {
  id: string;
  /** A catalog type, e.g. `control.approval` (see `nodes.ts`). */
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  /** Per-node step retry policy; the catalog supplies a default. */
  retries?: number;
  /** Per-node step timeout, e.g. "30 seconds", "5 minutes". */
  timeout?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Output branch of the source, e.g. "true", "approved". Absent means the default "out". */
  sourceHandle?: string | null;
  /** "next" marks a loop back-edge into a `control.loop` node; anything else is a normal input. */
  targetHandle?: string | null;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Node status in a run's plan. */
export const WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'rolled_back',
] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

/** A run's status. */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  /** Ended by policy or an approval decision ("not approved"), not by a person cancelling. */
  'declined',
  'cancelled',
  'failed',
  'rolled_back',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const TERMINAL_WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'declined',
  'cancelled',
  'failed',
  'rolled_back',
];

/**
 * An editable workflow graph definition. `contentTypes` are the content types whose entries the
 * workflow's trigger covers (empty means every type).
 */
export interface WorkflowGraphDefinition {
  id: string;
  name: string;
  description: string;
  contentTypes: string[];
  graph: WorkflowGraph;
  /**
   * Entries this workflow covers publish only from one of its runs (its `content.publish` or
   * `content.publish_release` node). Every other publish path refuses them with
   * `PublishGatedError`: single and bulk publish, bulk jobs, releases, scheduled publishes and
   * plugins. Read from the latest published version, never the draft.
   */
  gatesPublish?: boolean;
}

/** A published, immutable snapshot. Runs pin one so later edits never change them. */
export interface WorkflowVersion extends WorkflowGraphDefinition {
  version: number;
  /** ISO-8601 instant. */
  publishedAt: string;
  publishedBy?: string;
}

/** A JSON-safe deep copy (graphs and node configs are JSON data). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const optString = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === 'string';

/**
 * Checks untrusted input (an API body, an import, copilot output) is graph-shaped and fills the
 * schema defaults (`config: {}`, `position: {x: 0, y: 0}`). The hand-written equivalent of
 * `flowGraphSchema.safeParse`; semantic checks live in `validateGraph`.
 */
export function parseWorkflowGraph(raw: unknown): ParseResult<WorkflowGraph> {
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ['A graph is an object with nodes and edges'] };
  if (!Array.isArray(raw.nodes)) issues.push('nodes must be an array');
  if (!Array.isArray(raw.edges)) issues.push('edges must be an array');
  if (issues.length) return { ok: false, issues };

  const nodes: WorkflowNode[] = [];
  (raw.nodes as unknown[]).forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isRecord(n)) {
      issues.push(`${at} must be an object`);
      return;
    }
    const before = issues.length;
    if (typeof n.id !== 'string' || !WORKFLOW_NODE_ID_RE.test(n.id)) {
      issues.push(`${at}.id: Node ids are 1–40 letters, digits, _ or -`);
    }
    if (typeof n.type !== 'string') issues.push(`${at}.type must be a string`);
    if (typeof n.label !== 'string') issues.push(`${at}.label must be a string`);
    else if (n.label.length > WORKFLOW_NODE_LABEL_MAX) {
      issues.push(`${at}.label is longer than ${WORKFLOW_NODE_LABEL_MAX} characters`);
    }
    if (n.config !== undefined && !isRecord(n.config)) {
      issues.push(`${at}.config must be an object`);
    }
    if (
      n.position !== undefined &&
      !(isRecord(n.position) && finite(n.position.x) && finite(n.position.y))
    ) {
      issues.push(`${at}.position must be { x: number, y: number }`);
    }
    if (
      n.retries !== undefined &&
      !(
        Number.isInteger(n.retries) &&
        (n.retries as number) >= 0 &&
        (n.retries as number) <= WORKFLOW_NODE_RETRIES_MAX
      )
    ) {
      issues.push(`${at}.retries must be an integer from 0 to ${WORKFLOW_NODE_RETRIES_MAX}`);
    }
    if (n.timeout !== undefined && typeof n.timeout !== 'string') {
      issues.push(`${at}.timeout must be a string`);
    }
    if (issues.length > before) return;
    const node: WorkflowNode = {
      id: n.id as string,
      type: n.type as string,
      label: n.label as string,
      config: isRecord(n.config) ? cloneJson(n.config) : {},
      position: isRecord(n.position)
        ? { x: n.position.x as number, y: n.position.y as number }
        : { x: 0, y: 0 },
    };
    if (n.retries !== undefined) node.retries = n.retries as number;
    if (n.timeout !== undefined) node.timeout = n.timeout as string;
    nodes.push(node);
  });

  const edges: WorkflowEdge[] = [];
  (raw.edges as unknown[]).forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!isRecord(e)) {
      issues.push(`${at} must be an object`);
      return;
    }
    const before = issues.length;
    for (const k of ['id', 'source', 'target'] as const) {
      if (typeof e[k] !== 'string') issues.push(`${at}.${k} must be a string`);
    }
    if (!optString(e.sourceHandle)) issues.push(`${at}.sourceHandle must be a string or null`);
    if (!optString(e.targetHandle)) issues.push(`${at}.targetHandle must be a string or null`);
    if (issues.length > before) return;
    const edge: WorkflowEdge = {
      id: e.id as string,
      source: e.source as string,
      target: e.target as string,
    };
    if (e.sourceHandle !== undefined) edge.sourceHandle = e.sourceHandle as string | null;
    if (e.targetHandle !== undefined) edge.targetHandle = e.targetHandle as string | null;
    edges.push(edge);
  });

  return issues.length ? { ok: false, issues } : { ok: true, value: { nodes, edges } };
}

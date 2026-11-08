import { DomainError } from '../errors';
import type { WorkflowNode } from './graph-types';
import { isTrigger } from './planner';

/** The trigger a person (or an API client) can start a run from (`startWorkflowRun`). */
export const MANUAL_TRIGGER = 'trigger.manual';

/** The nodes through which a run publishes. */
export const PUBLISHING_NODE_TYPES: readonly string[] = [
  'content.publish',
  'content.publish_release',
];

/**
 * Whether a run of this graph can ever publish: it starts by hand (the only trigger that starts
 * runs today) and holds a publishing node. A gate on a graph that can't is no gate but a lock,
 * since nothing could publish what it covers, so it neither gates nor publishes.
 */
export function canPublishThroughRun(graph: {
  readonly nodes: readonly Pick<WorkflowNode, 'type'>[];
}): boolean {
  return (
    graph.nodes.find(isTrigger)?.type === MANUAL_TRIGGER &&
    graph.nodes.some((n) => PUBLISHING_NODE_TYPES.includes(n.type))
  );
}

/**
 * Whether a published version gates publishing: its flag is on and a run of it can publish. The
 * one rule every reader applies (the stores' `listPublishGates`, the workflow summary).
 */
export function versionGatesPublish(version: {
  readonly gatesPublish?: boolean;
  readonly graph: { readonly nodes: readonly Pick<WorkflowNode, 'type'>[] };
}): boolean {
  return version.gatesPublish === true && canPublishThroughRun(version.graph);
}

/** Why a gated graph can't be published, or null when it can. */
export function publishGateIssue(graph: {
  readonly nodes: readonly Pick<WorkflowNode, 'type'>[];
}): string | null {
  if (canPublishThroughRun(graph)) return null;
  return graph.nodes.find(isTrigger)?.type !== MANUAL_TRIGGER
    ? 'Gate publishing needs a workflow people can start (a Submit for review trigger, trigger.manual): with any other trigger no run could ever publish the entries it covers'
    : 'Gate publishing needs a Publish or Publish release node: without one no run could ever publish the entries it covers';
}

/**
 * A workflow that gates publishing, as its latest published version has it: entries of the
 * content types it covers publish only from one of its runs. Only a version that
 * {@link canPublishThroughRun} gates. Only published versions run, so a
 * draft's gating means nothing until it is published, and publishing a version with gating off
 * is how an admin lets entries publish directly again.
 */
export interface PublishGate {
  readonly workflowId: string;
  /** The workflow's current name, for the refusal message. */
  readonly name: string;
  /** The published version the gate comes from. */
  readonly version: number;
  /** Content type api ids the workflow covers; empty means every type. */
  readonly contentTypes: readonly string[];
}

/** The gates covering an entry of `contentTypeApiId` (several workflows may cover one entry). */
export function gatesCovering(
  gates: readonly PublishGate[],
  contentTypeApiId: string,
): PublishGate[] {
  return gates.filter(
    (g) => g.contentTypes.length === 0 || g.contentTypes.includes(contentTypeApiId),
  );
}

/** One entry a publish refused, and the workflows any of whose runs may publish it. */
export interface GatedEntry {
  readonly entryId: string;
  readonly workflows: readonly { readonly id: string; readonly name: string }[];
}

const quoted = (workflows: GatedEntry['workflows']) =>
  workflows.map((w) => `"${w.name}"`).join(' or ');

/**
 * A publish of an entry a gated workflow covers, made outside a run of that workflow (HTTP 409,
 * `publish_gated`). There is no override: an admin who needs to publish directly turns gating off
 * on the workflow and publishes that version.
 */
export class PublishGatedError extends DomainError {
  readonly entries: readonly GatedEntry[];
  constructor(entries: readonly GatedEntry[], context?: { readonly releaseId: string }) {
    const [first] = entries;
    const message =
      context || entries.length !== 1 || !first
        ? `${context ? `Release "${context.releaseId}" holds` : 'These are'} ${entries.length} ${
            entries.length === 1 ? 'entry' : 'entries'
          } that publish only through a workflow: ${entries
            .map((e) => `"${e.entryId}" (${quoted(e.workflows)})`)
            .join(
              ', ',
            )}. Publish them through a run of the workflow, or have an admin publish a version of it with publish gating off.`
        : `Entry "${first.entryId}" publishes only through a run of the workflow ${quoted(
            first.workflows,
          )}. Start a run of the workflow on it, or have an admin publish a version of the workflow with publish gating off.`;
    super('publish_gated', message, { entries, ...context });
    this.entries = entries;
  }
}

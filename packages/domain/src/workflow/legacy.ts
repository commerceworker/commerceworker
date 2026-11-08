/**
 * Conversion between today's ordered-steps workflows (`collaboration/workflow.ts`) and graphs.
 * This exists for the expand/contract migration and API compatibility.
 *
 * A legacy workflow `[s1, s2, …, sN]` becomes
 *   trigger.manual → content.stage(s1) → control.approval("Move to s2") → content.stage(s2) → … →
 *   control.end(completed)
 * where each approval decides with the step's `requiredScope`; rejections end the run declined.
 * Each stage also records its step's `requiredScope`, so {@link graphToLegacySteps} round-trips
 * exactly (including the first step, which has no approval in front of it).
 */

import type { PermissionScope } from '../auth/auth';
import {
  assertValidWorkflow,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../collaboration/workflow';
import type { WorkflowGraph, WorkflowGraphDefinition } from './graph-types';
import { levelsOf } from './layout';
import { WorkflowBuilder } from './templates';

const label = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

function buildLegacy(steps: readonly WorkflowStep[]): WorkflowBuilder {
  assertValidWorkflow(steps);
  const b = new WorkflowBuilder().n('start', 'trigger.manual', 'Submit');
  steps.forEach((step, i) => {
    const stage = `stage_${i + 1}`;
    b.n(stage, 'content.stage', label(step.name), {
      stepId: step.id,
      name: step.name,
      requiredScope: step.requiredScope,
    });
    if (i === 0) {
      b.e('start', stage);
      return;
    }
    const approve = `approve_${i + 1}`;
    b.n(approve, 'control.approval', label(`Move to ${step.name}`), {
      title: `Move “{{ref}}” to ${step.name}`,
      assignee: '',
      requiredScope: step.requiredScope,
      timeout: '1 year',
    });
    b.e(`stage_${i}`, approve);
    b.e(`${approve}.approved`, stage);
    b.e(`${approve}.rejected`, 'declined');
    b.e(`${approve}.escalated`, 'expired');
  });
  b.n('done', 'control.end', 'Done', { outcome: 'completed' });
  b.e(`stage_${steps.length}`, 'done');
  if (steps.length > 1) {
    b.n('declined', 'control.end', 'Not approved', { outcome: 'declined', reason: 'Not approved' });
    b.n('expired', 'control.end', 'No decision', {
      outcome: 'declined',
      reason: 'No decision in time',
    });
  }
  return b;
}

/** A legacy ordered-steps workflow as a linear graph, laid out. */
export function legacyStepsToGraph(def: Pick<WorkflowDefinition, 'steps'>): WorkflowGraph {
  return buildLegacy(def.steps).graph();
}

/** A legacy workflow as a graph definition (the "Legacy: <name>" template). */
export function legacyWorkflowDefinition(
  def: WorkflowDefinition,
  contentTypes: string[] = [],
): WorkflowGraphDefinition {
  return buildLegacy(def.steps).build({
    id: def.id,
    name: `Legacy: ${def.name}`,
    description: `Converted from the ordered-steps workflow “${def.name}”.`,
    contentTypes,
  });
}

/**
 * The legacy steps a graph exposes: its `content.stage` nodes in graph order (by forward depth,
 * then node order). Backs `steps` on GET /workflows for API compatibility.
 */
export function graphToLegacySteps(graph: WorkflowGraph): WorkflowStep[] {
  const levels = levelsOf(graph);
  return graph.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === 'content.stage')
    .sort((a, b) => (levels.get(a.n.id) ?? 0) - (levels.get(b.n.id) ?? 0) || a.i - b.i)
    .map(({ n }) => ({
      id: String(n.config.stepId ?? n.id),
      name: String(n.config.name || n.label),
      requiredScope: String(n.config.requiredScope ?? 'content:write') as PermissionScope,
    }));
}

/** The stage node that records legacy step `stepId`, if any (the transition shim's `startAt`). */
export function stageNodeFor(graph: WorkflowGraph, stepId: string): string | undefined {
  return graph.nodes.find((n) => n.type === 'content.stage' && n.config.stepId === stepId)?.id;
}

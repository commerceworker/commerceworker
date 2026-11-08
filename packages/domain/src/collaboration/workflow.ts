/**
 * A configurable editorial workflow: an ordered list of named steps, each
 * gated by a permission scope a caller must hold to move an entry INTO it
 * (e.g. an "Approved" step requires `content:publish`). An entry tracks which
 * step it currently sits in.
 *
 * Transitions are unrestricted in order (any step → any step); the gate is the
 * target step's `requiredScope`, enforced by {@link assertCanEnterStep}.
 */
import { ForbiddenError, type PermissionScope } from '../auth/auth';
import { InvalidStateError, NotFoundError } from '../errors';

export interface WorkflowStep {
  /** Stable identifier, unique within the workflow. */
  readonly id: string;
  readonly name: string;
  /** Scope a caller must hold to move an entry into this step. */
  readonly requiredScope: PermissionScope;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
}

/** Which workflow step an entry currently sits in. */
export interface EntryWorkflowState {
  readonly entryId: string;
  readonly workflowId: string;
  readonly currentStepId: string;
}

/** The first step — where an entry enters the workflow. */
export function firstStep(def: WorkflowDefinition): WorkflowStep {
  const step = def.steps[0];
  if (!step) throw new InvalidStateError('Workflow has no steps');
  return step;
}

/** Resolves a step by id, or throws NotFoundError. */
export function getStep(def: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = def.steps.find((s) => s.id === stepId);
  if (!step) throw new NotFoundError('WorkflowStep', stepId);
  return step;
}

/**
 * Resolves the target step and enforces that the caller holds its required
 * scope. Returns the step so the caller can record the transition.
 */
export function assertCanEnterStep(
  def: WorkflowDefinition,
  toStepId: string,
  callerScopes: readonly string[],
): WorkflowStep {
  const step = getStep(def, toStepId);
  if (!callerScopes.includes(step.requiredScope)) {
    throw new ForbiddenError(step.requiredScope);
  }
  return step;
}

const SCOPE_RE = /^[a-z]+:[a-z]+$/;

/** Validates a workflow definition has steps with unique ids and valid scopes. */
export function assertValidWorkflow(steps: readonly WorkflowStep[]): void {
  if (steps.length === 0) throw new InvalidStateError('A workflow needs at least one step');
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new InvalidStateError(`Duplicate workflow step id "${s.id}"`);
    ids.add(s.id);
    if (!SCOPE_RE.test(s.requiredScope)) {
      throw new InvalidStateError(`Invalid requiredScope "${s.requiredScope}" on step "${s.id}"`);
    }
  }
}

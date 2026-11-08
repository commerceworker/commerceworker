import { describe, expect, it } from 'vitest';
import {
  graphToLegacySteps,
  InvalidStateError,
  legacyStepsToGraph,
  legacyWorkflowDefinition,
  stageNodeFor,
  validateGraph,
  type WorkflowDefinition,
} from '../src/index';

const def: WorkflowDefinition = {
  id: 'wf1',
  name: 'Newsroom',
  steps: [
    { id: 'draft', name: 'Draft', requiredScope: 'content:write' },
    { id: 'review', name: 'In review', requiredScope: 'content:write' },
    {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      name: 'Approved',
      requiredScope: 'content:publish',
    },
  ],
};

describe('legacyStepsToGraph', () => {
  it('builds trigger → stage → (approval → stage)… → end', () => {
    const g = legacyStepsToGraph(def);
    expect(g.nodes.map((n) => [n.id, n.type])).toEqual([
      ['start', 'trigger.manual'],
      ['stage_1', 'content.stage'],
      ['stage_2', 'content.stage'],
      ['approve_2', 'control.approval'],
      ['stage_3', 'content.stage'],
      ['approve_3', 'control.approval'],
      ['done', 'control.end'],
      ['declined', 'control.end'],
      ['expired', 'control.end'],
    ]);
    const approve3 = g.nodes.find((n) => n.id === 'approve_3');
    expect(approve3?.label).toBe('Move to Approved');
    expect(approve3?.config.requiredScope).toBe('content:publish');
    expect(g.edges.map((e) => `${e.source}.${e.sourceHandle ?? 'out'}>${e.target}`)).toEqual([
      'start.out>stage_1',
      'stage_1.out>approve_2',
      'approve_2.approved>stage_2',
      'approve_2.rejected>declined',
      'approve_2.escalated>expired',
      'stage_2.out>approve_3',
      'approve_3.approved>stage_3',
      'approve_3.rejected>declined',
      'approve_3.escalated>expired',
      'stage_3.out>done',
    ]);
  });

  it('produces a valid, laid-out graph', () => {
    const g = legacyStepsToGraph(def);
    expect(validateGraph(g)).toEqual({ errors: [], warnings: [] });
    expect(new Set(g.nodes.map((n) => n.position.x)).size).toBeGreaterThan(1);
  });

  it('handles a single step without approval nodes', () => {
    const g = legacyStepsToGraph({ steps: [def.steps[0] as WorkflowDefinition['steps'][number]] });
    expect(g.nodes.map((n) => n.id)).toEqual(['start', 'stage_1', 'done']);
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('refuses an invalid legacy workflow', () => {
    expect(() => legacyStepsToGraph({ steps: [] })).toThrow(InvalidStateError);
  });
});

describe('graphToLegacySteps', () => {
  it('round-trips the steps exactly, in graph order', () => {
    expect(graphToLegacySteps(legacyStepsToGraph(def))).toEqual(def.steps);
  });

  it('finds the stage node for a step id', () => {
    const g = legacyStepsToGraph(def);
    expect(stageNodeFor(g, 'review')).toBe('stage_2');
    expect(stageNodeFor(g, 'nope')).toBeUndefined();
  });
});

describe('legacyWorkflowDefinition', () => {
  it('names the converted workflow and keeps its id', () => {
    const d = legacyWorkflowDefinition(def, ['article']);
    expect(d).toMatchObject({ id: 'wf1', name: 'Legacy: Newsroom', contentTypes: ['article'] });
    expect(validateGraph(d.graph).errors).toEqual([]);
  });
});

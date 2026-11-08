import { describe, expect, it } from 'vitest';
import {
  beginNode,
  completeLoop,
  completeNode,
  initPlan,
  isSettled,
  legacyStepsToGraph,
  nodeOutputs,
  readyNodes,
  seedAt,
  validateGraph,
  WORKFLOW_TEMPLATES,
  type WorkflowGraph,
  type WorkflowGraphDefinition,
  type WorkflowNode,
} from '../src/index';

/**
 * Drives the planner the way the workflow interpreter does, with `choose` standing in for node
 * execution. Returns the node ids in the order they ran.
 */
function simulate(
  graph: WorkflowGraph,
  choose: (id: string, run: number) => string[] | boolean | undefined = () => undefined,
  state = initPlan(graph),
  limit = 1000,
) {
  const ran: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < limit; i++) {
    const { ready } = readyNodes(graph, state);
    if (!ready.length) break;
    for (const id of ready) {
      const node = graph.nodes.find((n) => n.id === id) as WorkflowNode;
      keys.push(beginNode(state, id));
      const run = state.nodes[id]?.runs ?? 0;
      ran.push(id);
      const choice = choose(id, run);
      if (node.type === 'control.loop') {
        const max = Number(node.config.maxIterations ?? 12);
        completeLoop(graph, state, id, (choice as boolean | undefined) ?? run <= max);
      } else if (node.type === 'control.end' || node.type === 'control.continue_as_new') {
        completeNode(graph, state, id, []);
        return { ran, keys, state, ended: id };
      } else {
        const outs = nodeOutputs(node.type, node.config);
        completeNode(graph, state, id, (choice as string[] | undefined) ?? outs.slice(0, 1));
      }
    }
  }
  return { ran, keys, state, ended: null as string | null };
}

const tpl = (k: keyof typeof WORKFLOW_TEMPLATES): WorkflowGraphDefinition =>
  WORKFLOW_TEMPLATES[k]();

const n = (id: string, type = 'content.comment'): WorkflowNode => ({
  id,
  type,
  label: id,
  config: {},
  position: { x: 0, y: 0 },
});

describe('templates', () => {
  for (const key of Object.keys(WORKFLOW_TEMPLATES) as (keyof typeof WORKFLOW_TEMPLATES)[]) {
    it(`${key} validates`, () => {
      const { errors } = validateGraph(tpl(key).graph);
      expect(errors).toEqual([]);
    });
  }
});

describe('planner', () => {
  it('runs an untagged editorial review straight to publish and skips legal', () => {
    const { graph } = tpl('tpl-editorial-review');
    const { ran, state, ended } = simulate(graph, (id) =>
      id === 'legal_tag' ? ['false'] : undefined,
    );
    expect(ended).toBe('done');
    expect(ran).toEqual(['requested', 'validate', 'editor', 'legal_tag', 'publish', 'done']);
    expect(state.nodes.legal?.status).toBe('skipped');
    expect(state.nodes.fix?.status).toBe('skipped');
  });

  it('joins at publish after legal approves (AND-join tolerating the untaken branch)', () => {
    const { graph } = tpl('tpl-editorial-review');
    const { ran, state, ended } = simulate(graph);
    expect(ended).toBe('done');
    expect(ran).toEqual([
      'requested',
      'validate',
      'editor',
      'legal_tag',
      'legal',
      'publish',
      'done',
    ]);
    expect(state.edges['legal_tag.false-publish']).toBe('inactive');
    expect(state.edges['legal.approved-publish']).toBe('active');
  });

  it('routes a rejection to the declined end and skips everything downstream of it', () => {
    const { graph } = tpl('tpl-editorial-review');
    const { ended, state } = simulate(graph, (id) => (id === 'editor' ? ['rejected'] : undefined));
    expect(ended).toBe('rejected');
    expect(state.nodes.legal_tag?.status).toBe('skipped');
    expect(state.nodes.legal?.status).toBe('skipped');
    expect(state.nodes.publish?.status).toBe('skipped');
  });

  it('waits for every active input of a join', () => {
    const graph: WorkflowGraph = {
      nodes: [n('t', 'trigger.manual'), n('fork', 'control.condition'), n('a'), n('b'), n('join')],
      edges: [
        { id: '1', source: 't', target: 'fork' },
        { id: '2', source: 'fork', target: 'a', sourceHandle: 'true' },
        { id: '3', source: 'fork', target: 'b', sourceHandle: 'false' },
        { id: '4', source: 'a', target: 'join' },
        { id: '5', source: 'b', target: 'join' },
      ],
    };
    const state = initPlan(graph);
    completeNode(graph, state, 't');
    beginNode(state, 'fork');
    completeNode(graph, state, 'fork', ['true', 'false']);
    expect(readyNodes(graph, state).ready).toEqual(['a', 'b']);
    beginNode(state, 'a');
    completeNode(graph, state, 'a');
    expect(readyNodes(graph, state).ready).toEqual(['b']);
    beginNode(state, 'b');
    completeNode(graph, state, 'b');
    expect(readyNodes(graph, state).ready).toEqual(['join']);
  });

  it('propagates skips down a chain to a fixpoint', () => {
    const graph: WorkflowGraph = {
      nodes: [n('t', 'trigger.manual'), n('c', 'control.condition'), n('x'), n('y'), n('z')],
      edges: [
        { id: '1', source: 't', target: 'c' },
        { id: '2', source: 'c', target: 'x', sourceHandle: 'true' },
        { id: '3', source: 'x', target: 'y' },
        { id: '4', source: 'y', target: 'z' },
        { id: '5', source: 'c', target: 'z', sourceHandle: 'false' },
      ],
    };
    const state = initPlan(graph);
    beginNode(state, 't');
    completeNode(graph, state, 't');
    beginNode(state, 'c');
    completeNode(graph, state, 'c', ['false']);
    const { ready, skipped } = readyNodes(graph, state);
    expect(skipped).toEqual(['x', 'y']);
    expect(ready).toEqual(['z']);
    expect(state.edges['4']).toBe('inactive');
  });

  it('runs a loop once per locale with distinct step keys, then exits through "done"', () => {
    const { graph } = tpl('tpl-translate-on-publish');
    const { ran, keys, ended } = simulate(graph, (id, run) =>
      id === 'each' ? run <= 2 : undefined,
    );
    expect(ended).toBe('done');
    expect(ran.filter((id) => id === 'translate')).toHaveLength(2);
    expect(ran.filter((id) => id === 'each')).toHaveLength(3);
    expect(keys).toContain('translate#1');
    expect(keys).toContain('translate#2');
    expect(keys).toContain('each#3');
  });

  it('leaves a loop early when its condition stops holding', () => {
    const { graph } = tpl('tpl-translate-on-publish');
    const { ran, ended } = simulate(graph, (id, run) => (id === 'each' ? run === 1 : undefined));
    expect(ended).toBe('done');
    expect(ran.filter((id) => id === 'translate')).toHaveLength(1);
  });

  it('resets the loop body and holds "done" pending when the loop continues', () => {
    const { graph } = tpl('tpl-translate-on-publish');
    const state = initPlan(graph);
    for (const id of ['published', 'init']) {
      beginNode(state, id);
      completeNode(graph, state, id);
    }
    beginNode(state, 'each');
    completeLoop(graph, state, 'each', true);
    for (const id of ['pick', 'translate', 'advance']) {
      expect(readyNodes(graph, state).ready).toEqual([id]);
      beginNode(state, id);
      completeNode(graph, state, id);
    }
    // The back-edge is active: the loop is pending again and ready.
    expect(state.edges['advance-each.next']).toBe('active');
    expect(state.nodes.each?.status).toBe('pending');
    expect(readyNodes(graph, state).ready).toEqual(['each']);
    beginNode(state, 'each');
    completeLoop(graph, state, 'each', true);
    expect(state.edges['advance-each.next']).toBe('pending');
    expect(state.edges['each.done-done']).toBe('pending');
    expect(state.nodes.pick?.status).toBe('pending');
    expect(state.nodes.translate?.status).toBe('pending');
    expect(state.nodes.translate?.runs).toBe(1);
    expect(state.nodes.done?.status).toBe('pending');
  });

  it('is settled once nothing can run, and not while a node waits', () => {
    const { graph } = tpl('tpl-quarterly-freshness');
    const { state } = simulate(graph, (id) => (id === 'assess' ? ['no'] : undefined));
    expect(isSettled(graph, state)).toBe(true);

    const waiting = initPlan(graph);
    beginNode(waiting, 'quarterly');
    completeNode(graph, waiting, 'quarterly');
    beginNode(waiting, 'assess');
    expect(isSettled(graph, waiting)).toBe(false);
  });
});

describe('seedAt', () => {
  const steps = [
    { id: 'draft', name: 'Draft', requiredScope: 'content:write' as const },
    { id: 'review', name: 'In review', requiredScope: 'content:write' as const },
    { id: 'approved', name: 'Approved', requiredScope: 'content:publish' as const },
  ];

  it('starts a legacy graph at a later stage and runs on from there', () => {
    const graph = legacyStepsToGraph({ steps });
    const state = initPlan(graph);
    seedAt(graph, state, 'stage_2');
    expect(readyNodes(graph, state).ready).toEqual(['stage_2']);
    expect(state.nodes.start?.status).toBe('skipped');
    expect(state.nodes.stage_1?.status).toBe('skipped');
    expect(state.nodes.approve_2?.status).toBe('skipped');
    const { ran, ended } = simulate(graph, undefined, state);
    expect(ran).toEqual(['stage_2', 'approve_3', 'stage_3', 'done']);
    expect(ended).toBe('done');
  });

  it('treats the skipped side of a join as an untaken branch', () => {
    const { graph } = tpl('tpl-editorial-review');
    const state = initPlan(graph);
    seedAt(graph, state, 'legal');
    const { ran, ended } = simulate(graph, undefined, state);
    expect(ran).toEqual(['legal', 'publish', 'done']);
    expect(ended).toBe('done');
  });

  it('is a no-op at the trigger', () => {
    const { graph } = tpl('tpl-editorial-review');
    const state = initPlan(graph);
    seedAt(graph, state, 'requested');
    expect(state).toEqual(initPlan(graph));
  });

  it('rejects an unknown node', () => {
    const { graph } = tpl('tpl-editorial-review');
    expect(() => seedAt(graph, initPlan(graph), 'nope')).toThrow(/not in the graph/);
  });
});

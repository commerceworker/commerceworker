import { describe, expect, it } from 'vitest';
import {
  createNodeRegistry,
  durationMs,
  NODE_SPECS,
  nodeOutputs,
  parseWorkflowGraph,
  validateConfig,
  validateGraph,
  WORKFLOW_TEMPLATES,
  type WorkflowGraph,
  withDefaults,
} from '../src/index';

const base = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger.manual', label: 'T', config: {}, position: { x: 0, y: 0 } },
    { id: 'a', type: 'content.validate', label: 'A', config: {}, position: { x: 0, y: 0 } },
    { id: 'b', type: 'content.publish', label: 'B', config: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: '1', source: 't', target: 'a', sourceHandle: null },
    { id: '2', source: 'a', target: 'b', sourceHandle: 'valid' },
  ],
});

const msgs = (g: WorkflowGraph) => validateGraph(g).errors.map((e) => e.message);

describe('validateGraph', () => {
  it('accepts a well-formed graph', () => {
    expect(validateGraph(base()).errors).toEqual([]);
  });

  it('rejects a forward cycle', () => {
    const g = base();
    g.edges.push({ id: '3', source: 'b', target: 'a' });
    expect(msgs(g).some((m) => m.includes('cycle'))).toBe(true);
  });

  it('rejects an unknown output branch', () => {
    const g = base();
    const edge = g.edges[1];
    if (edge) edge.sourceHandle = 'nope';
    expect(msgs(g)[0]).toContain('no “nope” output');
  });

  it('rejects a disconnected node and a second trigger', () => {
    const g = base();
    g.nodes.push({
      id: 'x',
      type: 'content.unpublish',
      label: 'X',
      config: {},
      position: { x: 0, y: 0 },
    });
    g.nodes.push({
      id: 't2',
      type: 'trigger.entry_saved',
      label: 'T2',
      config: {},
      position: { x: 0, y: 0 },
    });
    const m = msgs(g);
    expect(m.some((x) => x.includes('not connected'))).toBe(true);
    expect(m.some((x) => x.includes('exactly one trigger'))).toBe(true);
  });

  it('rejects inputs into a trigger, edges to missing nodes and unknown types', () => {
    const g = base();
    g.edges.push({ id: '3', source: 'a', target: 't', sourceHandle: 'invalid' });
    g.edges.push({ id: '4', source: 'a', target: 'ghost', sourceHandle: 'invalid' });
    g.nodes.push({
      id: 'c',
      type: 'commerce.price',
      label: 'C',
      config: {},
      position: { x: 0, y: 0 },
    });
    g.edges.push({ id: '5', source: 'b', target: 'c' });
    const m = msgs(g);
    expect(m).toContain('Triggers cannot have inputs');
    expect(m).toContain('Edge points at a missing node');
    expect(m).toContain('Unknown node type “commerce.price”');
  });

  it('rejects a back-edge from outside the loop body, and into a non-loop', () => {
    const { graph } = WORKFLOW_TEMPLATES['tpl-translate-on-publish']();
    graph.edges.push({ id: 'bad', source: 'init', target: 'each', targetHandle: 'next' });
    graph.edges.push({ id: 'bad2', source: 'translate', target: 'pick', targetHandle: 'next' });
    const m = msgs(graph);
    expect(m.some((x) => x.includes('inside that loop'))).toBe(true);
    expect(m).toContain('Only a Loop node accepts a “next” edge');
  });

  it('warns on duplicate edges and dead-end nodes', () => {
    const g = base();
    g.edges.push({ id: '2b', source: 'a', target: 'b', sourceHandle: 'valid' });
    const { warnings } = validateGraph(g);
    expect(warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining(['Duplicate edge', 'B has no outgoing edge; the run ends there']),
    );
  });

  it('checks node config', () => {
    const g = base();
    g.nodes[1] = {
      ...(g.nodes[1] as WorkflowGraph['nodes'][number]),
      type: 'control.wait',
      config: { duration: 'soon' },
    };
    if (g.edges[1]) g.edges[1].sourceHandle = null;
    expect(msgs(g).some((m) => m.includes('Duration'))).toBe(true);
  });

  it('validates against a registry with extra node specs', () => {
    const registry = createNodeRegistry([
      {
        type: 'acme.ping',
        category: 'content',
        label: 'Ping',
        description: '',
        icon: 'Bell',
        fields: [],
        outputs: ['out'],
      },
    ]);
    const g = base();
    const node = g.nodes[2];
    if (node) node.type = 'acme.ping';
    expect(validateGraph(g, registry).errors).toEqual([]);
    expect(validateGraph(g).errors.map((e) => e.message)).toContain(
      'Unknown node type “acme.ping”',
    );
    expect(() => createNodeRegistry([{ ...(NODE_SPECS[0] as never) }])).toThrow(/already defined/);
  });
});

describe('node config', () => {
  it('fills defaults and validates every built-in spec’s defaults', () => {
    for (const spec of NODE_SPECS) {
      if (spec.fields.some((f) => f.required && f.default === undefined)) continue;
      expect([spec.type, validateConfig(spec.type, {})]).toEqual([spec.type, []]);
    }
  });

  it('requires required fields', () => {
    expect(validateConfig('content.add_to_release', {})).toEqual(['Release is required']);
    expect(validateConfig('content.notify', {})).toEqual(['To is required']);
  });

  it('restricts approval scopes to the known scopes', () => {
    expect(withDefaults('control.approval').requiredScope).toBe('workflow:approve');
    expect(validateConfig('control.approval', { requiredScope: 'content:write' })).toEqual([]);
    expect(validateConfig('control.approval', { requiredScope: 'root:all' })[0]).toMatch(
      /^Who may decide: Expected one of/,
    );
  });

  it('checks cron, policy rules, logic operators and lists', () => {
    expect(validateConfig('trigger.schedule', { cron: 'whenever' })[0]).toMatch(/^Cron:/);
    expect(validateConfig('content.policy', { rules: [] })).toEqual([
      'Rules: Add at least one rule',
    ]);
    expect(validateConfig('content.policy', { rules: [{ rule: 'min_order_amount' }] })[0]).toMatch(
      /^Rules: Rule 1: rule must be one of/,
    );
    expect(validateConfig('control.condition', { expression: { bogus: [1] } })).toEqual([
      'Expression: Unknown operator “bogus”',
    ]);
    expect(validateConfig('ai.classify', { labels: [] })[0]).toMatch(/^Labels:/);
  });

  it('derives outputs from config', () => {
    expect(nodeOutputs('ai.router', { routes: ['a', 'b', ' '] })).toEqual(['a', 'b']);
    expect(nodeOutputs('ai.assess', withDefaults('ai.assess'))).toEqual(['yes', 'no']);
    expect(
      nodeOutputs('ai.assess', {
        ...withDefaults('ai.assess'),
        branchOn: 'audience',
        minConfidence: 0.6,
      }),
    ).toEqual(['beginner', 'practitioner', 'expert', 'unsure']);
    expect(nodeOutputs('ai.enrich', { awaitReview: false })).toEqual(['applied']);
    expect(nodeOutputs('ai.enrich', withDefaults('ai.enrich'))).toEqual([
      'approved',
      'rejected',
      'timeout',
    ]);
    expect(nodeOutputs('nope')).toEqual([]);
  });

  it('checks assess branchOn names a branching question', () => {
    expect(validateConfig('ai.assess', { branchOn: 'missing' })).toEqual([
      'Branch on: no question “missing”',
    ]);
  });

  it('parses durations', () => {
    expect(durationMs('2 days')).toBe(172_800_000);
    expect(durationMs(' 30 seconds ')).toBe(30_000);
    expect(() => durationMs('soon')).toThrow();
  });
});

describe('parseWorkflowGraph', () => {
  it('fills defaults on a minimal graph', () => {
    const r = parseWorkflowGraph({
      nodes: [{ id: 't', type: 'trigger.manual', label: 'Start' }],
      edges: [{ id: 'e', source: 't', target: 'x' }],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        nodes: [
          { id: 't', type: 'trigger.manual', label: 'Start', config: {}, position: { x: 0, y: 0 } },
        ],
        edges: [{ id: 'e', source: 't', target: 'x' }],
      },
    });
  });

  it('reports every shape problem', () => {
    const r = parseWorkflowGraph({
      nodes: [
        { id: 'bad id!', type: 'x', label: 'L' },
        { id: 'ok', type: 'x', label: 'x'.repeat(81), retries: 11, position: { x: 'a' } },
      ],
      edges: [{ id: 1, source: 'a', target: 'b', sourceHandle: 3 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([
        'nodes[0].id: Node ids are 1–40 letters, digits, _ or -',
        'nodes[1].label is longer than 80 characters',
        'nodes[1].position must be { x: number, y: number }',
        'nodes[1].retries must be an integer from 0 to 10',
        'edges[0].id must be a string',
        'edges[0].sourceHandle must be a string or null',
      ]);
    }
    expect(parseWorkflowGraph(null).ok).toBe(false);
    expect(parseWorkflowGraph({ nodes: [] }).ok).toBe(false);
  });

  it('warns when an unguarded router route publishes around an approval', () => {
    const n = (id: string, type: string, config: Record<string, unknown> = {}) => ({
      id,
      type,
      label: id,
      config,
      position: { x: 0, y: 0 },
    });
    const graph = (guards: Record<string, unknown>): WorkflowGraph => ({
      nodes: [
        n('t', 'trigger.manual'),
        n('r', 'ai.router', { routes: ['publish', 'review'], guards }),
        n('ap', 'control.approval'),
        n('p1', 'content.publish'),
        n('p2', 'content.publish'),
      ],
      edges: [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'p1', sourceHandle: 'publish' },
        { id: 'e3', source: 'r', target: 'ap', sourceHandle: 'review' },
        { id: 'e4', source: 'ap', target: 'p2', sourceHandle: 'approved' },
      ],
    });
    const warned = (g: WorkflowGraph) =>
      validateGraph(g).warnings.filter((w) => /add a guard/.test(w.message));
    expect(warned(graph({}))).toHaveLength(1);
    expect(warned(graph({ publish: { '==': [1, 1] } }))).toHaveLength(0);
  });
});

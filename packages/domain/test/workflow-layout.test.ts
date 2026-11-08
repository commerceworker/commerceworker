import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  LAYOUT_COL_WIDTH,
  LAYOUT_ORIGIN_X,
  LAYOUT_ORIGIN_Y,
  LAYOUT_ROW_HEIGHT,
  levelsOf,
  topologyKey,
  WORKFLOW_TEMPLATES,
  type WorkflowGraph,
} from '../src/index';

const node = (id: string) => ({
  id,
  type: 'content.comment',
  label: id,
  config: {},
  position: { x: -1, y: -1 },
});

describe('autoLayout', () => {
  const diamond: WorkflowGraph = {
    nodes: ['t', 'a', 'b', 'j'].map(node),
    edges: [
      { id: '1', source: 't', target: 'a' },
      { id: '2', source: 't', target: 'b' },
      { id: '3', source: 'a', target: 'j' },
      { id: '4', source: 'b', target: 'j' },
    ],
  };

  it('levels nodes by longest forward path', () => {
    expect(Object.fromEntries(levelsOf(diamond))).toEqual({ t: 0, a: 1, b: 1, j: 2 });
  });

  it('positions columns left to right, centred vertically', () => {
    const g = autoLayout(diamond);
    const pos = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
    expect(pos.t).toEqual({ x: LAYOUT_ORIGIN_X, y: LAYOUT_ORIGIN_Y + LAYOUT_ROW_HEIGHT / 2 });
    expect(pos.a).toEqual({ x: LAYOUT_ORIGIN_X + LAYOUT_COL_WIDTH, y: LAYOUT_ORIGIN_Y });
    expect(pos.b).toEqual({
      x: LAYOUT_ORIGIN_X + LAYOUT_COL_WIDTH,
      y: LAYOUT_ORIGIN_Y + LAYOUT_ROW_HEIGHT,
    });
    expect(pos.j?.x).toBe(LAYOUT_ORIGIN_X + 2 * LAYOUT_COL_WIDTH);
    // A copy: the input keeps its positions.
    expect(diamond.nodes[0]?.position).toEqual({ x: -1, y: -1 });
  });

  it('ignores loop back-edges for layering', () => {
    const { graph } = WORKFLOW_TEMPLATES['tpl-translate-on-publish']();
    const levels = levelsOf(graph);
    expect(levels.get('each')).toBe(2);
    expect(levels.get('advance')).toBe(5);
    const xs = new Set(autoLayout(graph).nodes.map((n) => n.position.x));
    expect(xs.size).toBe(6);
  });

  it('orders a column by its parents to reduce crossings', () => {
    const g: WorkflowGraph = {
      nodes: ['t', 'p1', 'p2', 'c2', 'c1'].map(node),
      edges: [
        { id: '1', source: 't', target: 'p1' },
        { id: '2', source: 't', target: 'p2' },
        { id: '3', source: 'p1', target: 'c1' },
        { id: '4', source: 'p2', target: 'c2' },
      ],
    };
    const pos = Object.fromEntries(autoLayout(g).nodes.map((n) => [n.id, n.position.y]));
    expect(Math.sign((pos.c1 ?? 0) - (pos.c2 ?? 0))).toBe(Math.sign((pos.p1 ?? 0) - (pos.p2 ?? 0)));
  });
});

describe('topologyKey', () => {
  it('changes with topology, not with positions or labels', () => {
    const { graph } = WORKFLOW_TEMPLATES['tpl-editorial-review']();
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, label: 'x', position: { x: 0, y: 0 } })),
    };
    expect(topologyKey(moved)).toBe(topologyKey(graph));
    const rewired = { ...graph, edges: graph.edges.slice(1) };
    expect(topologyKey(rewired)).not.toBe(topologyKey(graph));
  });
});

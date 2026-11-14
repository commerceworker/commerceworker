/**
 * Pure graph helpers for the workflow editor, kept apart from the canvas so the palette, the
 * Connections panel and tests use them without loading React Flow: `edgeId`, `wouldCycle`, `makeNode`, `stepName`,
 * `holdPoints`, `frameFocus`, `fitViewport`, `clearRightEdge`, `spreadColumns` and `graphChanges`.
 */

import {
  isBackEdge,
  type NodeRegistry,
  type NodeRun,
  type WorkflowGraph,
  type WorkflowNode,
} from '@commerceworker/domain';

/** The palette's drag payload type. */
export const DRAG_TYPE = 'application/commerceworker-node';

/** A node rect in flow units, as React Flow's `getNodesBounds` returns it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function edgeId(c: {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}) {
  return `${c.source}${c.sourceHandle && c.sourceHandle !== 'out' ? `.${c.sourceHandle}` : ''}-${c.target}${c.targetHandle === 'next' ? '.next' : ''}`;
}

/** Would adding source→target close a forward cycle? */
export function wouldCycle(graph: WorkflowGraph, source: string, target: string) {
  if (source === target) return true;
  const out = new Map<string, string[]>();
  for (const e of graph.edges)
    if (!isBackEdge(e)) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) ?? []));
  }
  return false;
}

/**
 * A step's name for people: its label, or the name of its kind ("Approval") when the label is
 * empty or is only its id (`approve_2`), as a drafted or imported graph can leave it. The id is
 * for expressions, shown in mono beside the name at most, never as the name.
 */
export function stepName(
  n: Pick<WorkflowNode, 'id' | 'label' | 'type'>,
  registry: Pick<NodeRegistry, 'spec'>,
): string {
  const label = n.label?.trim();
  return label && label !== n.id ? label : (registry.spec(n.type)?.label ?? n.type);
}

/** A new node of `type` with defaults and a unique id. */
export function makeNode(
  nodes: NodeRegistry,
  graph: WorkflowGraph,
  type: string,
  position: { x: number; y: number },
): WorkflowNode {
  const spec = nodes.spec(type);
  const base = type.split('.')[1] ?? 'node';
  let i = 1;
  while (graph.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return {
    id: `${base}_${i}`,
    type,
    label: spec?.label ?? type,
    config: nodes.withDefaults(type),
    position,
  };
}

/** Steps are 220px wide; a step overlaps another in its column when their x is closer than that. */
const NODE_WIDTH = 220;
const NODE_GAP = 16;

/** Space kept between a framed workflow and the sheet's edge, in screen pixels. */
export const FRAME_PAD = 24;
/** Wide workflows would shrink to illegible; framing never goes below this zoom. */
export const MIN_READABLE_ZOOM = 0.7;
export const clampZoom = (z: number) => Math.min(1, Math.max(MIN_READABLE_ZOOM, z));
/** Fit view keeps a step's 13px label at 10px or more on screen. */
export const FIT_MIN_ZOOM = 10 / 13;

/** A place where a run waits (for a person, an event or time) or goes round again. */
export type HoldPoint = { id: string; label: string; type: string; kind: string };

/** The workflow's loops and waits, in the order it reads: left to right, then top down. */
export function holdPoints(
  graph: WorkflowGraph,
  registry: Pick<NodeRegistry, 'spec'>,
): HoldPoint[] {
  return graph.nodes
    .flatMap((n) => {
      const spec = registry.spec(n.type);
      // A timed wait isn't `waits` in the catalog (no one acts on it), but runs still sit there.
      const holds = spec?.loop || spec?.waits || n.type === 'control.wait';
      return holds
        ? [
            {
              id: n.id,
              label: stepName(n, registry),
              type: n.type,
              kind: spec?.label ?? n.type,
              at: n.position,
            },
          ]
        : [];
    })
    .sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y)
    .map(({ at: _, ...p }) => p);
}

/**
 * The steps to centre when a canvas opens: the live step(s), or where a finished run stopped or
 * ended; on a workflow being built (no runs), the first place a run waits or loops. None when there
 * is nothing to follow, so the frame opens on the trigger.
 */
export function frameFocus(
  g: WorkflowGraph,
  runs: Record<string, NodeRun> | undefined,
  holds: HoldPoint[],
): string[] {
  const where = (ok: (n: WorkflowNode) => boolean) => g.nodes.filter(ok).map((n) => n.id);
  const live = where((n) => ['running', 'waiting'].includes(runs?.[n.id]?.status ?? ''));
  const stopped = where((n) => ['failed', 'rolled_back'].includes(runs?.[n.id]?.status ?? ''));
  const ended = where(
    (n) => n.type.startsWith('control.end') && runs?.[n.id]?.status === 'succeeded',
  );
  const held = runs ? [] : holds.slice(0, 1).map((p) => p.id);
  return [live, stopped, ended, held].find((ids) => ids.length) ?? [];
}

/**
 * The viewport for Fit view on a `width` × `height` sheet: all of `bounds` (flow units), centred
 * and no larger than 1:1, when it fits at `floor`; otherwise, at `floor`, the part around `anchor`,
 * moved in so the frame doesn't run past the workflow's edges into empty sheet.
 */
export function fitViewport(
  bounds: Rect,
  anchor: { x: number; y: number },
  width: number,
  height: number,
  floor = FIT_MIN_ZOOM,
) {
  const fits = Math.min(
    (width - 2 * FRAME_PAD) / bounds.width,
    (height - 2 * FRAME_PAD) / bounds.height,
  );
  const zoom = fits >= floor ? Math.min(1, fits) : floor;
  const axis = (start: number, size: number, at: number, room: number) => {
    if (size * zoom <= room - 2 * FRAME_PAD) return room / 2 - (start + size / 2) * zoom;
    const first = FRAME_PAD - start * zoom;
    const last = room - FRAME_PAD - (start + size) * zoom;
    return Math.min(first, Math.max(last, room / 2 - at * zoom));
  };
  return {
    x: axis(bounds.x, bounds.width, anchor.x, width),
    y: axis(bounds.y, bounds.height, anchor.y, height),
    zoom,
  };
}

/**
 * The largest zoom, no more than `zoom` and still readable, at which a frame anchored at `originX`
 * (flow units, drawn at FRAME_PAD) ends between columns instead of through a step. `zoom` itself
 * when no such zoom exists.
 */
export function clearRightEdge(
  spans: { left: number; right: number }[],
  originX: number,
  zoom: number,
  width: number,
) {
  const room = width - 2 * FRAME_PAD;
  const clear = (z: number) =>
    spans.every((n) => {
      const left = (n.left - originX) * z;
      const right = (n.right - originX) * z;
      return right <= room + 0.5 || left >= room + FRAME_PAD;
    });
  if (clear(zoom)) return zoom;
  const candidates = spans
    .filter((n) => n.right > originX)
    .map((n) => room / (n.right - originX))
    .filter((z) => z < zoom && z >= MIN_READABLE_ZOOM)
    .sort((a, b) => b - a);
  return candidates.find(clear) ?? zoom;
}

/** Each step's position, moved down below any step above it in its column that it would overlap. */
export function spreadColumns(
  steps: { id: string; position: { x: number; y: number } }[],
  heights: Map<string, number>,
) {
  const placed = new Map(steps.map((n) => [n.id, { ...n.position }]));
  const order = [...steps].sort((a, b) => a.position.y - b.position.y).map((n) => n.id);
  for (let i = 0; i < order.length; i++) {
    const me = placed.get(order[i] as string);
    if (!me) continue;
    for (let j = 0; j < i; j++) {
      const above = placed.get(order[j] as string);
      if (!above) continue;
      const bottom = above.y + (heights.get(order[j] as string) ?? 0) + NODE_GAP;
      if (Math.abs(above.x - me.x) < NODE_WIDTH && above.y <= me.y && bottom > me.y) me.y = bottom;
    }
  }
  return placed;
}

/** The focus steps plus what leads into and out of them, so a framed step keeps its context. */
export function withNeighbours(g: WorkflowGraph, ids: string[]) {
  const set = new Set(ids);
  for (const e of g.edges) {
    if (isBackEdge(e)) continue;
    if (ids.includes(e.target)) set.add(e.source);
    if (ids.includes(e.source)) set.add(e.target);
  }
  return [...set];
}

/** What publishing would change, counted against the published graph (layout moves count once). */
export function graphChanges(published: WorkflowGraph | null, current: WorkflowGraph) {
  if (!published) return { total: 1, summary: '' };
  const strip = (n: WorkflowNode) => JSON.stringify({ ...n, position: null });
  const before = new Map(published.nodes.map((n) => [n.id, strip(n)]));
  const after = new Map(current.nodes.map((n) => [n.id, strip(n)]));
  const added = [...after.keys()].filter((id) => !before.has(id)).length;
  const removed = [...before.keys()].filter((id) => !after.has(id)).length;
  const edited = [...after].filter(([id, v]) => before.has(id) && before.get(id) !== v).length;
  const eb = new Set(published.edges.map((e) => e.id));
  const ea = new Set(current.edges.map((e) => e.id));
  const rewired =
    [...ea].filter((id) => !eb.has(id)).length + [...eb].filter((id) => !ea.has(id)).length;
  const moved = current.nodes.some((n) => {
    const p = published.nodes.find((m) => m.id === n.id);
    return p && (p.position.x !== n.position.x || p.position.y !== n.position.y);
  });
  const parts = [
    added ? `${added} step${added === 1 ? '' : 's'} added` : '',
    removed ? `${removed} removed` : '',
    edited ? `${edited} edited` : '',
    rewired ? `${rewired} connection${rewired === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean);
  return {
    total: added + removed + edited + rewired + (moved ? 1 : 0),
    summary: parts.length ? parts.join(', ') : 'Layout changes only',
  };
}

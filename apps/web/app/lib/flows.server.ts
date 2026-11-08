import { env } from 'cloudflare:workers';
import {
  type Flow,
  type FlowGraph,
  type OrderChannel,
  type OrderModel,
  parseOrderRoutes,
  TEMPLATES,
} from '@commerceworker/core';
import { isDemo } from './demo.server';
import { summarizeFlow } from './new-order';
import { nodeRegistry } from './plugins.server';
import { flowStore } from './wire.server';

let seededAt: number | null = null;

/** How long a demo trusts its last check: its nightly reset removes the templates. */
const DEMO_RESEED_MS = 60_000;

/**
 * Publishes the built-in templates on first use (cheap no-op afterwards). A demo checks again
 * after a minute, since its nightly reset removes them while isolates stay warm.
 */
export async function ensureSeeded() {
  if (seededAt !== null && (!isDemo() || Date.now() - seededAt < DEMO_RESEED_MS)) return;
  await flowStore().seed(Object.values(TEMPLATES).map((t) => t()));
  seededAt = Date.now();
}

/**
 * Every flow for the flows list: its draft's step summary, the live version and whether the draft
 * has changed since it was published. Archived drafts only with `archived`.
 */
export async function listFlows({ archived = false } = {}) {
  await ensureSeeded();
  const rows = (await flowStore().listWithPublished()).filter(
    (f) => (f.archivedAt !== null) === archived,
  );
  const nodes = await nodeRegistry();
  return rows.map(({ nodes: draftNodes, edges, published, channels, ...r }) => {
    const g = { nodes: draftNodes, edges } as FlowGraph;
    const live = published as FlowGraph | null;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      publishedVersion: r.publishedVersion,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
      publishedAt: published?.publishedAt ?? null,
      model: r.model as OrderModel,
      channels: channels as OrderChannel[],
      nodeCount: g.nodes.length,
      summary: summarizeFlow(g, nodes),
      /** Published, and the draft has changed since. */
      dirty: !!live && !sameGraph(g, { nodes: live.nodes, edges: live.edges }),
    };
  });
}

/**
 * Each flow's name and its steps' labels in the order a reader meets them: left to right, then top
 * to bottom, as the editor lays a flow out. From the published version, or the draft if there is
 * none. For placing the overview's waits and failures along their flow; display only.
 */
export async function flowSteps(): Promise<{ id: string; name: string; steps: string[] }[]> {
  const rows = await flowStore().listWithPublished();
  return rows.map((r) => {
    const g = (r.published ?? { nodes: r.nodes, edges: r.edges }) as FlowGraph;
    const steps = [...g.nodes]
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .map((n) => n.label);
    return { id: r.id, name: r.name, steps };
  });
}

/** `ORDER_ROUTES`: inbound `model:channel` (or `model:*`) to flow id. */
export const orderRoutes = () => parseOrderRoutes((env as { ORDER_ROUTES?: string }).ORDER_ROUTES);

/** The flow's name, or null when there is no such flow. */
export async function flowName(id: string) {
  return (await flowStore().flow(id))?.name ?? null;
}

export async function getFlow(id: string) {
  await ensureSeeded();
  const [row, published, versions] = await Promise.all([
    flowStore().flow(id),
    flowStore().version(id),
    flowStore().history(id),
  ]);
  if (!row) return null;
  const graph = { nodes: row.nodes, edges: row.edges } as FlowGraph;
  const flow: Flow = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model as OrderModel,
    channels: row.channels as OrderChannel[],
    ...graph,
  };
  const dirty =
    !published ||
    JSON.stringify({ nodes: published.nodes, edges: published.edges }) !== JSON.stringify(graph);
  const publishedGraph: FlowGraph | null = published
    ? ({ nodes: published.nodes, edges: published.edges } as FlowGraph)
    : null;
  return {
    flow,
    publishedVersion: row.publishedVersion,
    versions,
    dirty,
    publishedGraph,
  };
}

export async function flowCount() {
  return flowStore().count();
}
/** Same nodes and edges, ignoring array order (the editor appends; the store keeps insertion order). */
function sameGraph(a: FlowGraph, b: FlowGraph) {
  const norm = (g: FlowGraph) =>
    JSON.stringify({
      nodes: [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...g.edges].sort((x, y) => x.id.localeCompare(y.id)),
    });
  return norm(a) === norm(b);
}

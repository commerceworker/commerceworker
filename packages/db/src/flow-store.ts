/**
 * The flows port (`FlowStore`, @commerceworker/ports/commerce) on D1, over the flow persistence in
 * ./flows (which the web app also uses). The contract in @commerceworker/test-kit/commerce holds
 * this and the in-memory store to the same behaviour.
 */
import type { FlowVersion } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { FlowRecord, FlowStore } from '@commerceworker/ports/commerce';
import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { getFlowVersionJson, publishFlow, saveDraft, seedFlows } from './flows';
import { createDb } from './index';
import { flows, flowVersions } from './schema';

type Row = typeof flows.$inferSelect;

const recordOf = (r: Row): FlowRecord => {
  const graph = JSON.parse(r.graphJson) as { nodes: unknown[]; edges: unknown[] };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    model: r.model,
    channels: JSON.parse(r.channels) as string[],
    nodes: graph.nodes,
    edges: graph.edges,
    publishedVersion: r.publishedVersion,
    archivedAt: r.archivedAt,
    updatedAt: r.updatedAt,
  };
};

const versionOf = (v: { version: number; publishedAt: number; flow: unknown }): FlowVersion => ({
  ...(v.flow as FlowVersion),
  version: v.version,
  publishedAt: v.publishedAt,
});

export function d1FlowStore(d1: D1Database, clock: Clock): FlowStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  return {
    async flow(id) {
      const row = await d.select().from(flows).where(eq(flows.id, id)).get();
      return row ? recordOf(row) : undefined;
    },

    async list() {
      return (await d.select().from(flows).orderBy(asc(flows.name))).map(recordOf);
    },

    async version(id, version) {
      const v = await getFlowVersionJson(d, id, version);
      return v ? versionOf(v) : null;
    },

    saveDraft: (flow) => saveDraft(d, flow, now()),

    publish: (flow, opts = {}) => publishFlow(d, flow, now(), opts),

    seed: (all) => seedFlows(d, [...all]),

    async setArchived(id, archived) {
      const [row] = await d
        .update(flows)
        .set({ archivedAt: archived ? now() : null })
        .where(and(eq(flows.id, id), isNull(flows.publishedVersion)))
        .returning({ id: flows.id, name: flows.name });
      return row;
    },

    async listWithPublished() {
      const rows = await d
        .select({
          flow: flows,
          json: flowVersions.flowJson,
          publishedAt: flowVersions.publishedAt,
        })
        .from(flows)
        .leftJoin(
          flowVersions,
          and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.publishedVersion)),
        )
        .orderBy(asc(flows.name));
      return rows.map((r) => {
        const live = r.json ? (JSON.parse(r.json) as { nodes: unknown[]; edges: unknown[] }) : null;
        return {
          ...recordOf(r.flow),
          published:
            live && r.publishedAt !== null
              ? { nodes: live.nodes, edges: live.edges, publishedAt: r.publishedAt }
              : null,
        };
      });
    },

    history: (id) =>
      d
        .select({ version: flowVersions.version, publishedAt: flowVersions.publishedAt })
        .from(flowVersions)
        .where(eq(flowVersions.flowId, id))
        .orderBy(desc(flowVersions.version)),

    async count() {
      return (await d.select({ n: count() }).from(flows).get())?.n ?? 0;
    },

    async publishedVersions() {
      const rows = await d
        .select({
          version: flowVersions.version,
          publishedAt: flowVersions.publishedAt,
          json: flowVersions.flowJson,
        })
        .from(flows)
        .innerJoin(
          flowVersions,
          and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.publishedVersion)),
        )
        .where(and(isNotNull(flows.publishedVersion), isNull(flows.archivedAt)));
      return rows.map((r) => versionOf({ ...r, flow: JSON.parse(r.json) }));
    },
  };
}

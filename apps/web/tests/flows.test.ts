import { staticRegistry, TEMPLATES } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/demo.server', () => ({ isDemo: () => false }));
vi.mock('~/lib/plugins.server', () => ({ nodeRegistry: async () => staticRegistry }));

/** Flows in memory; the module seeds the built-in templates into it once. */
const { InMemoryFlowStore } = await import('@commerceworker/test-kit/commerce');
const store = new InMemoryFlowStore();
vi.mock('~/lib/wire.server', () => ({ flowStore: () => store }));

const { flowCount, flowName, flowSteps, getFlow, listFlows } = await import('~/lib/flows.server');

const templates = Object.values(TEMPLATES).map((t) => t());
const first = templates[0]!;

describe('flows over the flow store', () => {
  beforeEach(async () => {
    // Put the first template's draft back as published.
    await store.saveDraft(first);
  });

  it('seeds the templates once and lists them published, unchanged', async () => {
    const list = await listFlows();
    expect(list.map((f) => f.id).sort()).toEqual(templates.map((t) => t.id).sort());
    const mine = list.find((f) => f.id === first.id)!;
    expect(mine).toMatchObject({
      name: first.name,
      publishedVersion: 1,
      dirty: false,
      nodeCount: first.nodes.length,
      publishedAt: expect.any(Number),
    });
    expect(await flowCount()).toBe(templates.length);
    expect(await listFlows({ archived: true })).toEqual([]);
  });

  it('marks a flow dirty once its draft changes, and reads its versions and published graph', async () => {
    await listFlows();
    await store.saveDraft({ ...first, name: first.name, nodes: first.nodes.slice(1) });
    expect((await listFlows()).find((f) => f.id === first.id)?.dirty).toBe(true);
    const got = await getFlow(first.id);
    expect(got).toMatchObject({ publishedVersion: 1, dirty: true });
    expect(got?.versions.map((v) => v.version)).toEqual([1]);
    expect(got?.publishedGraph?.nodes).toHaveLength(first.nodes.length);
    expect(got?.flow.nodes).toHaveLength(first.nodes.length - 1);
    expect(await getFlow('flow_none')).toBeNull();
    expect(await flowName(first.id)).toBe(first.name);
    expect(await flowName('flow_none')).toBeNull();
  });

  it("orders each flow's steps left to right, then top to bottom, from its published version", async () => {
    await listFlows();
    const steps = (await flowSteps()).find((f) => f.id === first.id)!;
    const expected = [...first.nodes]
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .map((n) => n.label);
    expect(steps).toEqual({ id: first.id, name: first.name, steps: expected });
  });
});

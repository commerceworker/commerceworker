/**
 * The behaviour every `FlowStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Flow ids start `fc2_`.
 */
import type { FlowDraft, FlowStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const draft = (id: string, over: Partial<FlowDraft> = {}): FlowDraft => ({
  id,
  name: `Flow ${id}`,
  description: '',
  model: 'b2b',
  channels: ['api'],
  nodes: [{ id: 'start', type: 'trigger.manual' }],
  edges: [],
  ...over,
});

export function describeFlowStoreContract(name: string, make: () => Promise<FlowStore>) {
  describe(`${name}: the flow store contract`, () => {
    it('saves a draft, which reads back with its graph and no published version', async () => {
      const s = await make();
      await s.saveDraft(draft('fc2_a'));
      expect(await s.flow('fc2_a')).toMatchObject({
        id: 'fc2_a',
        channels: ['api'],
        nodes: [{ id: 'start', type: 'trigger.manual' }],
        publishedVersion: null,
        archivedAt: null,
      });
      expect(await s.flow('fc2_none')).toBeUndefined();
      expect(await s.version('fc2_a')).toBeNull();
    });

    it('publishes consecutive versions, each kept as it was', async () => {
      const s = await make();
      expect(await s.publish(draft('fc2_b'))).toBe(1);
      expect(await s.publish(draft('fc2_b', { name: 'Renamed' }))).toBe(2);
      expect(await s.publish(draft('fc2_b', { name: 'Renamed' }), { unlessPublished: true })).toBe(
        2,
      );
      expect((await s.version('fc2_b', 1))?.name).toBe('Flow fc2_b');
      expect(await s.version('fc2_b')).toMatchObject({ name: 'Renamed', version: 2 });
      expect((await s.flow('fc2_b'))?.publishedVersion).toBe(2);
    });

    it('seeds only content never published, and lists every flow by name', async () => {
      const s = await make();
      await s.seed([
        draft('fc2_t1', { name: 'B template' }),
        draft('fc2_t2', { name: 'A template' }),
      ]);
      await s.seed([draft('fc2_t1', { name: 'B template' })]);
      expect((await s.version('fc2_t1'))?.version).toBe(1);
      const names = (await s.list()).filter((f) => f.id.startsWith('fc2_t')).map((f) => f.name);
      expect(names).toEqual(['A template', 'B template']);
    });

    it('archives only a draft never published, and lists what each live flow publishes', async () => {
      const s = await make();
      await s.saveDraft(draft('fc2_draft'));
      await s.publish(draft('fc2_live'));
      expect(await s.setArchived('fc2_draft', true)).toEqual({
        id: 'fc2_draft',
        name: 'Flow fc2_draft',
      });
      expect((await s.flow('fc2_draft'))?.archivedAt).toEqual(expect.any(Number));
      expect(await s.setArchived('fc2_live', true)).toBeUndefined();
      expect(await s.setArchived('fc2_none', true)).toBeUndefined();
      await s.setArchived('fc2_draft', false);
      expect((await s.flow('fc2_draft'))?.archivedAt).toBeNull();
      const live = (await s.publishedVersions()).filter((v) => v.id.startsWith('fc2_'));
      expect(live.map((v) => [v.id, v.version])).toEqual([['fc2_live', 1]]);
    });

    it("lists each flow with the graph it publishes, a flow's history newest first, and counts them", async () => {
      const s = await make();
      const before = await s.count();
      await s.saveDraft(draft('fc2_draft'));
      await s.publish(draft('fc2_live', { nodes: [{ id: 'v1' }] }));
      await s.publish(draft('fc2_live', { nodes: [{ id: 'v2' }] }));
      // A draft edited after publishing still publishes the version before.
      await s.saveDraft(draft('fc2_live', { nodes: [{ id: 'editing' }] }));
      expect(await s.count()).toBe(before + 2);
      const mine = (await s.listWithPublished()).filter((f) => f.id.startsWith('fc2_'));
      const live = mine.find((f) => f.id === 'fc2_live')!;
      expect(live.nodes).toEqual([{ id: 'editing' }]);
      expect(live.published).toEqual({
        nodes: [{ id: 'v2' }],
        edges: [],
        publishedAt: expect.any(Number),
      });
      expect(mine.find((f) => f.id === 'fc2_draft')?.published).toBeNull();
      expect((await s.history('fc2_live')).map((v) => v.version)).toEqual([2, 1]);
      expect(await s.history('fc2_draft')).toEqual([]);
    });
  });
}

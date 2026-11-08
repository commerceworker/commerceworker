import { describe, expect, it } from 'vitest';
import {
  canPublishThroughRun,
  editorialReviewWorkflow,
  gatesCovering,
  moderateThenPublishWorkflow,
  type PublishGate,
  PublishGatedError,
  publishGateIssue,
  WORKFLOW_TEMPLATES,
} from '../src/index';

const gate = (workflowId: string, contentTypes: string[]): PublishGate => ({
  workflowId,
  name: workflowId.toUpperCase(),
  version: 1,
  contentTypes,
});

describe('publish gates', () => {
  it('covers the listed content types, and every type when the list is empty', () => {
    const gates = [gate('posts', ['post']), gate('all', []), gate('pages', ['page'])];
    expect(gatesCovering(gates, 'post').map((g) => g.workflowId)).toEqual(['posts', 'all']);
    expect(gatesCovering(gates, 'event').map((g) => g.workflowId)).toEqual(['all']);
    expect(gatesCovering([gate('posts', ['post'])], 'page')).toEqual([]);
  });

  it('names the entry and its workflows in the refusal, with a stable code', () => {
    const err = new PublishGatedError([
      {
        entryId: 'e1',
        workflows: [
          { id: 'a', name: 'Legal' },
          { id: 'b', name: 'Brand' },
        ],
      },
    ]);
    expect(err.code).toBe('publish_gated');
    expect(err.message).toBe(
      'Entry "e1" publishes only through a run of the workflow "Legal" or "Brand". Start a run of the workflow on it, or have an admin publish a version of the workflow with publish gating off.',
    );
  });

  it('names the release and every refused entry for a release', () => {
    const err = new PublishGatedError(
      [
        { entryId: 'e1', workflows: [{ id: 'a', name: 'Legal' }] },
        { entryId: 'e2', workflows: [{ id: 'a', name: 'Legal' }] },
      ],
      { releaseId: 'r1' },
    );
    expect(err.message).toContain('Release "r1" holds 2 entries');
    expect(err.message).toContain('"e1" ("Legal"), "e2" ("Legal")');
    expect(err.details).toMatchObject({ releaseId: 'r1' });
  });

  it('counts a gate only on a graph a run can publish from', () => {
    const nodes = (...types: string[]) => ({ nodes: types.map((type) => ({ type })) });
    expect(canPublishThroughRun(nodes('trigger.manual', 'content.publish'))).toBe(true);
    expect(canPublishThroughRun(nodes('trigger.manual', 'content.publish_release'))).toBe(true);
    // A trigger nothing starts runs from yet, or no publishing node: no run could publish.
    expect(canPublishThroughRun(nodes('trigger.publish_requested', 'content.publish'))).toBe(false);
    expect(canPublishThroughRun(nodes('trigger.manual', 'content.validate'))).toBe(false);
    expect(canPublishThroughRun(nodes())).toBe(false);

    expect(publishGateIssue(nodes('trigger.manual', 'content.publish'))).toBeNull();
    expect(publishGateIssue(nodes('trigger.entry_created', 'content.publish'))).toMatch(
      /people can start/,
    );
    expect(publishGateIssue(nodes('trigger.manual'))).toMatch(/Publish or Publish release node/);
  });

  it('ships no template that would gate without a run able to publish', () => {
    expect(editorialReviewWorkflow().gatesPublish).toBe(false);
    expect(moderateThenPublishWorkflow().gatesPublish).toBe(false);
    for (const template of Object.values(WORKFLOW_TEMPLATES)) {
      const def = template();
      if (def.gatesPublish) expect(canPublishThroughRun(def.graph), def.id).toBe(true);
    }
  });
});

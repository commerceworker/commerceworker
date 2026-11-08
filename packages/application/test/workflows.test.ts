import {
  editorialReviewWorkflow,
  ForbiddenError,
  InvalidStateError,
  legacyStepsToGraph,
  NotFoundError,
  SCOPES,
  ValidationError,
  validateGraph,
  WorkflowBuilder,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createWorkflowDraft,
  defineWorkflow,
  deleteWorkflow,
  getEntryWorkflowState,
  getWorkflow,
  getWorkflowVersion,
  listWorkflows,
  listWorkflowVersions,
  MAX_WORKFLOW_NODES,
  publishWorkflowVersion,
  SYSTEM_CALLER,
  saveWorkflowDraft,
  transitionEntry,
  validateWorkflowGraph,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

const STEPS = [
  { id: 'draft', name: 'Draft', requiredScope: SCOPES.contentWrite },
  { id: 'review', name: 'In review', requiredScope: SCOPES.contentWrite },
  { id: 'approved', name: 'Approved', requiredScope: SCOPES.contentPublish },
] as const;

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedEntry(ctx: AppContext) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Doc' } },
  });
}

describe('workflows', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('defines a workflow and moves an entry through allowed steps', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });

    const writerScopes = [SCOPES.contentWrite];
    const state = await transitionEntry(
      ctx,
      scope,
      { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'review' },
      writerScopes,
    );
    expect(state.currentStepId).toBe('review');
    expect(await getEntryWorkflowState(ctx, scope, entry.entry.id)).toMatchObject({
      currentStepId: 'review',
      workflowId: wf.id,
    });
  });

  it('forbids entering a step whose required scope the caller lacks', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });

    // A writer (no content:publish) cannot move the entry to "approved".
    await expect(
      transitionEntry(
        ctx,
        scope,
        { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'approved' },
        [SCOPES.contentWrite],
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // An editor with content:publish can.
    const state = await transitionEntry(
      ctx,
      scope,
      { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'approved' },
      [SCOPES.contentWrite, SCOPES.contentPublish],
    );
    expect(state.currentStepId).toBe('approved');
  });

  it('rejects transitioning to an unknown step', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });
    await expect(
      transitionEntry(
        ctx,
        scope,
        { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'nope' },
        [SCOPES.contentWrite, SCOPES.contentPublish],
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('validates the workflow definition (no empty steps, no duplicate ids)', async () => {
    await expect(defineWorkflow(ctx, scope, { name: 'X', steps: [] })).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await expect(
      defineWorkflow(ctx, scope, {
        name: 'X',
        steps: [
          { id: 'a', name: 'A', requiredScope: SCOPES.contentWrite },
          { id: 'a', name: 'A2', requiredScope: SCOPES.contentWrite },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('versioned workflow graphs', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(() => {
    ctx = makeContext();
    store = ctx.store as InMemoryContentStore;
  });

  const template = () => editorialReviewWorkflow();
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it('creates a draft without publishing it and reports validation', async () => {
    const t = template();
    const { workflow, validation } = await createWorkflowDraft(ctx, scope, {
      name: t.name,
      description: t.description,
      contentTypes: ['article'],
      graph: t.graph,
    });
    expect(validation.ok).toBe(true);
    expect(workflow).toMatchObject({
      name: t.name,
      contentTypes: ['article'],
      latestVersion: null,
      legacy: false,
      gatesPublish: false,
      updatedAt: new FixedClock().now().toISOString(),
    });
    expect(workflow.graph).toEqual(t.graph);
    expect(await listWorkflowVersions(ctx, scope, workflow.id)).toEqual([]);
  });

  it('saves an invalid draft (work in progress) but refuses to publish it', async () => {
    const { workflow } = await createWorkflowDraft(ctx, scope, { name: 'WIP' });
    const { validation } = await saveWorkflowDraft(ctx, scope, workflow.id, {
      graph: {
        nodes: [{ id: 'a', type: 'control.end', label: 'End', config: {} }],
        edges: [],
      },
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e) => e.message).join(' ')).toMatch(/trigger/);

    const err = await publishWorkflowVersion(ctx, scope, workflow.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues.length).toBeGreaterThan(0);
    expect(await listWorkflowVersions(ctx, scope, workflow.id)).toEqual([]);
  });

  it('refuses input that is not graph-shaped, bad names and unknown workflows', async () => {
    await expect(
      createWorkflowDraft(ctx, scope, { name: 'X', graph: { nodes: 'nope' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { workflow } = await createWorkflowDraft(ctx, scope, { name: 'X' });
    await expect(
      saveWorkflowDraft(ctx, scope, workflow.id, {
        graph: { nodes: [{ id: 'bad id!', type: 'x', label: 'x' }], edges: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(saveWorkflowDraft(ctx, scope, workflow.id, { name: '  ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(saveWorkflowDraft(ctx, scope, 'missing', { name: 'Y' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(publishWorkflowVersion(ctx, scope, 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('publishes numbered, immutable versions that later draft edits never change', async () => {
    const t = template();
    const { workflow } = await createWorkflowDraft(ctx, scope, { name: 'Review', graph: t.graph });

    const v1 = await publishWorkflowVersion(ctx, scope, workflow.id, { publishedBy: 'key-1' });
    expect(v1).toMatchObject({ id: workflow.id, version: 1, name: 'Review', publishedBy: 'key-1' });
    expect(v1.publishedAt).toBe(new FixedClock().now().toISOString());

    const edited = copy(t.graph);
    edited.nodes[0]!.label = 'Changed';
    await saveWorkflowDraft(ctx, scope, workflow.id, { name: 'Review v2', graph: edited });

    // Mutating what a read returned must not reach storage either.
    v1.graph.nodes[0]!.label = 'Tampered';
    const stored = await getWorkflowVersion(ctx, scope, workflow.id, 1);
    expect(stored.name).toBe('Review');
    expect(stored.graph).toEqual(t.graph);

    const v2 = await publishWorkflowVersion(ctx, scope, workflow.id);
    expect(v2.version).toBe(2);
    expect(v2.name).toBe('Review v2');
    expect(v2.graph.nodes[0]!.label).toBe('Changed');

    const versions = await listWorkflowVersions(ctx, scope, workflow.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect((await getWorkflow(ctx, scope, workflow.id)).latestVersion).toBe(2);
  });

  it('keeps versions loadable after the workflow is deleted', async () => {
    const { workflow } = await createWorkflowDraft(ctx, scope, {
      name: 'Review',
      graph: template().graph,
    });
    await publishWorkflowVersion(ctx, scope, workflow.id);
    await deleteWorkflow(ctx, scope, workflow.id);
    await expect(getWorkflow(ctx, scope, workflow.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listWorkflowVersions(ctx, scope, workflow.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getWorkflowVersion(ctx, scope, workflow.id, 1)).version).toBe(1);
    await expect(getWorkflowVersion(ctx, scope, workflow.id, 2)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getWorkflowVersion(ctx, scope, workflow.id, 0)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('isolates drafts and versions by scope', async () => {
    const { workflow } = await createWorkflowDraft(ctx, scope, {
      name: 'Review',
      graph: template().graph,
    });
    await publishWorkflowVersion(ctx, scope, workflow.id);
    const other = { spaceId: 'space-1', environmentId: 'staging' };
    expect(await listWorkflows(ctx, other)).toEqual([]);
    await expect(getWorkflowVersion(ctx, other, workflow.id, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  describe('how published workflows start', () => {
    const startsOn = (type: string) =>
      new WorkflowBuilder()
        .n('start', type, 'Start')
        .n('done', 'control.end', 'Done')
        .e('start', 'done')
        .graph();
    const make = async (
      name: string,
      type: string,
      contentTypes: string[],
      { publish = true, at = scope } = {},
    ) => {
      const { workflow } = await createWorkflowDraft(ctx, at, {
        name,
        contentTypes,
        graph: startsOn(type),
      });
      if (publish) await publishWorkflowVersion(ctx, at, workflow.id);
      return workflow.id;
    };
    const byName = async (at = scope) => {
      const list = await listWorkflows(ctx, at);
      const name = new Map(list.map((w) => [w.id, w.name]));
      return Object.fromEntries(
        list.map((w) => [
          w.name,
          {
            trigger: w.publishedTrigger,
            alongside: w.startsAlongside?.map((id) => name.get(id)).sort() ?? null,
          },
        ]),
      );
    };

    it('reads the trigger and the overlapping workflows from the published versions', async () => {
      await make('Articles', 'trigger.manual', ['article']);
      await make('Everything', 'trigger.manual', []);
      await make('Pages', 'trigger.manual', ['page']);
      await make('Announce', 'trigger.entry_published', ['article']);
      await make('Unpublished', 'trigger.manual', ['article'], { publish: false });
      // Published on "Entry published"; its draft has since moved to "Submit for review".
      const moved = await make('Moved', 'trigger.entry_published', []);
      await saveWorkflowDraft(ctx, scope, moved, { graph: startsOn('trigger.manual') });

      const manual = { type: 'trigger.manual', label: 'Submit for review' };
      const published = { type: 'trigger.entry_published', label: 'Entry published' };
      expect(await byName()).toEqual({
        // An empty content-type list covers every type, so it meets both narrower ones.
        Articles: { trigger: manual, alongside: ['Everything'] },
        Everything: { trigger: manual, alongside: ['Articles', 'Pages'] },
        Pages: { trigger: manual, alongside: ['Everything'] },
        // The published version decides, not the draft: Moved still starts on publish.
        Announce: { trigger: published, alongside: ['Moved'] },
        Moved: { trigger: published, alongside: ['Announce'] },
        // A draft never published starts nothing and is nobody's neighbour.
        Unpublished: { trigger: null, alongside: null },
      });
    });

    it('never counts a workflow published in another environment', async () => {
      const staging = { spaceId: 'space-1', environmentId: 'staging' };
      await make('Here', 'trigger.manual', []);
      await make('There', 'trigger.manual', [], { at: staging });
      expect((await byName()).Here?.alongside).toEqual([]);
      expect((await byName(staging)).There?.alongside).toEqual([]);
    });
  });

  it('validates a graph without saving it', () => {
    expect(validateWorkflowGraph(template().graph)).toMatchObject({ ok: true, errors: [] });
    expect(validateWorkflowGraph({ nodes: [], edges: [] }).ok).toBe(false);
    expect(validateWorkflowGraph('nope')).toMatchObject({ ok: false });
    const huge = {
      nodes: Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, i) => ({
        id: `n${i}`,
        type: 'control.end',
        label: 'x',
      })),
      edges: [],
    };
    expect(validateWorkflowGraph(huge).errors[0]?.message).toMatch(/at most/);
  });

  describe('legacy steps compatibility', () => {
    it('create-with-steps converts the steps, publishes v1 and still returns steps', async () => {
      const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });
      expect(wf.steps).toEqual(STEPS);
      expect(wf.legacy).toBe(false);
      expect(wf.latestVersion).toBe(1);
      expect(wf.graph).toEqual(legacyStepsToGraph({ steps: STEPS }));
      expect(validateGraph(wf.graph).errors).toEqual([]);

      const v1 = await getWorkflowVersion(ctx, scope, wf.id, 1);
      expect(v1.graph).toEqual(wf.graph);
      // The steps view the legacy repo (and transitionEntry) reads stays in step.
      expect(await store.workflows.getDefinition(scope, wf.id)).toEqual({
        id: wf.id,
        name: 'Editorial',
        steps: STEPS,
      });
    });

    it('reads a steps-only row with a converted graph and writes it on first publish', async () => {
      // A row written before graphs existed.
      await store.workflows.saveDefinition(scope, { id: 'old', name: 'Old', steps: [...STEPS] });
      const read = await getWorkflow(ctx, scope, 'old');
      expect(read).toMatchObject({ legacy: true, latestVersion: null, steps: STEPS });
      expect(read.graph).toEqual(legacyStepsToGraph({ steps: STEPS }));
      expect((await listWorkflows(ctx, scope)).map((w) => w.id)).toEqual(['old']);
      expect((await store.workflowGraphs.get(scope, 'old'))?.graph).toBeNull();

      const v1 = await publishWorkflowVersion(ctx, scope, 'old');
      expect(v1.version).toBe(1);
      const after = await getWorkflow(ctx, scope, 'old');
      expect(after).toMatchObject({ legacy: false, latestVersion: 1, steps: STEPS });
      expect((await store.workflowGraphs.get(scope, 'old'))?.graph).toEqual(read.graph);
    });

    it('a draft save of a steps-only row writes its converted graph', async () => {
      await store.workflows.saveDefinition(scope, { id: 'old', name: 'Old', steps: [...STEPS] });
      const { workflow } = await saveWorkflowDraft(ctx, scope, 'old', {
        description: 'now a graph',
      });
      expect(workflow).toMatchObject({ legacy: false, description: 'now a graph', steps: STEPS });
    });

    it('graph edits re-derive the steps that transitions gate on', async () => {
      const entry = await seedEntry(ctx);
      const { workflow } = await createWorkflowDraft(ctx, scope, {
        name: 'Two stages',
        graph: legacyStepsToGraph({ steps: STEPS.slice(0, 2) }),
      });
      expect(workflow.steps.map((s) => s.id)).toEqual(['draft', 'review']);
      const move = () =>
        transitionEntry(
          ctx,
          scope,
          { entryId: entry.entry.id, workflowId: workflow.id, toStepId: 'approved' },
          [SCOPES.contentWrite, SCOPES.contentPublish],
        );
      await expect(move()).rejects.toBeInstanceOf(NotFoundError);

      await saveWorkflowDraft(ctx, scope, workflow.id, {
        graph: legacyStepsToGraph({ steps: STEPS }),
      });
      expect((await move()).currentStepId).toBe('approved');
    });
  });
});

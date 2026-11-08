import {
  type BulkChunkDueEvent,
  editorialReviewWorkflow,
  type Principal,
  PublishGatedError,
  type RunContext,
  SCOPES,
  ValidationError,
  WorkflowBuilder,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addEntryToRelease,
  bulkEntryAction,
  createContentType,
  createEntry,
  createEnvironment,
  createRelease,
  createSpace,
  createWorkflowDraft,
  deleteWorkflow,
  executeWorkflowNode,
  exportSnapshot,
  getBulkJobReport,
  getRelease,
  getWorkflow,
  importSnapshot,
  listScheduledActions,
  listWorkflows,
  loadRunEntry,
  publishEntry,
  publishRelease,
  publishWorkflowVersion,
  runBulkChunk,
  runDueScheduledActions,
  SYSTEM_CALLER,
  saveWorkflowDraft,
  scheduleAction,
  startBulkJob,
} from '../src/index';
import type { PublishGrant } from '../src/publish-gate';

const scope = { spaceId: 'blog', environmentId: 'main' };
const editor: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};

/** Submit for review → approval → publish: a graph a run can publish from. */
const reviewGraph = () =>
  new WorkflowBuilder()
    .n('start', 'trigger.manual', 'Submit for review')
    .n('review', 'control.approval', 'Review')
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Done')
    .n('no', 'control.end', 'Declined', { outcome: 'declined' })
    .e('start', 'review')
    .e('review.approved', 'publish')
    .e('review.rejected', 'no')
    .e('publish', 'done')
    .graph();

const field = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol' as const,
  localized: false,
  required: true,
  position: 0,
};

describe('publish gating', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    const clock = new FixedClock(new Date('2026-05-01T09:00:00.000Z'));
    store.nowMs = () => clock.now().getTime();
    ctx = { store, clock, ids: new SequenceIdGenerator('id') };
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    for (const apiId of ['post', 'page']) {
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId,
        name: apiId,
        displayField: 'title',
        fields: [field],
      });
    }
  });

  const draft = async (contentTypeApiId: string, title = 'Hello') =>
    (await createEntry(ctx, scope, { contentTypeApiId, fields: { title: { 'en-US': title } } }))
      .entry.id;

  /** A workflow with the editorial-review graph, published once (unless `publish` is false). */
  const workflow = async (
    name: string,
    opts: { contentTypes?: string[]; gatesPublish?: boolean; publish?: boolean } = {},
  ) => {
    const { workflow: created } = await createWorkflowDraft(ctx, scope, {
      name,
      contentTypes: opts.contentTypes ?? [],
      graph: reviewGraph(),
      gatesPublish: opts.gatesPublish ?? true,
    });
    if (opts.publish !== false) await publishWorkflowVersion(ctx, scope, created.id);
    return created.id;
  };

  /** The entry's delivery snapshot, or null when it is not live. */
  const live = (at: typeof scope, id: string) => store.entries.getPublished(at, id);

  const gated = (err: unknown): PublishGatedError => {
    expect(err).toBeInstanceOf(PublishGatedError);
    return err as PublishGatedError;
  };

  /** Runs a workflow node as the interpreter would, inside a run of `workflowId`. */
  const runNode = async (
    workflowId: string,
    entryId: string,
    type: string,
    config: Record<string, unknown> = {},
  ) => {
    const entry = await loadRunEntry(ctx, scope, entryId);
    const run: RunContext = { entry, nodes: {}, vars: {}, input: {}, now: 0, ref: entry.title };
    return executeWorkflowNode(
      ctx,
      {},
      {
        scope,
        runId: `run-${workflowId}`,
        workflowId,
        entryId,
        actor: { id: 'editor', principal: editor },
        node: { id: 'n', type, label: 'Node', config, position: { x: 0, y: 0 } },
        run,
        effectKey: 'n#1',
        retriesLeft: false,
      },
    );
  };

  describe('single-entry publish', () => {
    it('refuses an entry a gated workflow covers, naming the workflow, and writes nothing', async () => {
      const wf = await workflow('Editorial review', { contentTypes: ['post'] });
      const id = await draft('post');
      const err = gated(await publishEntry(ctx, scope, id).catch((e) => e));
      expect(err.code).toBe('publish_gated');
      expect(err.message).toContain('"Editorial review"');
      expect(err.entries).toEqual([
        { entryId: id, workflows: [{ id: wf, name: 'Editorial review' }] },
      ]);
      expect(await live(scope, id)).toBeNull();
      expect(store.allEvents().filter((e) => e.type === 'entry.published')).toHaveLength(0);
    });

    it('lets types the workflow does not cover publish; empty contentTypes covers every type', async () => {
      await workflow('Posts only', { contentTypes: ['post'] });
      const page = await draft('page');
      await expect(publishEntry(ctx, scope, page)).resolves.toMatchObject({ status: 'published' });

      await workflow('Everything');
      const other = await draft('page', 'Other');
      gated(await publishEntry(ctx, scope, other).catch((e) => e));
    });

    it('names every workflow covering the entry', async () => {
      const a = await workflow('Legal');
      const b = await workflow('Brand', { contentTypes: ['post'] });
      const id = await draft('post');
      const err = gated(await publishEntry(ctx, scope, id).catch((e) => e));
      expect(err.entries[0]?.workflows.map((w) => w.id).sort()).toEqual([a, b].sort());
      expect(err.message).toContain('"Legal" or "Brand"');
    });

    it('reads gating from the latest published version, never the draft', async () => {
      // Gated in a draft that was never published: nothing runs it, so nothing is gated.
      await workflow('Unpublished', { publish: false });
      const id = await draft('post');
      await expect(publishEntry(ctx, scope, id)).resolves.toMatchObject({ status: 'published' });

      // Published ungated, then gating turned on in the draft only: still not gated.
      const wf = await workflow('Later', { gatesPublish: false });
      await saveWorkflowDraft(ctx, scope, wf, { gatesPublish: true });
      const second = await draft('post', 'Second');
      await expect(publishEntry(ctx, scope, second)).resolves.toBeTruthy();

      // Once that version is published, it gates.
      await publishWorkflowVersion(ctx, scope, wf);
      const third = await draft('post', 'Third');
      gated(await publishEntry(ctx, scope, third).catch((e) => e));
    });

    it('turning gating off (a published version without it) restores direct publish', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      gated(await publishEntry(ctx, scope, id).catch((e) => e));

      await saveWorkflowDraft(ctx, scope, wf, { gatesPublish: false });
      // The draft alone changes nothing until it is published.
      gated(await publishEntry(ctx, scope, id).catch((e) => e));
      await publishWorkflowVersion(ctx, scope, wf);
      await expect(publishEntry(ctx, scope, id)).resolves.toMatchObject({ status: 'published' });
    });

    it('a deleted workflow no longer gates', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      gated(await publishEntry(ctx, scope, id).catch((e) => e));
      await deleteWorkflow(ctx, scope, wf);
      await expect(publishEntry(ctx, scope, id)).resolves.toBeTruthy();
    });

    it('a gate in one environment does not reach another', async () => {
      await workflow('Editorial review');
      await createEnvironment(ctx, 'blog', 'staging');
      const staging = { spaceId: 'blog', environmentId: 'staging' };
      await createContentType(ctx, SYSTEM_CALLER, staging, {
        apiId: 'post',
        name: 'post',
        displayField: 'title',
        fields: [field],
      });
      const { entry } = await createEntry(ctx, staging, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Staged' } },
      });
      await expect(publishEntry(ctx, staging, entry.id)).resolves.toBeTruthy();
    });

    it('ignores a grant-shaped object it did not mint (as request input would be)', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      const forged = { kind: 'workflow_run', workflowId: wf, runId: 'r' } as PublishGrant;
      gated(await publishEntry(ctx, scope, id, { grant: forged }).catch((e) => e));
      const parsed = JSON.parse(JSON.stringify({ grant: forged }));
      gated(await publishEntry(ctx, scope, id, parsed).catch((e) => e));
    });
  });

  describe('only a gate a run can publish through counts', () => {
    it('refuses to publish a gated version no run could publish from (422), naming why', async () => {
      const { workflow: noPublish, validation } = await createWorkflowDraft(ctx, scope, {
        name: 'No publish node',
        gatesPublish: true,
        graph: new WorkflowBuilder()
          .n('start', 'trigger.manual', 'Submit')
          .n('done', 'control.end', 'Done')
          .e('start', 'done')
          .graph(),
      });
      // Saving a draft only warns: drafts may be incomplete.
      expect(validation.warnings.map((w) => w.message)).toContainEqual(
        expect.stringMatching(/needs a Publish or Publish release node/),
      );
      const err = await publishWorkflowVersion(ctx, scope, noPublish.id).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toEqual([
        { field: 'gatesPublish', message: expect.stringMatching(/Publish or Publish release/) },
      ]);

      // The editorial template's trigger (publish_requested) starts no runs yet.
      const { workflow: template, validation: saved } = await createWorkflowDraft(ctx, scope, {
        name: 'Template',
        gatesPublish: true,
        graph: editorialReviewWorkflow().graph,
      });
      expect(saved.warnings.map((w) => w.message)).toContainEqual(
        expect.stringMatching(/people can start/),
      );
      await expect(publishWorkflowVersion(ctx, scope, template.id)).rejects.toBeInstanceOf(
        ValidationError,
      );
      // Ungated, the same graph publishes as before.
      await saveWorkflowDraft(ctx, scope, template.id, { gatesPublish: false });
      await expect(publishWorkflowVersion(ctx, scope, template.id)).resolves.toMatchObject({
        version: 1,
      });
    });

    it('an existing gated version whose trigger can’t start runs doesn’t gate', async () => {
      // As a version published before the rule: written straight to the store.
      const { workflow: created } = await createWorkflowDraft(ctx, scope, {
        name: 'Old editorial review',
        graph: editorialReviewWorkflow().graph,
      });
      await store.workflowGraphs.publishVersion(
        scope,
        { ...editorialReviewWorkflow(), id: created.id, gatesPublish: true },
        { publishedAt: '2026-04-01T00:00:00.000Z' },
      );
      expect((await store.workflowGraphs.getLatestVersion(scope, created.id))?.gatesPublish).toBe(
        true,
      );
      const id = await draft('post');
      await expect(publishEntry(ctx, scope, id)).resolves.toMatchObject({ status: 'published' });
      expect((await getWorkflow(ctx, scope, created.id)).publishGated).toBe(false);
    });

    it('reports whether gating is in force on the workflow, separately from the draft flag', async () => {
      const wf = await workflow('Editorial review');
      expect(await getWorkflow(ctx, scope, wf)).toMatchObject({
        gatesPublish: true,
        publishGated: true,
      });
      await saveWorkflowDraft(ctx, scope, wf, { gatesPublish: false });
      expect((await listWorkflows(ctx, scope))[0]).toMatchObject({
        gatesPublish: false,
        publishGated: true,
      });
      await publishWorkflowVersion(ctx, scope, wf);
      expect((await getWorkflow(ctx, scope, wf)).publishGated).toBe(false);
    });
  });

  describe('from a workflow run', () => {
    it('content.publish in a run of the gated workflow publishes', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      const result = await runNode(wf, id, 'content.publish');
      expect(result.failed).toBeUndefined();
      expect(result.output).toMatchObject({ publishedByRun: true, version: 1 });
      expect(await live(scope, id)).toBeTruthy();
    });

    it('a run of any one covering workflow may publish', async () => {
      await workflow('Legal');
      const brand = await workflow('Brand');
      const id = await draft('post');
      expect((await runNode(brand, id, 'content.publish')).failed).toBeUndefined();
    });

    it('a run of a workflow that does not cover the entry cannot pass another one’s gate', async () => {
      await workflow('Editorial review', { contentTypes: ['post'] });
      const other = await workflow('Pages', { contentTypes: ['page'] });
      const ungated = await workflow('Ungated', { gatesPublish: false });
      const id = await draft('post');
      for (const wf of [other, ungated]) {
        const result = await runNode(wf, id, 'content.publish');
        expect(result.failed).toContain('publishes only through a run of the workflow');
      }
      expect(await live(scope, id)).toBeNull();
    });

    it('content.publish_release in a run of the gated workflow ships the release', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      const release = await createRelease(ctx, scope, { title: 'Launch' });
      await addEntryToRelease(ctx, scope, release.id, { entityId: id });
      const result = await runNode(wf, id, 'content.publish_release', { releaseId: release.id });
      expect(result.failed).toBeUndefined();
      expect((await getRelease(ctx, scope, release.id)).release.status).toBe('published');
      expect(await live(scope, id)).toBeTruthy();
    });
  });

  describe('bulk publish', () => {
    it('reports a gated entry as a failed item and publishes the rest', async () => {
      await workflow('Editorial review', { contentTypes: ['post'] });
      const post = await draft('post');
      const page = await draft('page');
      const summary = await bulkEntryAction(ctx, scope, 'publish', [post, page]);
      expect(summary).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
      const failure = summary.results.find((r) => r.id === post);
      expect(failure?.ok).toBe(false);
      expect(failure?.error).toContain('"Editorial review"');
      expect(await live(scope, page)).toBeTruthy();
      expect(await live(scope, post)).toBeNull();
    });

    it('a bulk job records gated entries as failures in its report', async () => {
      await workflow('Editorial review', { contentTypes: ['post'] });
      const post = await draft('post');
      const page = await draft('page');
      const job = await startBulkJob(ctx, scope, { action: 'publish', entryIds: [post, page] });
      const [due] = store
        .allEvents()
        .filter((e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due');
      const outcome = await runBulkChunk(ctx, due as BulkChunkDueEvent);
      expect(outcome).toMatchObject({ outcome: 'processed', succeeded: 1, failed: 1 });

      // A redelivered chunk is skipped, not re-run: the counts stand.
      expect(await runBulkChunk(ctx, due as BulkChunkDueEvent)).toEqual({ outcome: 'skipped' });
      const report = await getBulkJobReport(ctx, scope, job.id);
      expect(report.chunks[0]?.failures).toEqual([
        { id: post, error: expect.stringContaining('publishes only through') },
      ]);
      expect(await live(scope, page)).toBeTruthy();
    });
  });

  describe('releases', () => {
    it('adding a gated entry is allowed; publishing the release is refused whole', async () => {
      await workflow('Editorial review', { contentTypes: ['post'] });
      const post = await draft('post');
      const page = await draft('page');
      const release = await createRelease(ctx, scope, { title: 'Launch' });
      await addEntryToRelease(ctx, scope, release.id, { entityId: post });
      await addEntryToRelease(ctx, scope, release.id, { entityId: page });

      const err = gated(await publishRelease(ctx, scope, release.id).catch((e) => e));
      expect(err.message).toContain(`Release "${release.id}"`);
      expect(err.entries.map((e) => e.entryId)).toEqual([post]);
      // All-or-nothing: the ungated member did not ship either.
      expect(await live(scope, page)).toBeNull();
      expect((await getRelease(ctx, scope, release.id)).release.status).toBe('open');
    });

    it('re-checks at publish time: gating turned on after the entry was added refuses', async () => {
      const id = await draft('post');
      const release = await createRelease(ctx, scope, { title: 'Launch' });
      await addEntryToRelease(ctx, scope, release.id, { entityId: id });
      await workflow('Editorial review');
      gated(await publishRelease(ctx, scope, release.id).catch((e) => e));
    });

    it('does not gate an unpublish member', async () => {
      const id = await draft('post');
      await publishEntry(ctx, scope, id);
      await workflow('Editorial review');
      const release = await createRelease(ctx, scope, { title: 'Withdraw' });
      await addEntryToRelease(ctx, scope, release.id, { entityId: id, action: 'unpublish' });
      await expect(publishRelease(ctx, scope, release.id)).resolves.toBeTruthy();
      expect(await live(scope, id)).toBeNull();
    });
  });

  describe('scheduled publishes', () => {
    it('refuses to schedule a publish a gated workflow covers (entry or release)', async () => {
      await workflow('Editorial review');
      const id = await draft('post');
      const at = '2026-05-02T09:00:00.000Z';
      gated(
        await scheduleAction(ctx, scope, {
          action: 'publish',
          entityType: 'Entry',
          entityId: id,
          scheduledFor: at,
        }).catch((e) => e),
      );
      const release = await createRelease(ctx, scope, { title: 'Launch' });
      await addEntryToRelease(ctx, scope, release.id, { entityId: id });
      gated(
        await scheduleAction(ctx, scope, {
          action: 'publish',
          entityType: 'Release',
          entityId: release.id,
          scheduledFor: at,
        }).catch((e) => e),
      );
      // Unpublishing is never gated.
      await expect(
        scheduleAction(ctx, scope, {
          action: 'unpublish',
          entityType: 'Entry',
          entityId: id,
          scheduledFor: at,
        }),
      ).resolves.toBeTruthy();
    });

    it('fails a due publish, with the reason, when gating was turned on after scheduling', async () => {
      const id = await draft('post');
      await scheduleAction(ctx, scope, {
        action: 'publish',
        entityType: 'Entry',
        entityId: id,
        scheduledFor: '2026-05-01T08:00:00.000Z',
      });
      await workflow('Editorial review');
      expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 1 });
      const [action] = await listScheduledActions(ctx, scope);
      expect(action?.status).toBe('failed');
      expect(action?.error).toContain('"Editorial review"');
      expect(await live(scope, id)).toBeNull();
      // A failed action is terminal: the next tick does not retry it.
      expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    });

    it('content.schedule in a gated workflow cannot schedule a publish of what it gates', async () => {
      const wf = await workflow('Editorial review');
      const id = await draft('post');
      const result = await runNode(wf, id, 'content.schedule', { after: '1 hour' });
      expect(result.failed).toContain('publishes only through');
    });
  });

  it('a snapshot import republishes into a fresh environment despite the gates it copies', async () => {
    await workflow('Editorial review', { gatesPublish: false });
    const id = await draft('post');
    await publishEntry(ctx, scope, id);
    // Gated after the entry went live: the copy must still carry it published.
    const wf = (await store.workflowGraphs.list(scope))[0]?.id as string;
    await saveWorkflowDraft(ctx, scope, wf, { gatesPublish: true });
    await publishWorkflowVersion(ctx, scope, wf);

    const snapshot = await exportSnapshot(ctx, scope);
    await createEnvironment(ctx, 'blog', 'copy');
    const copy = { spaceId: 'blog', environmentId: 'copy' };
    await importSnapshot(ctx, copy, snapshot);
    expect(await live(copy, id)).toBeTruthy();
    // And in the copy, the gate holds for ordinary publishes.
    const { entry } = await createEntry(ctx, copy, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'New' } },
    });
    gated(await publishEntry(ctx, copy, entry.id).catch((e) => e));
  });
});

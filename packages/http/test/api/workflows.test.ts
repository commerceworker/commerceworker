import { type AppContext, createAgentReview } from '@commerceworker/application';
import { WorkflowBuilder } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { RecordingEmailSender } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { makeTestWorkflowEngine } from '../workflow-engine-harness';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const reviewGraph = () =>
  new WorkflowBuilder()
    .n('start', 'trigger.manual', 'Submit')
    .n('review', 'control.approval', 'Editor review', { title: 'Review {{ref}}' })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Done')
    .n('no', 'control.end', 'Declined', { outcome: 'declined', reason: 'Not approved' })
    .e('start', 'review')
    .e('review.approved', 'publish')
    .e('publish', 'done')
    .e('review.rejected', 'no')
    .graph();

type Json = Record<string, unknown>;

describe('workflow routes', () => {
  let app: ReturnType<typeof createApp>;
  let harness: ReturnType<typeof makeTestWorkflowEngine>;
  let entryId: string;
  let pageEntryId: string;
  let ctx: AppContext;

  const call = async (method: string, path: string, body?: unknown, headers = admin) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };

  const publishedWorkflow = async (contentTypes: string[] = []) => {
    const created = await call('POST', '/workflows', {
      name: 'Review',
      contentTypes,
      graph: reviewGraph(),
    });
    const id = (created.body.workflow as Json).id as string;
    await call('POST', `/workflows/${id}/versions`);
    return id;
  };

  beforeEach(async () => {
    const wired = wire(config);
    ctx = wired.ctx;
    harness = makeTestWorkflowEngine(wired.ctx, { email: new RecordingEmailSender() });
    app = createApp(
      wired.ctx,
      config,
      wired.rag,
      wired.blob,
      wired.ai,
      inMemoryEdge(),
      wired.bus,
      undefined,
      undefined,
      { workflowEngine: harness.engine, workflowNodes: { ai: wired.ai } },
    );
    for (const apiId of ['post', 'page']) {
      await call('POST', '/content-types', {
        apiId,
        name: apiId,
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 0,
          },
        ],
      });
      await call('POST', `/content-types/${apiId}/published`);
    }
    const post = await call('POST', '/entries', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    entryId = (post.body.entry as Json).id as string;
    const page = await call('POST', '/entries', {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'About' } },
    });
    pageEntryId = (page.body.entry as Json).id as string;
  });

  it('keeps the legacy steps create and publishes it as version 1', async () => {
    const res = await call('POST', '/workflows', {
      name: 'Legacy',
      steps: [
        { id: 'draft', name: 'Draft', requiredScope: 'content:write' },
        { id: 'review', name: 'Review', requiredScope: 'content:publish' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Legacy', latestVersion: 1 });
    expect((res.body.steps as unknown[]).length).toBe(2);
  });

  it('creates a draft, saves it, validates, publishes and lists versions', async () => {
    const created = await call('POST', '/workflows', { name: 'Draft only' });
    expect(created.status).toBe(201);
    const wf = created.body.workflow as Json;
    expect(wf).toMatchObject({ name: 'Draft only', latestVersion: null });

    // An empty draft can't be published.
    expect((await call('POST', `/workflows/${wf.id}/versions`)).status).toBe(422);

    const saved = await call('PUT', `/workflows/${wf.id}/draft`, {
      description: 'Editor review',
      graph: reviewGraph(),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.validation).toMatchObject({ ok: true });
    expect(saved.body.workflow).toMatchObject({ name: 'Draft only', description: 'Editor review' });

    const v = await call('POST', `/workflows/${wf.id}/versions`);
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ version: 1, publishedBy: 'admin-token' });

    const list = await call('GET', `/workflows/${wf.id}/versions`, undefined, cpa);
    expect(list.status).toBe(200);
    expect((list.body.items as Json[]).map((x) => x.version)).toEqual([1]);
    expect((await call('GET', `/workflows/${wf.id}/versions/1`, undefined, cpa)).status).toBe(200);
    expect((await call('GET', `/workflows/${wf.id}/versions/2`, undefined, cpa)).status).toBe(404);

    // Writes need content:manage.
    expect((await call('PUT', `/workflows/${wf.id}/draft`, { name: 'x' }, cpa)).status).toBe(403);
  });

  it('validates a graph without saving and refuses a malformed graph on save', async () => {
    const good = await call('POST', '/workflows/validate', { graph: reviewGraph() }, cpa);
    expect(good).toMatchObject({ status: 200, body: { ok: true } });
    const bad = await call('POST', '/workflows/validate', { graph: { nodes: 'nope' } });
    expect(bad.body.ok).toBe(false);
    const refused = await call('POST', '/workflows', { name: 'Bad', graph: { nodes: 'nope' } });
    expect(refused.status).toBe(422);
  });

  it('answers a copilot proposal with a summary and never saves', async () => {
    const before = await call('GET', '/workflows');
    const res = await call('POST', '/workflows/copilot', { prompt: 'Add an approval step' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('graph');
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('provenance');
    expect((await call('GET', '/workflows')).body.items).toEqual(before.body.items);
    expect((await call('POST', '/workflows/copilot', { prompt: 'x' }, cpa)).status).toBe(403);
  });

  it('starts a run, opens an approval task, decides it and completes', async () => {
    const workflowId = await publishedWorkflow();
    const started = await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId });
    expect(started.status).toBe(201);
    const runId = started.body.id as string;
    // The starter's principal stays internal.
    expect(started.body.startedBy).toEqual({ id: 'admin-token' });

    expect(await harness.drive(runId)).toMatchObject({ status: 'waiting' });
    const run = await call('GET', `/workflow-runs/${runId}`, undefined, cpa);
    expect(run.body).toMatchObject({ status: 'waiting', waitingOn: 'Review Hello' });

    const tasks = await call(
      'GET',
      `/workflow-tasks?runId=${runId}&status=pending`,
      undefined,
      cpa,
    );
    const [task] = tasks.body.items as Json[];
    expect(task).toMatchObject({ kind: 'approval', status: 'pending', entryId });
    expect((await call('GET', `/workflow-tasks/${task?.id}`, undefined, cpa)).status).toBe(200);

    // A second active run of the same workflow on the entry conflicts.
    expect((await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).status).toBe(
      409,
    );

    // A preview key can read but not decide.
    expect(
      (await call('POST', `/workflow-tasks/${task?.id}/decide`, { decision: 'approved' }, cpa))
        .status,
    ).toBe(403);
    // The approval names no scope, so it takes workflow:approve: the Approver preset decides it
    // without being able to write content.
    const minted = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cpa', name: 'approver' }),
    });
    const approverKey = (await minted.json()) as Json;
    await app.request(`/spaces/s1/api-keys/${approverKey.id}/role`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ role: 'approver' }),
    });
    const approver = {
      Authorization: `Bearer ${approverKey.token}`,
      'Content-Type': 'application/json',
    };
    const decided = await call(
      'POST',
      `/workflow-tasks/${task?.id}/decide`,
      { decision: 'approved', note: 'ok' },
      approver,
    );
    expect(decided).toMatchObject({ status: 200, body: { decision: 'approved', runId } });

    expect(await harness.drive(runId)).toMatchObject({ status: 'complete' });
    expect((await call('GET', `/workflow-runs/${runId}`)).body.status).toBe('completed');
    const timeline = await call('GET', `/workflow-runs/${runId}/timeline`);
    expect((timeline.body.items as Json[]).length).toBeGreaterThan(2);
    const nodeRuns = await call('GET', `/workflow-runs/${runId}/node-runs`);
    expect((nodeRuns.body.items as Json[]).map((n) => n.nodeId)).toContain('publish');
    const listed = await call('GET', `/workflow-runs?entryId=${entryId}&status=completed`);
    expect((listed.body.items as Json[]).map((r) => r.id)).toEqual([runId]);
    expect((await call('GET', '/workflow-runs?status=bogus')).status).toBe(422);
  });

  it('delivers events (buffering early ones) and cancels runs', async () => {
    const created = await call('POST', '/workflows', {
      name: 'Legal',
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit')
        .n('legal', 'control.wait_event', 'Legal', { event: 'legal.cleared', timeout: '1 day' })
        .n('ok', 'control.end', 'Done')
        .n('late', 'control.end', 'Late', { outcome: 'cancelled' })
        .e('start', 'legal')
        .e('legal.received', 'ok')
        .e('legal.timeout', 'late')
        .graph(),
    });
    const workflowId = (created.body.workflow as Json).id as string;
    await call('POST', `/workflows/${workflowId}/versions`);
    const runId = (await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).body
      .id as string;
    await harness.drive(runId);

    const early = await call('POST', `/workflow-runs/${runId}/events`, { event: 'other' });
    expect(early.body).toEqual({ delivered: false, buffered: true });
    const sent = await call('POST', `/workflow-runs/${runId}/events`, {
      event: 'legal.cleared',
      payload: { ticket: 'L-1' },
    });
    expect(sent.body).toMatchObject({ delivered: true, nodeId: 'legal' });
    expect(await harness.drive(runId)).toMatchObject({ status: 'complete' });

    // A fresh run, cancelled while it waits.
    const second = (await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).body
      .id as string;
    await harness.drive(second);
    const cancelled = await call('POST', `/workflow-runs/${second}/cancel`, { reason: 'Stop' });
    expect(cancelled.body).toMatchObject({ ok: true });
    expect(harness.engine.cancelled).toContain(second);
    expect((await call('GET', `/workflow-runs/${second}`)).body).toMatchObject({
      status: 'cancelled',
      reason: 'Stop',
    });
    // Cancelling again does nothing.
    expect((await call('POST', `/workflow-runs/${second}/cancel`, {})).body).toMatchObject({
      ok: false,
    });
  });

  it('applies separation of duties from the space settings: a token cannot decide', async () => {
    expect((await call('PUT', '/workflow-settings', { separateDuties: true }, cpa)).status).toBe(
      403,
    );
    const set = await call('PUT', '/workflow-settings', { separateDuties: true });
    expect(set).toMatchObject({ status: 200, body: { separateDuties: true } });
    expect((await call('GET', '/workflow-settings', undefined, cpa)).body).toEqual({
      separateDuties: true,
    });

    const workflowId = await publishedWorkflow();
    const runId = (await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).body
      .id as string;
    await harness.drive(runId);
    const [task] = (await call('GET', `/workflow-tasks?runId=${runId}`)).body.items as Json[];
    expect(task?.separateDuties).toBe(true);
    const refused = await call('POST', `/workflow-tasks/${task?.id}/decide`, {
      decision: 'approved',
    });
    expect(refused.status).toBe(403);
  });

  it('hides runs on content types a role-bound key cannot read', async () => {
    const workflowId = await publishedWorkflow();
    const pageRun = (await call('POST', `/entries/${pageEntryId}/workflow-runs`, { workflowId }))
      .body.id as string;
    const postRun = (await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).body
      .id as string;

    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post reader',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write'] }],
      }),
    });
    const roleId = ((await role.json()) as Json).id;
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const token = ((await key.json()) as Json).token;
    const editor = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listed = await call('GET', '/workflow-runs', undefined, editor);
    expect((listed.body.items as Json[]).map((r) => r.id)).toEqual([postRun]);
    expect((await call('GET', `/workflow-runs/${pageRun}`, undefined, editor)).status).toBe(403);
    expect(
      (await call('GET', `/workflow-runs/${pageRun}/timeline`, undefined, editor)).status,
    ).toBe(403);
    expect(
      (await call('POST', `/entries/${pageEntryId}/workflow-runs`, { workflowId }, editor)).status,
    ).toBe(403);
  });

  it('records an agent-review decision under the same actor id as authorship', async () => {
    const scope = { spaceId: 's1', environmentId: 'main' };
    const review = await createAgentReview(ctx, scope, {
      workflow: 'enrich',
      entryId,
      proposed: { title: { 'en-US': 'Better' } },
      notes: [],
    });
    const approved = await call('POST', `/agent-reviews/${review.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.review).toMatchObject({ status: 'approved', decidedBy: 'admin-token' });
    const entry = await call('GET', `/entries/${entryId}`);
    expect((entry.body.entry as Json).updatedBy).toBe('admin-token');
  });

  it('counts what waits in Approvals, as each caller’s lists show it', async () => {
    const workflowId = await publishedWorkflow();
    for (const id of [entryId, pageEntryId]) {
      const run = (await call('POST', `/entries/${id}/workflow-runs`, { workflowId })).body
        .id as string;
      await harness.drive(run);
    }
    const scope = { spaceId: 's1', environmentId: 'main' };
    for (const id of [entryId, pageEntryId])
      await createAgentReview(ctx, scope, {
        workflow: 'enrich',
        entryId: id,
        proposed: { title: { 'en-US': 'Better' } },
        notes: [],
      });

    const all = await call('GET', '/approvals/count', undefined, cpa);
    expect(all).toEqual({ status: 200, body: { workflowTasks: 2, agentReviews: 2, total: 4 } });

    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post reader',
        scopes: ['preview:read'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
      }),
    });
    const roleId = ((await role.json()) as Json).id;
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const token = ((await key.json()) as Json).token;
    const reader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await call('GET', '/approvals/count', undefined, reader)).body).toEqual({
      workflowTasks: 1,
      agentReviews: 1,
      total: 2,
    });
    // The list it would open agrees: only the post's proposal.
    const reviews = await call('GET', '/agent-reviews?status=pending', undefined, reader);
    expect((reviews.body.items as Json[]).map((r) => r.entryId)).toEqual([entryId]);

    const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
    expect((await call('GET', '/approvals/count', undefined, cda)).status).toBe(403);
  });

  it('refuses a direct publish a gated workflow covers with 409 publish_gated, even for the admin token; its run publishes', async () => {
    const created = await call('POST', '/workflows', {
      name: 'Gate',
      contentTypes: ['post'],
      gatesPublish: true,
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .e('start', 'publish')
        .e('publish', 'done')
        .graph(),
    });
    const workflowId = (created.body.workflow as Json).id as string;
    await call('POST', `/workflows/${workflowId}/versions`);

    const refused = await call('POST', `/entries/${entryId}/published`);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: {
        code: 'publish_gated',
        message: expect.stringContaining('"Gate"'),
        entries: [{ entryId, workflows: [{ id: workflowId, name: 'Gate' }] }],
      },
    });
    // A type the workflow doesn't cover publishes as before.
    expect((await call('POST', `/entries/${pageEntryId}/published`)).status).toBe(200);

    // Bulk publish reports the gated entry as its own failed item.
    const bulk = await call('POST', '/bulk/entries/publish', { ids: [entryId] });
    expect(bulk.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect((bulk.body.results as Json[])[0]).toMatchObject({
      id: entryId,
      ok: false,
      error: expect.stringContaining('publishes only through a run of the workflow "Gate"'),
    });

    const runId = (await call('POST', `/entries/${entryId}/workflow-runs`, { workflowId })).body
      .id as string;
    expect(await harness.drive(runId)).toMatchObject({ status: 'complete' });
    expect((await call('GET', `/entries/${entryId}`)).body.entry).toMatchObject({
      status: 'published',
    });
  });

  it('answers 501 for run actions when no workflow engine is bound', async () => {
    const wired = wire(config);
    const bare = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
    const res = await bare.request(`${M}/entries/whatever/workflow-runs`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ workflowId: 'w' }),
    });
    expect(res.status).toBe(501);
    // Reads keep working.
    const list = await bare.request(`${M}/workflow-runs`, { headers: admin });
    expect(list.status).toBe(200);
  });
});

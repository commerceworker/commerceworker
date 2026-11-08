import { createHash } from 'node:crypto';
import type { AppContext } from '@commerceworker/application';
import {
  addMember,
  assignRolePreset,
  authenticate,
  bulkEntryAction,
  closeWorkflowTask,
  createAgentReview,
  createAgentSchedule,
  createApiKey,
  createAppExtension,
  createContentType,
  createEntry,
  createFunction,
  createRole,
  createSpace,
  createWorkflowDraft,
  defineWorkflow,
  deleteAgentSchedule,
  deleteFunction,
  deleteWorkflow,
  ensureRolePresets,
  getEntry,
  getPublishedEntry,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunTimeline,
  getWorkflowVersion,
  listAgentSchedules,
  listAppExtensions,
  listFunctions,
  listPublishedEntries,
  listRoles,
  listWorkflowRuns,
  listWorkflows,
  listWorkflowTasks,
  listWorkflowVersions,
  openWorkflowTask,
  publishContentType,
  publishEntry,
  publishWorkflowVersion,
  reportRun,
  SYSTEM_CALLER,
  saveWorkflowDraft,
  startWorkflowRun,
  unpublishEntry,
  updateAgentSchedule,
  updateEntry,
  updateRole,
} from '@commerceworker/application';
import {
  editorialReviewWorkflow,
  legacyStepsToGraph,
  type Principal,
  type Role,
  SCOPES,
  WorkflowBuilder,
  type WorkflowRun,
} from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { RecordingWorkflowEngine } from '@commerceworker/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

// D1 contract tests (Miniflare D1 in workerd). They drive the adapter through the same
// application use-cases the API/MCP use, so they prove the SQL mappings, the JSON query path,
// the published read model, the outbox, and units of work behave like the in-memory contract.
// The file shares one database across its tests, so every test uses its own ids.

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const uuidv7 = () => crypto.randomUUID();
const ids: IdGenerator = { newId: () => uuidv7() };

describe('D1 store (contract)', () => {
  const store = createD1Store(testDb);
  const ctx: AppContext = { store, clock, ids };
  const spaceId = `t-${uuidv7()}`;
  const scope = { spaceId, environmentId: 'main' };

  /** Outbox assertions query the table directly (by id or entry id), not `readPending`. */
  const publishedEventsFor = async (entryIds: string[]): Promise<{ id: string }[]> =>
    (
      await testDb
        .prepare(
          `select id from outbox where type = 'entry.published'
             and json_extract(payload, '$.entryId') in (select value from json_each(?))`,
        )
        .bind(JSON.stringify(entryIds))
        .all<{ id: string }>()
    ).results;
  const outboxRowById = async (id: string): Promise<{ id: string; relayed: boolean }[]> =>
    (
      await testDb
        .prepare('select id, relayed_at is not null as relayed from outbox where id = ?')
        .bind(id)
        .all<{ id: string; relayed: number }>()
    ).results.map((r) => ({ id: r.id, relayed: Boolean(r.relayed) }));

  beforeAll(async () => {
    await createSpace(ctx, { spaceId, name: 'Test', defaultLocale: 'en-US', locales: ['en-US'] });
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
        {
          apiId: 'views',
          name: 'Views',
          type: 'Integer',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(ctx, scope, 'article');
  });

  it('persists a space config and content type', async () => {
    const cfg = await store.spaces.getConfig(scope);
    expect(cfg?.name).toBe('Test');
    const ct = await store.contentTypes.get(scope, 'article');
    expect(ct?.fields.map((f) => f.apiId)).toEqual(['title', 'views']);
  });

  it('creates, versions, and reads back a draft entry', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'First' }, views: { 'en-US': 10 } },
    });
    const id = created.entry.id;

    const fetched = await getEntry(ctx, scope, id);
    expect(fetched.fields.title?.['en-US']).toBe('First');
    expect(fetched.entry.currentVersion).toBe(1);

    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Edited' }, views: { 'en-US': 20 } });
    const versions = await store.entries.listVersions(scope, id);
    expect(versions).toHaveLength(2);
    const v1 = await store.entries.getVersion(scope, id, 1);
    expect(v1?.fields.title?.['en-US']).toBe('First');
  });

  it('publishes to the delivery read model and filters/orders over JSON', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Alpha' }, views: { 'en-US': 5 } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Beta' }, views: { 'en-US': 99 } },
    });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    const single = await getPublishedEntry(ctx, scope, b.entry.id);
    expect((single.fields.title as Record<string, unknown>)['en-US']).toBe('Beta');

    // Field-level filter + order over the published JSON read model.
    const highViews = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'article',
      filters: [{ field: 'views', op: 'gte', value: 50 }],
      order: [{ field: 'views', direction: 'desc' }],
    });
    const titles = highViews.map((e) => (e.fields.title as Record<string, unknown>)['en-US']);
    expect(titles).toContain('Beta');
    expect(titles).not.toContain('Alpha');

    // Unpublish removes it from delivery.
    await unpublishEntry(ctx, scope, b.entry.id);
    const after = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'article',
      filters: [{ field: 'views', op: 'gte', value: 50 }],
    });
    expect(after.map((e) => e.id)).not.toContain(b.entry.id);
  });

  it('ranks published entries with the built-in text search', async () => {
    const twice = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Quantum primer: quantum gates and qubits' } },
    });
    const once = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Gardening notes with a quantum aside' } },
    });
    await publishEntry(ctx, scope, twice.entry.id);
    await publishEntry(ctx, scope, once.entry.id);

    // Term frequency drives the score: the double mention ranks first.
    const hits = await store.entries.searchPublished(scope, 'quantum', { topK: 5 });
    expect(hits.map((h) => h.entryId)).toEqual([twice.entry.id, once.entry.id]);
    expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0);

    // Every term must match.
    const both = await store.entries.searchPublished(scope, 'quantum gardening', { topK: 5 });
    expect(both.map((h) => h.entryId)).toEqual([once.entry.id]);

    expect(await store.entries.searchPublished(scope, 'nonexistentterm', { topK: 5 })).toEqual([]);
  });

  it('appends to the outbox transactionally on publish', async () => {
    const e = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Outbox' } },
    });
    await publishEntry(ctx, scope, e.entry.id);
    expect(await publishedEventsFor([e.entry.id])).toHaveLength(1);
  });

  it('bulk publishes and unpublishes through the batched statements', async () => {
    const mk = (title: string) =>
      createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': title } },
      });
    const [a, b, c] = await Promise.all([mk('Bulk A'), mk('Bulk B'), mk('Bulk C')]);

    // Publish: exercises getMany, saveAggregateMany (multi-value upsert),
    // putPublishedMany, replaceForEntries, appendMany — plus a per-item
    // failure partitioned inside the committed batch.
    const summary = await bulkEntryAction(ctx, scope, 'publish', [
      a.entry.id,
      b.entry.id,
      c.entry.id,
      'missing-entry-id',
    ]);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(1);

    const published = await store.entries.getPublishedMany(scope, [
      a.entry.id,
      b.entry.id,
      c.entry.id,
    ]);
    expect(published).toHaveLength(3);
    // One shared publish instant across the chunk.
    expect(new Set(published.map((p) => p.publishedAt)).size).toBe(1);
    const drafts = await store.entries.getMany(scope, [a.entry.id, b.entry.id]);
    expect(drafts.every((d) => d.entry.status === 'published')).toBe(true);
    expect(await publishedEventsFor([a.entry.id, b.entry.id, c.entry.id])).toHaveLength(3);

    // Unpublish: exercises removePublishedMany + edge clearing.
    const undo = await bulkEntryAction(ctx, scope, 'unpublish', [a.entry.id, b.entry.id]);
    expect(undo.succeeded).toBe(2);
    expect(await store.entries.getPublishedMany(scope, [a.entry.id, b.entry.id])).toHaveLength(0);
    expect(await store.entries.getPublishedMany(scope, [c.entry.id])).toHaveLength(1);
  });

  it('round-trips the bulk-job repo (CAS claim, atomic counters, stall sweep)', async () => {
    const jobId = uuidv7();
    const now = clock.now();
    await store.bulkJobs.createJob(scope, {
      id: jobId,
      action: 'publish',
      status: 'running',
      totalItems: 3,
      totalChunks: 2,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now.toISOString(),
    });
    await store.bulkJobs.createChunks(scope, [
      {
        jobId,
        chunkId: 'c00000',
        entryIds: ['a', 'b'],
        status: 'pending',
        attempts: 0,
        failures: [],
      },
      { jobId, chunkId: 'c00001', entryIds: ['c'], status: 'pending', attempts: 0, failures: [] },
    ]);

    // CAS claim: first wins, second (not stale) loses.
    const staleBefore = new Date(now.getTime() - 60_000);
    const claimed = await store.bulkJobs.claimChunk(scope, jobId, 'c00000', { now, staleBefore });
    expect(claimed?.attempts).toBe(1);
    expect(
      await store.bulkJobs.claimChunk(scope, jobId, 'c00000', { now, staleBefore }),
    ).toBeNull();
    // A stale claim IS re-claimable.
    const futureStale = new Date(now.getTime() + 60_000);
    const reclaimed = await store.bulkJobs.claimChunk(scope, jobId, 'c00000', {
      now,
      staleBefore: futureStale,
    });
    expect(reclaimed?.attempts).toBe(2);

    // The stall sweep sees the running-stale chunk and the aging pending one.
    // (Pending age uses the DB-stamped created_at — real time — while the
    // claim stamp came from the fixed test clock, so cut off after both.)
    const sweepCutoff = new Date(Date.now() + 60_000);
    const stalled = await store.bulkJobs.findStalledChunks(sweepCutoff, 1000);
    const ours = stalled.filter((s) => s.jobId === jobId);
    expect(ours.map((s) => s.chunkId).sort()).toEqual(['c00000', 'c00001']);

    // Complete folds counters atomically; a duplicate completion no-ops.
    const afterFirst = await store.bulkJobs.completeChunk(scope, jobId, 'c00000', {
      status: 'completed',
      succeeded: 2,
      failed: 0,
      failures: [],
    });
    expect(afterFirst).toMatchObject({ completedChunks: 1, succeeded: 2, failed: 0 });
    const dup = await store.bulkJobs.completeChunk(scope, jobId, 'c00000', {
      status: 'completed',
      succeeded: 2,
      failed: 0,
      failures: [],
    });
    expect(dup.completedChunks).toBe(1); // unchanged

    await store.bulkJobs.claimChunk(scope, jobId, 'c00001', { now, staleBefore });
    const afterSecond = await store.bulkJobs.completeChunk(scope, jobId, 'c00001', {
      status: 'failed',
      succeeded: 0,
      failed: 1,
      failures: [{ id: 'c', error: 'boom' }],
    });
    expect(afterSecond).toMatchObject({ completedChunks: 2, succeeded: 2, failed: 1 });

    // Finalize CAS: once, then null.
    expect(await store.bulkJobs.finalizeJob(scope, jobId, 'completed', now)).toBeTruthy();
    expect(await store.bulkJobs.finalizeJob(scope, jobId, 'completed', now)).toBeNull();
    const chunks = await store.bulkJobs.listChunks(scope, jobId);
    expect(chunks.find((c) => c.chunkId === 'c00001')?.failures).toEqual([
      { id: 'c', error: 'boom' },
    ]);
  });

  it('computes the reverse reference closure with one recursive query', async () => {
    // c <- b <- a  and  c <- d (direct): closure of [c] = {a, b, d}.
    const put = (fromEntryId: string, toId: string) =>
      store.references.replaceForEntry(scope, fromEntryId, [
        { fromEntryId, fromField: 'ref', toId, toType: 'Entry' },
      ]);
    await put('closure-b', 'closure-c');
    await put('closure-a', 'closure-b');
    await put('closure-d', 'closure-c');

    const closure = await store.references.findReverseClosure(scope, ['closure-c'], {
      maxDepth: 5,
      maxEntries: 100,
    });
    expect(closure.sort()).toEqual(['closure-a', 'closure-b', 'closure-d']);

    // Depth bound: depth 1 sees only direct embedders.
    const shallow = await store.references.findReverseClosure(scope, ['closure-c'], {
      maxDepth: 1,
      maxEntries: 100,
    });
    expect(shallow.sort()).toEqual(['closure-b', 'closure-d']);

    // Cycle safety: a <-> b terminates.
    await put('cyc-a', 'cyc-b');
    await put('cyc-b', 'cyc-a');
    const cyc = await store.references.findReverseClosure(scope, ['cyc-a'], {
      maxDepth: 10,
      maxEntries: 100,
    });
    expect(cyc).toEqual(['cyc-b']);
  });

  it('getPublishedMany returns present snapshots only, scoped', async () => {
    const otherScope = { spaceId: `t-${uuidv7()}`, environmentId: 'main' };
    await createSpace(ctx, {
      spaceId: otherScope.spaceId,
      name: 'Other',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    await createContentType(ctx, SYSTEM_CALLER, otherScope, {
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
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Batch A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Batch B' } },
    });
    const foreign = await createEntry(ctx, otherScope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Foreign' } },
    });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);
    await publishEntry(ctx, otherScope, foreign.entry.id);

    const got = await store.entries.getPublishedMany(scope, [
      a.entry.id,
      b.entry.id,
      foreign.entry.id, // other space — must not leak
      uuidv7(), // nonexistent — silently absent
    ]);
    expect(got.map((s) => s.entryId).sort()).toEqual([a.entry.id, b.entry.id].sort());
    expect(await store.entries.getPublishedMany(scope, [])).toEqual([]);
  });

  it('deleteRelayedBefore respects the limit and never deletes pending rows', async () => {
    const mk = (n: number) => ({
      id: uuidv7(),
      type: 'entry.published' as const,
      scope,
      occurredAt: clock.now().toISOString(),
      entryId: `sweep-${n}`,
      contentTypeApiId: 'article',
      version: 1,
      fields: {},
    });
    const [r1, r2, pending] = [mk(1), mk(2), mk(3)];
    await store.outbox.append(r1);
    await store.outbox.append(r2);
    await store.outbox.append(pending);
    await store.outbox.markRelayed([r1.id, r2.id]);

    const future = new Date(Date.now() + 60_000); // past the relay stamps
    expect(await store.outbox.deleteRelayedBefore(future, 1)).toBe(1);
    expect(await store.outbox.deleteRelayedBefore(future, 10)).toBe(1);
    expect(await store.outbox.deleteRelayedBefore(future, 10)).toBe(0);
    // The never-relayed row survived every sweep, and is still un-relayed.
    expect(await outboxRowById(pending.id)).toEqual([{ id: pending.id, relayed: false }]);
  });

  it('deleteDeliveriesBefore trims old delivery records across spaces', async () => {
    const otherScope = { spaceId: `t-${uuidv7()}`, environmentId: 'main' };
    await store.webhooks.recordDelivery(scope, {
      webhookId: 'wh-sweep-a',
      eventId: 'evt-1',
      status: 'success',
      attempts: 1,
    });
    await store.webhooks.recordDelivery(otherScope, {
      webhookId: 'wh-sweep-b',
      eventId: 'evt-2',
      status: 'failed',
      attempts: 1,
    });

    // Platform sweep: both spaces' old records go; a future cutoff catches
    // the just-written rows (createdAt = DB now).
    const future = new Date(Date.now() + 60_000);
    const deleted = await store.webhooks.deleteDeliveriesBefore(future, 100);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await store.webhooks.listDeliveries(scope, 'wh-sweep-a')).toEqual([]);
    expect(await store.webhooks.listDeliveries(otherScope, 'wh-sweep-b')).toEqual([]);
  });

  it("reads one delivery back with its event type and resend link, only in its webhook's space", async () => {
    const otherScope = { spaceId: `t-${uuidv7()}`, environmentId: 'main' };
    const webhookId = `wh-${uuidv7()}`;
    await store.webhooks.recordDelivery(scope, {
      webhookId,
      eventId: 'evt-old',
      status: 'success',
      attempts: 1,
    });
    const [plain] = await store.webhooks.listDeliveries(scope, webhookId);
    if (!plain) throw new Error('no delivery');
    // Written without the 0022 columns: neither comes back.
    expect(plain).not.toHaveProperty('eventType');
    expect(plain).not.toHaveProperty('resendOf');
    await store.webhooks.recordDelivery(scope, {
      webhookId,
      eventId: 'evt-old',
      status: 'failed',
      statusCode: 502,
      attempts: 1,
      eventType: 'webhook.test',
      resendOf: plain.id,
    });
    const [resent] = await store.webhooks.listDeliveries(scope, webhookId);
    if (!resent) throw new Error('no resend');
    expect(await store.webhooks.getDelivery(scope, webhookId, resent.id)).toEqual(resent);
    expect(resent).toMatchObject({
      eventType: 'webhook.test',
      resendOf: plain.id,
      statusCode: 502,
    });
    // Another webhook's, another space's: not found.
    expect(await store.webhooks.getDelivery(scope, 'wh-other', resent.id)).toBeNull();
    expect(await store.webhooks.getDelivery(otherScope, webhookId, resent.id)).toBeNull();
  });

  it("gets an outbox event by id, relayed or not, only in its own space's scope", async () => {
    const event = {
      id: uuidv7(),
      type: 'webhook.test' as const,
      scope,
      occurredAt: clock.now().toISOString(),
      webhookId: 'wh-1',
      message: 'test',
    };
    await store.outbox.append(event);
    expect(await store.outbox.get(scope, event.id)).toEqual(event);
    // Any environment of the space: a space-wide webhook's deliveries span them.
    expect(await store.outbox.get({ ...scope, environmentId: 'staging' }, event.id)).toEqual(event);
    await store.outbox.markRelayed([event.id]);
    expect(await store.outbox.get(scope, event.id)).toEqual(event);
    expect(
      await store.outbox.get({ spaceId: `t-${uuidv7()}`, environmentId: 'main' }, event.id),
    ).toBeNull();
    expect(await store.outbox.get(scope, uuidv7())).toBeNull();
  });

  it('carries a webhook send request with no `type` in its payload, typed by its kind', async () => {
    const request = {
      kind: 'webhook.send' as const,
      id: uuidv7(),
      scope,
      occurredAt: clock.now().toISOString(),
      webhookId: 'wh-1',
      resend: { deliveryId: 3, eventId: 'evt-x' },
    };
    await store.outbox.append(request);
    expect(await store.outbox.get(scope, request.id)).toEqual(request);
    const pending = await store.outbox.readPending(10_000);
    expect(pending.find((e) => e.id === request.id)).toEqual(request);
    await store.outbox.markRelayed(pending.map((e) => e.id));
    const rows = await testDb
      .prepare('SELECT type, payload FROM outbox WHERE id = ?')
      .bind(request.id)
      .all<{ type: string; payload: string }>();
    expect(rows.results[0]?.type).toBe('webhook.send');
    expect(JSON.parse(rows.results[0]?.payload ?? '{}')).not.toHaveProperty('type');
  });

  it('round-trips roles and role-bound API keys (granular RBAC)', async () => {
    const role = await createRole(ctx, spaceId, {
      name: 'Editor',
      description: 'Posts only',
      scopes: ['content:write', 'preview:read'],
      contentGrants: [
        { contentTypeApiId: 'article', actions: ['read', 'write'], deniedFields: ['views'] },
      ],
    });
    const listed = await listRoles(ctx, spaceId);
    expect(listed.map((r) => r.id)).toContain(role.id);

    const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId,
      kind: 'cma',
      roleId: role.id,
    });
    const principal = await authenticate(ctx, hasher, token);
    expect(principal.scopes).toEqual(['content:write', 'preview:read']);
    expect(principal.contentGrants?.[0]?.deniedFields).toEqual(['views']);

    await updateRole(ctx, spaceId, role.id, {
      name: 'Editor',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    const after = await authenticate(ctx, hasher, token);
    expect(after.scopes).toEqual(['preview:read']);
    expect(after.contentGrants?.[0]?.contentTypeApiId).toBe('*');
  });

  it('round-trips role presets, team members, key rebinding and deployment settings', async () => {
    // Presets seed once; a second seed (or a racing one) never duplicates one (unique index).
    const seeded = await ensureRolePresets(ctx, spaceId);
    expect(seeded.map((r) => r.preset)).toEqual([
      'viewer',
      'approver',
      'editor',
      'manager',
      'admin',
    ]);
    await ensureRolePresets(ctx, spaceId);
    expect((await store.roles.list(spaceId)).filter((r) => r.preset === 'admin')).toHaveLength(1);
    const dupe = { ...(seeded[0] as Role), id: uuidv7() };
    await expect(store.roles.save(dupe)).rejects.toThrow();

    // People: unique email per space, linked subject, role.
    const ada = await addMember(ctx, spaceId, { email: 'ada@example.com', role: 'editor' });
    await expect(
      addMember(ctx, spaceId, { email: 'ada@example.com', role: 'viewer' }),
    ).rejects.toThrow();
    await store.members.save({ ...ada, subject: 'sub-1' });
    expect(await store.members.getByEmail(spaceId, 'ada@example.com')).toMatchObject({
      id: ada.id,
      subject: 'sub-1',
      disabled: false,
    });
    expect((await store.members.list(spaceId)).map((m) => m.id)).toEqual([ada.id]);

    // Rebinding a key changes its role and scope snapshot.
    const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
    const { apiKey, token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId,
      kind: 'cda',
    });
    await assignRolePreset(
      ctx,
      spaceId,
      { keyId: apiKey.id },
      'approver',
      { sso: false },
      'system',
    );
    const bound = (await store.auth.list(spaceId)).find((k) => k.id === apiKey.id);
    expect(bound?.roleId).toBe(seeded[1]?.id);
    expect((await authenticate(ctx, hasher, token)).scopes).toContain('workflow:approve');
    await store.auth.setRole(apiKey.id, undefined, ['delivery:read']);
    expect(
      (await store.auth.list(spaceId)).find((k) => k.id === apiKey.id)?.roleId,
    ).toBeUndefined();

    await store.members.delete(spaceId, ada.id);
    expect(await store.members.get(spaceId, ada.id)).toBeNull();

    // Deployment settings: compare-and-set.
    const key = `test:${spaceId}`;
    expect(await store.settings.put(key, { a: 1 }, null)).toBe(true);
    expect(await store.settings.put(key, { a: 2 }, null)).toBe(false);
    expect(await store.settings.get(key)).toEqual({ value: { a: 1 }, version: 1 });
    expect(await store.settings.put(key, { a: 3 }, 0)).toBe(false);
    expect(await store.settings.put(key, { a: 3 }, 1)).toBe(true);
    expect(await store.settings.get(key)).toEqual({ value: { a: 3 }, version: 2 });
  });

  it('round-trips the agent-schedules repo (incl. cross-scope findDue)', async () => {
    const created = await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 2 * * *',
      contentTypeApiId: 'article',
    });
    const listed = await listAgentSchedules(ctx, scope);
    expect(listed.map((s) => s.id)).toContain(created.id);

    const updated = await updateAgentSchedule(ctx, scope, created.id, {
      cron: '30 4 * * *',
      autoApply: true,
    });
    expect(updated.autoApply).toBe(true);
    expect(updated.nextRunAt).toBe('2026-01-01T04:30:00.000Z');

    // Due scan crosses scopes and respects the enabled flag.
    const due = await store.agentSchedules.findDue('2026-01-02T00:00:00.000Z');
    expect(due.some((d) => d.schedule.id === created.id && d.scope.spaceId === spaceId)).toBe(true);

    // Optimistic claim: first CAS wins, the stale retry loses; run-state saves
    // only the cursor (cron/enabled untouched).
    const won = await store.agentSchedules.claimNextRun(
      scope,
      created.id,
      updated.nextRunAt,
      '2026-01-02T04:30:00.000Z',
    );
    expect(won).toBe(true);
    const lost = await store.agentSchedules.claimNextRun(
      scope,
      created.id,
      updated.nextRunAt,
      '2026-01-03T04:30:00.000Z',
    );
    expect(lost).toBe(false);
    await store.agentSchedules.saveRunState(scope, created.id, {
      lastRunAt: '2026-01-02T04:30:00.000Z',
      cursorEntryId: 'entry-cursor',
    });
    const afterRun = await store.agentSchedules.get(scope, created.id);
    expect(afterRun?.cursorEntryId).toBe('entry-cursor');
    expect(afterRun?.cron).toBe('30 4 * * *');
    await updateAgentSchedule(ctx, scope, created.id, { enabled: false });
    const dueAfterDisable = await store.agentSchedules.findDue('2026-01-02T00:00:00.000Z');
    expect(dueAfterDisable.some((d) => d.schedule.id === created.id)).toBe(false);

    await deleteAgentSchedule(ctx, scope, created.id);
    expect((await listAgentSchedules(ctx, scope)).map((s) => s.id)).not.toContain(created.id);
  });

  it('round-trips the agent-reviews repo (CAS decide/arm/apply)', async () => {
    const review = await createAgentReview(ctx, scope, {
      workflow: 'enrich',
      entryId: 'entry-x',
      proposed: { summary: { 'en-US': 'proposed' } },
      notes: ['note one'],
    });
    const [pending] = await store.agentReviews.list(scope, { status: 'pending' });
    expect(pending?.id).toBe(review.id);
    expect(pending?.proposed.summary?.['en-US']).toBe('proposed');

    // Arm is a CAS: first caller arms, a second observes.
    expect(await store.agentReviews.markAwaiting(scope, review.id)).toBe('armed');
    expect(await store.agentReviews.markAwaiting(scope, review.id)).toBe('pending');
    await store.agentReviews.clearAwaiting(scope, review.id);

    // Decide is a CAS: the second decision loses.
    expect(
      await store.agentReviews.decide(scope, review.id, {
        status: 'approved',
        decidedAt: '2026-01-02T00:00:00.000Z',
        decidedBy: 'contract-test',
      }),
    ).toBe(true);
    expect(
      await store.agentReviews.decide(scope, review.id, {
        status: 'rejected',
        decidedAt: '2026-01-02T00:00:01.000Z',
      }),
    ).toBe(false);

    // Exactly-once apply marker.
    expect(await store.agentReviews.markApplied(scope, review.id, '2026-01-02T00:00:02.000Z')).toBe(
      true,
    );
    expect(await store.agentReviews.markApplied(scope, review.id, '2026-01-02T00:00:03.000Z')).toBe(
      false,
    );
    const decided = await store.agentReviews.get(scope, review.id);
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe('contract-test');
    expect(decided?.appliedAt).toBe('2026-01-02T00:00:02.000Z');
  });

  it('counts pending tasks and reviews per content type, uncapped, in D1', async () => {
    // Deltas: other tests in this file leave pending work in the same scope.
    const byType = (rows: readonly { contentTypeApiId: string | null; count: number }[]) =>
      Object.fromEntries(rows.map((r) => [String(r.contentTypeApiId), r.count]));
    const tasksBefore = byType(await store.workflowTasks.countPending(scope));
    const reviewsBefore = byType(await store.agentReviews.countPending(scope));

    const task = (n: number, status: 'pending' | 'approved') => ({
      id: `count-task-${n}`,
      runId: `count-run-${n}`,
      workflowId: 'wf',
      nodeId: 'approve',
      eventType: `count-approve-${n}`,
      kind: 'approval' as const,
      entryId: 'any',
      contentTypeApiId: 'count-type',
      title: 'Sign off',
      instructions: '',
      assignee: null,
      event: null,
      requiredScope: null,
      separateDuties: false,
      reviewId: null,
      deadline: '2026-12-01T00:00:00.000Z',
      status,
      requestedAt: '2026-11-01T00:00:00.000Z',
      decidedAt: null,
      decidedBy: null,
      note: null,
      startedBy: 'someone',
    });
    // Past the list's cap of 200, so the count is shown not to be a capped list.
    for (let n = 0; n < 205; n++) await store.workflowTasks.create(scope, task(n, 'pending'));
    await store.workflowTasks.create(scope, task(999, 'approved'));

    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Counted' } },
    });
    const proposal = { proposed: { title: { 'en-US': 'Better' } }, notes: [] };
    await createAgentReview(ctx, scope, { workflow: 'enrich', entryId: entry.id, ...proposal });
    await createAgentReview(ctx, scope, { workflow: 'enrich', entryId: 'count-gone', ...proposal });

    const tasks = byType(await store.workflowTasks.countPending(scope));
    expect(tasks['count-type'] ?? 0).toBe((tasksBefore['count-type'] ?? 0) + 205);
    const reviews = byType(await store.agentReviews.countPending(scope));
    expect(reviews.article ?? 0).toBe((reviewsBefore.article ?? 0) + 1);
    // A review whose entry is gone counts under null (the left join finds no entry).
    expect(reviews.null ?? 0).toBe((reviewsBefore.null ?? 0) + 1);
    // Another environment of the same space sees none of it.
    const elsewhere = { spaceId, environmentId: 'count-elsewhere' };
    expect(await store.workflowTasks.countPending(elsewhere)).toEqual([]);
    expect(await store.agentReviews.countPending(elsewhere)).toEqual([]);

    // The narrow type lookup listAgentReviews filters with: past one chunk of bound parameters,
    // duplicates folded, missing ids absent, scoped.
    const ids = [
      entry.id,
      entry.id,
      'count-gone',
      ...Array.from({ length: 150 }, (_, n) => `x${n}`),
    ];
    const types = await store.entries.contentTypesOf(scope, ids);
    expect([...types]).toEqual([[entry.id, 'article']]);
    expect((await store.entries.contentTypesOf(elsewhere, [entry.id])).size).toBe(0);
  });

  it('round-trips the functions repo', async () => {
    const fn = await createFunction(ctx, scope, {
      name: 'reindex',
      eventPattern: 'entry.*',
      url: 'https://example.com/hook',
    });
    const listed = await listFunctions(ctx, scope);
    expect(listed.map((f) => f.id)).toContain(fn.id);
    await deleteFunction(ctx, scope, fn.id);
    expect((await listFunctions(ctx, scope)).map((f) => f.id)).not.toContain(fn.id);
  });

  it('round-trips the app-extensions repo (incl. nullable field types)', async () => {
    const sidebar = await createAppExtension(ctx, scope, {
      name: 'widget',
      target: 'sidebar',
      entryUrl: 'https://example.com/widget',
    });
    const editor = await createAppExtension(ctx, scope, {
      name: 'color',
      target: 'field-editor',
      entryUrl: 'https://example.com/color',
      fieldTypes: ['Symbol'],
    });
    const apps = await listAppExtensions(ctx, scope);
    const byId = new Map(apps.map((a) => [a.id, a]));
    expect(byId.get(sidebar.id)?.fieldTypes).toBeUndefined();
    expect(byId.get(editor.id)?.fieldTypes).toEqual(['Symbol']);
  });

  describe('versioned workflow graphs', () => {
    const STEPS = [
      { id: 'draft', name: 'Draft', requiredScope: SCOPES.contentWrite },
      { id: 'approved', name: 'Approved', requiredScope: SCOPES.contentPublish },
    ];

    it('round-trips a draft (JSON graph + content types) and numbers versions', async () => {
      // Gated, so a graph a run can publish from (a gated template graph can't be published), on
      // content types no other test in this shared scope publishes.
      const t = {
        graph: new WorkflowBuilder()
          .n('start', 'trigger.manual', 'Submit')
          .n('publish', 'content.publish', 'Publish')
          .n('done', 'control.end', 'Done')
          .e('start', 'publish')
          .e('publish', 'done')
          .graph(),
      };
      const { workflow } = await createWorkflowDraft(ctx, scope, {
        name: 'Review',
        description: 'desc',
        contentTypes: ['landing', 'page'],
        graph: t.graph,
        gatesPublish: true,
      });
      expect(await getWorkflow(ctx, scope, workflow.id)).toMatchObject({
        name: 'Review',
        description: 'desc',
        contentTypes: ['landing', 'page'],
        graph: t.graph,
        gatesPublish: true,
        legacy: false,
        latestVersion: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const v1 = await publishWorkflowVersion(ctx, scope, workflow.id, { publishedBy: 'k1' });
      await saveWorkflowDraft(ctx, scope, workflow.id, { name: 'Review v2' });
      const v2 = await publishWorkflowVersion(ctx, scope, workflow.id);
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v1).toMatchObject({ publishedBy: 'k1', publishedAt: '2026-01-01T00:00:00.000Z' });
      expect(v2.publishedBy).toBeUndefined();

      const stored = await getWorkflowVersion(ctx, scope, workflow.id, 1);
      expect(stored).toMatchObject({ name: 'Review', graph: t.graph, gatesPublish: true });
      expect((await listWorkflowVersions(ctx, scope, workflow.id)).map((v) => v.version)).toEqual([
        2, 1,
      ]);
      const listed = (await listWorkflows(ctx, scope)).find((w) => w.id === workflow.id);
      expect(listed?.latestVersion).toBe(2);
    });

    it('gives concurrent publishes distinct, gap-free version numbers', async () => {
      const { workflow } = await createWorkflowDraft(ctx, scope, {
        name: 'Race',
        graph: editorialReviewWorkflow().graph,
      });
      const versions = await Promise.all(
        Array.from({ length: 4 }, () => publishWorkflowVersion(ctx, scope, workflow.id)),
      );
      expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3, 4]);
    });

    it('keeps versions after the definition is deleted', async () => {
      const { workflow } = await createWorkflowDraft(ctx, scope, {
        name: 'Gone',
        graph: editorialReviewWorkflow().graph,
      });
      await publishWorkflowVersion(ctx, scope, workflow.id);
      await deleteWorkflow(ctx, scope, workflow.id);
      expect((await getWorkflowVersion(ctx, scope, workflow.id, 1)).name).toBe('Gone');
    });

    it('reads a steps-only (pre-migration) row back with a converted graph', async () => {
      // Exactly what a row written before the expand migration looks like: new columns defaulted.
      const id = uuidv7();
      await store.workflows.saveDefinition(scope, { id, name: 'Old', steps: STEPS });
      const read = await getWorkflow(ctx, scope, id);
      expect(read).toMatchObject({
        legacy: true,
        description: '',
        contentTypes: [],
        gatesPublish: false,
        updatedAt: null,
        steps: STEPS,
      });
      expect(read.graph).toEqual(legacyStepsToGraph({ steps: STEPS }));

      await publishWorkflowVersion(ctx, scope, id);
      expect(await getWorkflow(ctx, scope, id)).toMatchObject({ legacy: false, latestVersion: 1 });
    });

    it('lists publish gates from each workflow’s latest published version, in one scope', async () => {
      // A scope of its own: gates here would refuse the other tests' publishes.
      const gatedScope = { spaceId: `g-${uuidv7()}`, environmentId: 'main' };
      const graph = new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .e('start', 'publish')
        .e('publish', 'done')
        .graph();
      const draft = async (name: string, gatesPublish: boolean, contentTypes: string[] = []) =>
        (await createWorkflowDraft(ctx, gatedScope, { name, graph, gatesPublish, contentTypes }))
          .workflow.id;
      expect(await store.workflowGraphs.listPublishGates(gatedScope)).toEqual([]);

      // Gated at v1, ungated at v2: the latest version wins.
      const flipped = await draft('Flipped', true, ['article']);
      await publishWorkflowVersion(ctx, gatedScope, flipped);
      expect(await store.workflowGraphs.listPublishGates(gatedScope)).toEqual([
        { workflowId: flipped, name: 'Flipped', version: 1, contentTypes: ['article'] },
      ]);
      await saveWorkflowDraft(ctx, gatedScope, flipped, { gatesPublish: false });
      await publishWorkflowVersion(ctx, gatedScope, flipped);

      // Ungated at v1, gated (every type) at v2.
      const later = await draft('Later', false);
      await publishWorkflowVersion(ctx, gatedScope, later);
      await saveWorkflowDraft(ctx, gatedScope, later, { gatesPublish: true, name: 'Later gate' });
      await publishWorkflowVersion(ctx, gatedScope, later);

      // Gated on a graph no run can start (the editorial template's publish_requested trigger), as
      // a version published before that was refused: written straight to the store.
      const locked = await draft('Locked', false);
      await store.workflowGraphs.publishVersion(
        gatedScope,
        { ...editorialReviewWorkflow(), id: locked, name: 'Locked', gatesPublish: true },
        { publishedAt: '2026-01-01T00:00:00.000Z' },
      );

      // Gated only in a draft; gated and then deleted.
      await draft('Draft only', true);
      const deleted = await draft('Deleted', true);
      await publishWorkflowVersion(ctx, gatedScope, deleted);
      await deleteWorkflow(ctx, gatedScope, deleted);

      const expected = [{ workflowId: later, name: 'Later gate', version: 2, contentTypes: [] }];
      expect(await store.workflowGraphs.listPublishGates(gatedScope)).toEqual(expected);
      // The same read inside a unit of work, as the publish paths make it.
      expect(
        await store.withTransaction((tx) => tx.workflowGraphs.listPublishGates(gatedScope)),
      ).toEqual(expected);
      // Another environment of the same space sees none of them.
      expect(
        await store.workflowGraphs.listPublishGates({ ...gatedScope, environmentId: 'other' }),
      ).toEqual([]);
    });

    it('create-with-steps keeps the legacy steps column in step', async () => {
      const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: STEPS });
      expect(wf.latestVersion).toBe(1);
      expect(await store.workflows.getDefinition(scope, wf.id)).toEqual({
        id: wf.id,
        name: 'Editorial',
        steps: STEPS,
      });
    });
  });

  describe('workflow runs and tasks', () => {
    const principal: Principal = {
      spaceId,
      kind: 'user',
      subject: 'starter@example.com',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
    };
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('review', 'control.approval', 'Review')
      .n('done', 'control.end', 'Done')
      .e('start', 'review')
      .e('review.approved', 'done')
      .graph();

    it('stores runs with CAS, node runs once, keyed timeline, tasks and run outbox events', async () => {
      const engine = new RecordingWorkflowEngine();
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'Run me' } },
      });
      const v = await store.workflowGraphs.publishVersion(
        scope,
        { id: uuidv7(), name: 'Runs', description: '', contentTypes: [], graph },
        { publishedAt: clock.now().toISOString() },
      );
      const run = await startWorkflowRun(ctx, engine, principal, scope, {
        entryId: entry.id,
        workflowId: v.id,
      });
      expect(await getWorkflowRun(ctx, scope, run.id)).toMatchObject({
        status: 'queued',
        startedBy: { id: 'starter@example.com', principal },
        plan: { nodes: { review: { status: 'pending', runs: 0 } } },
      });
      expect(await listWorkflowRuns(ctx, scope, { entryId: entry.id })).toHaveLength(1);

      // Stale-seq drop and the optimistic-concurrency save.
      await reportRun(ctx, scope, run.id, { seq: 2, status: 'running', vars: { a: 2 } });
      await reportRun(ctx, scope, run.id, { seq: 1, vars: { a: 1 } });
      const cur = (await store.workflowRuns.get(scope, run.id)) as WorkflowRun;
      expect(cur).toMatchObject({ seq: 2, status: 'running', vars: { a: 2 } });
      expect(await store.workflowRuns.save(scope, { ...cur, rev: 99 }, cur.rev - 1)).toBe(false);

      // Node runs record once; a keyed timeline entry replaces its copy.
      await reportRun(ctx, scope, run.id, { node: { id: 'review', runs: 1, startedAt: 1000 } });
      const end = {
        id: 'review',
        type: 'control.approval',
        summary: 'ok',
        output: { a: 1 },
        endedAt: 1500,
      };
      const log = { at: 1500, kind: 'node' as const, message: 'Review: ok', key: 'review#1' };
      await reportRun(ctx, scope, run.id, { node: end, log });
      await reportRun(ctx, scope, run.id, { node: end, log });
      expect(await store.workflowRuns.listNodeRuns(scope, run.id)).toEqual([
        expect.objectContaining({ nodeId: 'review', run: 1, durationMs: 500, output: { a: 1 } }),
      ]);
      const key = { runId: run.id, generation: 1, nodeId: 'review', run: 1 };
      expect(await store.workflowRuns.markNodeRunRolledBack(scope, key)).toBe(true);
      expect(await store.workflowRuns.markNodeRunRolledBack(scope, key)).toBe(false);
      const timeline = await getWorkflowRunTimeline(ctx, scope, run.id);
      expect(timeline.filter((t) => t.key === 'review#1')).toHaveLength(1);
      expect(timeline[0]?.message).toBe('Run started on Runs v1');

      // Tasks: one per event type, settled once.
      const since = clock.now().getTime();
      const wait = {
        nodeId: 'review',
        eventType: 'approval-review-1',
        kind: 'approval' as const,
        title: 'Review it',
        requiredScope: SCOPES.contentPublish,
        since,
        deadline: since + 86_400_000,
      };
      const { task } = await openWorkflowTask(ctx, scope, run.id, wait);
      await openWorkflowTask(ctx, scope, run.id, wait);
      expect(await listWorkflowTasks(ctx, scope, { runId: run.id, status: 'pending' })).toEqual([
        expect.objectContaining({
          id: task.id,
          deadline: new Date(since + 86_400_000).toISOString(),
        }),
      ]);
      expect(await getWorkflowRun(ctx, scope, run.id)).toMatchObject({
        waitingOn: 'Review it',
        waitingAt: 'review',
        waitingFor: 'person:',
        waitingSince: new Date(since).toISOString(),
        waitingDue: new Date(since + 86_400_000).toISOString(),
        earlyEvents: [],
      });
      await store.spaces.setWorkflowSeparateDuties(spaceId, true);
      expect((await store.spaces.getConfig(scope))?.workflowSeparateDuties).toBe(true);
      await store.spaces.setWorkflowSeparateDuties(spaceId, false);
      await closeWorkflowTask(ctx, scope, run.id, wait.eventType, 'approved', { by: 'ed' });
      expect(await store.workflowTasks.get(scope, task.id)).toMatchObject({
        status: 'approved',
        decidedBy: 'ed',
      });
      expect(
        await store.workflowTasks.settle(scope, task.id, {
          status: 'rejected',
          decidedAt: clock.now().toISOString(),
          decidedBy: 'x',
          note: null,
        }),
      ).toBe(false);

      await reportRun(ctx, scope, run.id, { seq: 3, status: 'completed' });
      const ends = (
        await testDb
          .prepare(
            "select id from outbox where type = 'workflow_run.completed' and payload ->> '$.runId' = ?",
          )
          .bind(run.id)
          .all<{ id: string }>()
      ).results;
      expect(ends).toHaveLength(1);
      expect((await getWorkflowRun(ctx, scope, run.id)).status).toBe('completed');
    });
  });
});

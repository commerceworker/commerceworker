import type { Principal, Scope, WorkflowTask } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  countPendingApprovals,
  createAgentReview,
  createContentType,
  createEntry,
  createSpace,
  listAgentReviews,
  SYSTEM_CALLER,
} from '../src/index';

const scope: Scope = { spaceId: 'acme', environmentId: 'main' };
const other: Scope = { spaceId: 'acme', environmentId: 'staging' };

/** May read posts only, and not their `summary`. */
const postsOnly: Principal = {
  spaceId: 'acme',
  kind: 'user',
  scopes: ['preview:read'],
  contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['summary'] }],
};
const unrestricted: Principal = { spaceId: 'acme', kind: 'admin', scopes: ['preview:read'] };

let ctx: AppContext;
let store: InMemoryContentStore;
let seq = 0;

async function type(s: Scope, apiId: string) {
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId,
    name: apiId,
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
        apiId: 'summary',
        name: 'Summary',
        type: 'Text',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });
}

async function entry(s: Scope, contentTypeApiId: string) {
  const created = await createEntry(ctx, s, {
    contentTypeApiId,
    fields: { title: { 'en-US': `${contentTypeApiId} ${++seq}` } },
  });
  return created.entry.id;
}

async function review(s: Scope, entryId: string) {
  return createAgentReview(ctx, s, {
    workflow: 'enrich',
    entryId,
    proposed: { title: { 'en-US': 'Better' }, summary: { 'en-US': 'Secret' } },
    notes: [],
  });
}

async function task(
  s: Scope,
  contentTypeApiId: string,
  status: WorkflowTask['status'] = 'pending',
) {
  const id = `task-${++seq}`;
  await store.workflowTasks.create(s, {
    id,
    runId: `run-${id}`,
    workflowId: 'wf',
    nodeId: 'approve',
    eventType: `approve-${id}`,
    kind: 'approval',
    entryId: 'any',
    contentTypeApiId,
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
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  await createSpace(ctx, { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US' });
  await type(scope, 'post');
  await type(scope, 'page');
});

describe('countPendingApprovals', () => {
  it('adds pending workflow tasks and agent proposals, leaving decided ones out', async () => {
    await task(scope, 'post');
    await task(scope, 'page');
    await task(scope, 'post', 'approved');
    await review(scope, await entry(scope, 'post'));
    expect(await countPendingApprovals(ctx, scope)).toEqual({
      workflowTasks: 2,
      agentReviews: 1,
      total: 3,
    });
  });

  it('counts past the lists’ caps', async () => {
    for (let i = 0; i < 205; i++) await task(scope, 'post');
    expect((await countPendingApprovals(ctx, scope)).workflowTasks).toBe(205);
  });

  it('counts for a role-bound caller only what it may read, as the lists show it', async () => {
    await task(scope, 'post');
    await task(scope, 'page');
    await review(scope, await entry(scope, 'post'));
    await review(scope, await entry(scope, 'page'));
    const count = await countPendingApprovals(ctx, scope, postsOnly);
    expect(count).toEqual({ workflowTasks: 1, agentReviews: 1, total: 2 });
    expect(count.agentReviews).toBe(
      (await listAgentReviews(ctx, scope, { status: 'pending' }, postsOnly)).length,
    );
  });

  it('counts a proposal whose entry is gone only for an unrestricted caller', async () => {
    await review(scope, 'deleted-entry');
    expect((await countPendingApprovals(ctx, scope, unrestricted)).agentReviews).toBe(1);
    expect((await countPendingApprovals(ctx, scope, postsOnly)).agentReviews).toBe(0);
  });

  it('counts one scope, never another', async () => {
    await type(other, 'post');
    await task(other, 'post');
    await review(other, await entry(other, 'post'));
    await task(scope, 'post');
    expect(await countPendingApprovals(ctx, scope)).toEqual({
      workflowTasks: 1,
      agentReviews: 0,
      total: 1,
    });
  });
});

describe('listAgentReviews for a role-bound caller', () => {
  it('reads every entry in one batch, drops unreadable types and masks denied fields', async () => {
    const post = await entry(scope, 'post');
    await review(scope, post);
    await review(scope, await entry(scope, 'page'));
    await review(scope, 'deleted-entry');
    const get = vi.spyOn(store.entries, 'get');
    const getMany = vi.spyOn(store.entries, 'getMany');
    const typesOf = vi.spyOn(store.entries, 'contentTypesOf');
    const items = await listAgentReviews(ctx, scope, { status: 'pending' }, postsOnly);
    // One narrow read of the entries' types: no per-review lookups, no field bodies.
    expect(typesOf).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(getMany).not.toHaveBeenCalled();
    expect(items.map((r) => r.entryId)).toEqual([post]);
    expect(items[0]?.proposed).toEqual({ title: { 'en-US': 'Better' } });
  });

  it('leaves an unrestricted caller’s list as the store returns it', async () => {
    await review(scope, 'deleted-entry');
    const typesOf = vi.spyOn(store.entries, 'contentTypesOf');
    const items = await listAgentReviews(ctx, scope, {}, unrestricted);
    expect(items).toHaveLength(1);
    expect(items[0]?.proposed.summary).toEqual({ 'en-US': 'Secret' });
    expect(typesOf).not.toHaveBeenCalled();
  });
});

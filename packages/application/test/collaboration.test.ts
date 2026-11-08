import { InvalidStateError, NotFoundError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addComment,
  createContentType,
  createEntry,
  createTask,
  deleteComment,
  listComments,
  listTasks,
  reassignTask,
  reopenTask,
  resolveTask,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

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
    fields: { title: { 'en-US': 'Subject' } },
  });
}

describe('comments', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('adds threaded comments and lists them oldest-first', async () => {
    const entry = await seedEntry(ctx);
    const top = await addComment(ctx, scope, {
      entryId: entry.entry.id,
      body: 'Needs work',
      author: 'editor',
    });
    const reply = await addComment(ctx, scope, {
      entryId: entry.entry.id,
      body: 'On it',
      author: 'writer',
      parentId: top.id,
    });
    expect(reply.parentId).toBe(top.id);

    const all = await listComments(ctx, scope, entry.entry.id);
    expect(all.map((c) => c.body)).toEqual(['Needs work', 'On it']);
  });

  it('rejects a comment on a missing entry or missing parent', async () => {
    const entry = await seedEntry(ctx);
    await expect(
      addComment(ctx, scope, { entryId: 'ghost', body: 'x', author: 'a' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addComment(ctx, scope, { entryId: entry.entry.id, body: 'x', author: 'a', parentId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes a comment', async () => {
    const entry = await seedEntry(ctx);
    const c = await addComment(ctx, scope, { entryId: entry.entry.id, body: 'temp', author: 'a' });
    await deleteComment(ctx, scope, c.id);
    expect(await listComments(ctx, scope, entry.entry.id)).toHaveLength(0);
  });
});

describe('tasks', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('creates, resolves, reopens, and reassigns a task', async () => {
    const entry = await seedEntry(ctx);
    const task = await createTask(ctx, scope, {
      entryId: entry.entry.id,
      body: 'Write alt text',
      assignee: 'writer',
    });
    expect(task.status).toBe('open');

    const resolved = await resolveTask(ctx, scope, task.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBeDefined();

    // Resolving twice is rejected.
    await expect(resolveTask(ctx, scope, task.id)).rejects.toBeInstanceOf(InvalidStateError);

    const reopened = await reopenTask(ctx, scope, task.id);
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeUndefined();

    const reassigned = await reassignTask(ctx, scope, task.id, 'editor');
    expect(reassigned.assignee).toBe('editor');

    const list = await listTasks(ctx, scope, entry.entry.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.assignee).toBe('editor');
  });
});

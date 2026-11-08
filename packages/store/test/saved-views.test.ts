import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSavedView,
  createSpace,
  listSavedViews,
  publishContentType,
  runSavedView,
  SYSTEM_CALLER,
  updateSavedView,
} from '@commerceworker/application';
import {
  ConflictError,
  type FieldDefinition,
  type Principal,
  type SavedView,
  SCOPES,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Saved views on D1 (0029_saved_views): the structured query and columns stored as JSON and read
 * back exactly, keyed by space alone (every environment reads the same rows), the shared-or-own
 * list, and the revision's compare-and-set refusing a lost race. Each test makes its own space:
 * the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-01-01T00:00:00.000Z';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(new Date(AT)), ids: { newId: uid } };
  const spaceId = `views-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Views', defaultLocale: 'en-US' });
  await createEnvironment(ctx, spaceId, 'staging');
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'rank', type: 'Integer', position: 1 }),
    ],
  });
  await publishContentType(ctx, scope, 'article');
  const person = (subject: string, scopes: string[] = [SCOPES.previewRead]): Principal => ({
    spaceId,
    kind: 'user',
    subject,
    scopes,
  });
  return { ctx, scope, spaceId, person };
}

describe('saved views on D1', () => {
  it('stores the query and columns as given and lists shared plus the person’s own', async () => {
    const { ctx, scope, spaceId, person } = await harness();
    const ada = person('ada', [SCOPES.previewRead, SCOPES.contentManage]);
    const bob = person('bob');
    const query = {
      filters: [{ field: 'rank', op: 'between' as const, value: [1, 5] }],
      where: {
        or: [
          { field: 'title', op: 'startsWith' as const, value: 'A' },
          { and: [{ field: 'rank', op: 'exists' as const, value: true }] },
        ],
      },
      order: [{ field: 'sys.updatedAt', direction: 'desc' as const }],
      search: 'cats',
      extra: { assignee: 'me' },
    };
    const shared = await createSavedView(ctx, scope, ada, {
      name: 'Team',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query,
      columns: ['rank', 'sys.status'],
    });
    const mine = await createSavedView(ctx, scope, bob, { name: 'Bob only' });
    await createSavedView(ctx, scope, ada, { name: 'Ada only' });

    const stored = await store.savedViews.get(scope, shared.id);
    expect(stored).toEqual(shared);
    expect(stored?.query).toEqual(query);
    expect((await store.savedViews.get(scope, mine.id))?.columns).toBeUndefined();

    // Keyed by space: staging reads the same rows; another space none.
    const staging = { spaceId, environmentId: 'staging' };
    expect((await store.savedViews.list(staging, { owner: 'bob' })).map((v) => v.name)).toEqual([
      'Bob only',
      'Team',
    ]);
    expect((await store.savedViews.list(scope)).map((v) => v.name)).toEqual(['Team']);
    expect(await store.savedViews.list({ spaceId: `${spaceId}-x`, environmentId: 'main' })).toEqual(
      [],
    );
    expect((await listSavedViews(ctx, staging, bob)).map((v) => v.id)).toEqual([
      mine.id,
      shared.id,
    ]);
  });

  it('refuses a lost race at the revision and a reused id', async () => {
    const { ctx, scope, person } = await harness();
    const bob = person('bob');
    const made = await createSavedView(ctx, scope, bob, { name: 'One' });
    const view = (await store.savedViews.get(scope, made.id)) as SavedView;
    await updateSavedView(ctx, scope, bob, view.id, { name: 'Two' });
    const stale: SavedView = { ...view, name: 'Late', revision: 2 };
    await expect(store.savedViews.save(scope, stale, 1)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await expect(store.savedViews.delete(scope, view.id, 1)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await expect(store.savedViews.save(scope, view)).rejects.toBeInstanceOf(ConflictError);
    expect((await store.savedViews.get(scope, view.id))?.name).toBe('Two');
    await store.savedViews.delete(scope, view.id, 2);
    expect(await store.savedViews.get(scope, view.id)).toBeNull();
  });

  it('keeps a view’s creator and creation time through every save, as the in-memory store does', async () => {
    const { ctx, scope, person } = await harness();
    const view = await createSavedView(ctx, scope, person('bob'), { name: 'Mine' });
    await store.savedViews.save(
      scope,
      {
        ...view,
        createdBy: 'mallory',
        createdAt: '2030-01-01T00:00:00.000Z',
        revision: 2,
      },
      1,
    );
    const read = await store.savedViews.get(scope, view.id);
    expect(read).toMatchObject({ createdBy: view.createdBy, createdAt: view.createdAt });
    expect(read?.revision).toBe(2);
  });

  it('runs a stored where tree through the D1 entries query', async () => {
    const { ctx, scope, person } = await harness();
    const bob = person('bob');
    for (const [title, rank] of [
      ['Apple', 1],
      ['Banana', 2],
      ['Cherry', 9],
    ] as const) {
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': title }, rank: { 'en-US': rank } },
      });
    }
    const view = await createSavedView(ctx, scope, bob, {
      name: 'Low or A',
      contentTypeApiId: 'article',
      query: {
        where: {
          or: [
            { field: 'title', op: 'startsWith', value: 'C' },
            { field: 'rank', op: 'between', value: [2, 3] },
          ],
        },
        order: [{ field: 'title', direction: 'desc' }],
      },
    });
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(run.items.map((e) => (e.fields.title as Record<string, string>)['en-US'])).toEqual([
      'Cherry',
      'Banana',
    ]);
  });
});

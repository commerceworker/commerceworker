import {
  ConflictError,
  type FieldDefinition,
  ForbiddenError,
  MAX_PERSONAL_VIEWS,
  MAX_SHARED_VIEWS,
  NotFoundError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  actingAs,
  createContentType,
  createEntry,
  createEnvironment,
  createSavedView,
  createSpace,
  deleteContentType,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  publishContentType,
  runSavedView,
  SYSTEM_CALLER,
  updateSavedView,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };
const otherSpace = { spaceId: 'other', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const READ = [SCOPES.previewRead];
const MANAGE = [SCOPES.previewRead, SCOPES.contentManage];

const person = (
  subject: string,
  scopes: readonly string[] = READ,
  contentGrants?: Principal['contentGrants'],
): Principal => ({
  spaceId: 'site',
  kind: 'user',
  subject,
  scopes,
  ...(contentGrants ? { contentGrants } : {}),
});

const ada = person('ada@example.com', MANAGE);
const bob = person('bob@example.com');
const key: Principal = { spaceId: 'site', kind: 'cma', scopes: MANAGE };

const refusal = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ValidationError))
    throw new Error(`expected a ValidationError, got ${String(err)}`);
  return err.issues.map((i) => `${i.field}: ${i.message}`);
};

describe('saved views', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('v'),
    };
    await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
    await createEnvironment(ctx, 'site', 'staging');
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        field({ apiId: 'section', type: 'Symbol', position: 1 }),
        field({ apiId: 'salary', type: 'Integer', position: 2 }),
      ],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    });
    await publishContentType(ctx, scope, 'article');
    await publishContentType(ctx, scope, 'page');
    for (const [title, section, salary] of [
      ['Alpha', 'news', 10],
      ['Beta', 'news', 20],
      ['Gamma', 'sport', 30],
    ] as const) {
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: {
          title: { 'en-US': title },
          section: { 'en-US': section },
          salary: { 'en-US': salary },
        },
      });
    }
    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'About' } },
    });
  });

  const titles = (run: { items: readonly { fields: Record<string, unknown> }[] }) =>
    run.items.map((e) => (e.fields.title as Record<string, string>)['en-US']);

  it('stores the structured query and columns, and runs it through the entries query', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: ' News, newest first ',
      contentTypeApiId: 'article',
      query: {
        filters: [{ field: 'fields.section', op: 'eq', value: 'news' }],
        where: {
          or: [
            { field: 'title', op: 'startsWith', value: 'A' },
            { field: 'salary', op: 'gte', value: 20 },
          ],
        },
        order: [{ field: 'fields.title', direction: 'desc' }],
      },
      columns: ['section', 'sys.status'],
    });
    expect(view).toMatchObject({
      name: 'News, newest first',
      visibility: 'personal',
      createdBy: 'bob@example.com',
      contentTypeApiId: 'article',
      // The `fields.` prefix is the query string's spelling: the stored form names the field.
      query: {
        filters: [{ field: 'section', op: 'eq', value: 'news' }],
        order: [{ field: 'title', direction: 'desc' }],
      },
      columns: ['section', 'sys.status'],
      revision: 1,
    });
    expect(await getSavedView(ctx, scope, bob, view.id)).toEqual(view);
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(titles(run)).toEqual(['Beta', 'Alpha']);
    expect(run.view).toMatchObject({ id: view.id, columns: ['section', 'sys.status'] });
    expect(run.ignored).toBeUndefined();
  });

  it('refuses a stored query a live query would refuse, strictly', async () => {
    const bad = (query: unknown) =>
      refusal(createSavedView(ctx, scope, bob, { name: 'x', contentTypeApiId: 'article', query }));
    expect(await bad({ filters: [{ field: 'title', op: 'match', value: '' }] })).toEqual([
      'query.filters[0]: match takes a non-empty string',
    ]);
    expect(await bad({ filters: [{ field: 'title', op: 'near', value: 'x' }] })).toEqual([
      expect.stringContaining('query.filters[0]: op must be one of'),
    ]);
    expect(await bad({ where: { and: [] } })).toEqual([
      'query.where.and: expected a non-empty array',
    ]);
    expect(await bad({ order: [{ field: 'title; drop', direction: 'asc' }] })).toEqual([
      'query.order[0]: "title; drop" is not a field a sort can name',
    ]);
    expect(await bad({ filters: [{ field: 'title', op: 'eq', value: { $gt: 1 } }] })).toEqual([
      'query.filters[0]: a value is a string, number, boolean or a list of them',
    ]);
    // A misspelt key is refused rather than kept: only `extra` keeps what isn't understood.
    expect(await bad({ fitlers: [] })).toEqual([
      'query: query holds only filters, where, order, search, extra; not fitlers',
    ]);
    expect(
      await refusal(
        createSavedView(ctx, scope, bob, {
          name: 'x',
          contentTypeApiId: 'article',
          columns: ['nope'],
        }),
      ),
    ).toEqual(['columns[0]: article has no field "nope"']);
    expect(
      await refusal(createSavedView(ctx, scope, bob, { name: 'x', columns: ['title'] })),
    ).toEqual(['columns[0]: a view over every type shows only sys.status, sys.updatedAt']);
    expect(
      await refusal(createSavedView(ctx, scope, bob, { name: 'x', contentTypeApiId: 'ghost' })),
    ).toEqual(['contentTypeApiId: No content type "ghost" in this environment']);
  });

  it('keeps unknown query keys verbatim under extra, and says a run left them out', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: 'Mine',
      contentTypeApiId: 'article',
      query: { extra: { assignee: 'me' } },
    });
    expect(view.query.extra).toEqual({ assignee: 'me' });
    const renamed = await updateSavedView(ctx, scope, bob, view.id, { name: 'Mine, renamed' });
    expect(renamed.query.extra).toEqual({ assignee: 'me' });
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(run.ignored).toEqual(['assignee']);
    expect(run.items).toHaveLength(3);
  });

  it('shows a personal view to its owner only: anyone else gets a 404', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: 'Bob’s',
      contentTypeApiId: 'article',
    });
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.id)).toEqual([view.id]);
    expect(await listSavedViews(ctx, scope, ada)).toEqual([]);
    expect(await listSavedViews(ctx, scope, key)).toEqual([]);
    for (const p of [ada, key]) {
      await expect(getSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(runSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateSavedView(ctx, scope, p, view.id, { name: 'taken' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('is the space’s: every environment sees it, another space never does', async () => {
    const view = await createSavedView(ctx, scope, ada, {
      name: 'All',
      visibility: 'shared',
    });
    expect((await listSavedViews(ctx, staging, bob)).map((v) => v.id)).toEqual([view.id]);
    expect(await listSavedViews(ctx, otherSpace, { ...bob, spaceId: 'other' })).toEqual([]);
    await expect(getSavedView(ctx, otherSpace, ada, view.id)).rejects.toBeInstanceOf(NotFoundError);
    // Run in staging, it lists staging's entries: none.
    expect((await runSavedView(ctx, staging, bob, view.id)).items).toEqual([]);
  });

  it('needs content:manage to create, change, share or delete a shared view', async () => {
    await expect(
      createSavedView(ctx, scope, bob, { name: 'Team', visibility: 'shared' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const mine = await createSavedView(ctx, scope, bob, { name: 'Mine' });
    await expect(
      updateSavedView(ctx, scope, bob, mine.id, { visibility: 'shared' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const shared = await createSavedView(ctx, scope, ada, { name: 'Team', visibility: 'shared' });
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.name)).toEqual(['Mine', 'Team']);
    await expect(
      updateSavedView(ctx, scope, bob, shared.id, { name: 'Hijacked' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSavedView(ctx, scope, bob, shared.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // A key saves shared views only: it has no person to own a personal one.
    expect(await refusal(createSavedView(ctx, scope, key, { name: 'K' }))).toEqual([
      'visibility: Only a person has personal views; an API key saves shared views',
    ]);
    const byKey = await createSavedView(ctx, scope, key, { name: 'K', visibility: 'shared' });
    expect(byKey.createdBy).toBe('cma');

    // Its creator stops sharing it: theirs alone again, as a fresh read says.
    await updateSavedView(ctx, scope, ada, shared.id, { visibility: 'personal' });
    const unshared = await getSavedView(ctx, scope, ada, shared.id);
    expect(unshared).toMatchObject({ visibility: 'personal', createdBy: 'ada@example.com' });
    expect((await listSavedViews(ctx, scope, ada)).map((v) => v.id)).toContain(shared.id);
    await expect(getSavedView(ctx, scope, bob, shared.id)).rejects.toBeInstanceOf(NotFoundError);
    await deleteSavedView(ctx, scope, ada, shared.id);
    await expect(getSavedView(ctx, scope, ada, shared.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets only the creator stop sharing a view: nobody else can take it, nor strand it', async () => {
    const cleo = person('cleo@example.com', MANAGE);
    const unshare = 'visibility: Only the person who created a shared view can stop sharing it';
    const keyless = 'visibility: Only a person has personal views';
    const shared = await createSavedView(ctx, scope, ada, { name: 'Team', visibility: 'shared' });
    const byKey = await createSavedView(ctx, scope, key, { name: 'K', visibility: 'shared' });

    for (const [who, id, said] of [
      [cleo, shared.id, unshare], // another manager: a person, but not this view's
      [key, shared.id, keyless], // a key has no personal views to keep it in
      [ada, byKey.id, unshare], // nobody is a key's view's creator, so it stays shared
    ] as const) {
      const [issue] = await refusal(
        updateSavedView(ctx, scope, who, id, { visibility: 'personal' }),
      );
      expect(issue).toContain(said);
      expect(await getSavedView(ctx, scope, ada, id)).toMatchObject({
        visibility: 'shared',
        revision: 1,
      });
    }
    // Still everyone's, and anyone with content:manage can still change or delete it.
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.name)).toEqual(['K', 'Team']);
    await updateSavedView(ctx, scope, cleo, shared.id, { name: 'Team, renamed' });
    expect((await getSavedView(ctx, scope, bob, shared.id)).createdBy).toBe('ada@example.com');
    await deleteSavedView(ctx, scope, ada, byKey.id);
  });

  it('runs a shared view with the viewer’s grants, never the creator’s', async () => {
    const view = await createSavedView(ctx, scope, ada, {
      name: 'Everything',
      visibility: 'shared',
      query: { order: [{ field: 'sys.updatedAt', direction: 'asc' }] },
    });
    expect(await runSavedView(ctx, scope, ada, view.id).then(titles)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'About',
    ]);
    // Pages only: the view over every type lists no article for this viewer.
    const pagesOnly = person('pat@example.com', READ, [
      { contentTypeApiId: 'page', actions: ['read'] },
    ]);
    expect(await runSavedView(ctx, scope, pagesOnly, view.id).then(titles)).toEqual(['About']);
    // Salary hidden: the rows come back with it masked.
    const noSalary = person('nia@example.com', READ, [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    const masked = await runSavedView(ctx, scope, noSalary, view.id);
    expect(masked.items.length).toBe(4);
    expect(masked.items.every((e) => !('salary' in e.fields))).toBe(true);
  });

  it('skips a view over a type the viewer can’t read, or naming a field their role hides', async () => {
    const bySalary = await createSavedView(ctx, scope, ada, {
      name: 'Well paid',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query: { filters: [{ field: 'salary', op: 'gt', value: 15 }] },
    });
    const sortedBySalary = await createSavedView(ctx, scope, ada, {
      name: 'By pay',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query: {
        where: {
          or: [
            { field: 'title', op: 'exists' },
            { field: 'salary', op: 'lt', value: 1 },
          ],
        },
      },
    });
    const plain = await createSavedView(ctx, scope, ada, {
      name: 'Articles',
      contentTypeApiId: 'article',
      visibility: 'shared',
      columns: ['salary', 'section'],
    });
    const pages = await createSavedView(ctx, scope, ada, {
      name: 'Pages',
      contentTypeApiId: 'page',
      visibility: 'shared',
    });
    const noSalary = person('nia@example.com', READ, [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    // A filter or a `where` predicate over the hidden field: the view isn't there for them.
    expect((await listSavedViews(ctx, scope, noSalary)).map((v) => v.name)).toEqual([
      'Articles',
      'Pages',
    ]);
    for (const id of [bySalary.id, sortedBySalary.id]) {
      await expect(getSavedView(ctx, scope, noSalary, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(runSavedView(ctx, scope, noSalary, id)).rejects.toBeInstanceOf(NotFoundError);
    }
    // A hidden column is left out of the view they're shown.
    expect((await getSavedView(ctx, scope, noSalary, plain.id)).columns).toEqual(['section']);
    // A type they can't read: none of its views.
    const articlesOnly = person('art@example.com', READ, [
      { contentTypeApiId: 'article', actions: ['read'] },
    ]);
    expect((await listSavedViews(ctx, scope, articlesOnly)).map((v) => v.id)).not.toContain(
      pages.id,
    );
    expect(
      (await listSavedViews(ctx, scope, articlesOnly, { contentTypeApiId: 'page' })).map(
        (v) => v.id,
      ),
    ).toEqual([]);
    // And they can't save one that names the field either.
    await expect(
      createSavedView(ctx, scope, noSalary, {
        name: 'Sneaky',
        contentTypeApiId: 'article',
        query: { order: [{ field: 'salary', direction: 'desc' }] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a stale revision, and applies a change without one to the view as it stands', async () => {
    const view = await createSavedView(ctx, scope, bob, { name: 'One' });
    const two = await updateSavedView(ctx, scope, bob, view.id, { name: 'Two', revision: 1 });
    expect(two.revision).toBe(2);
    await expect(
      updateSavedView(ctx, scope, bob, view.id, { name: 'Late', revision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteSavedView(ctx, scope, bob, view.id, 1)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const three = await updateSavedView(ctx, scope, bob, view.id, { columns: ['sys.status'] });
    expect(three).toMatchObject({ name: 'Two', columns: ['sys.status'], revision: 3 });
    const back = await updateSavedView(ctx, scope, bob, view.id, { columns: null });
    expect(back.columns).toBeUndefined();
    await deleteSavedView(ctx, scope, bob, view.id, 4);
    expect(await listSavedViews(ctx, scope, bob)).toEqual([]);
  });

  it('holds a change of visibility to the same caps as a new view', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const stored = (over: { id: string; visibility: 'personal' | 'shared'; createdBy: string }) =>
      ctx.store.savedViews.save(scope, {
        name: over.id,
        contentTypeApiId: null,
        query: {},
        revision: 1,
        createdAt: at,
        updatedAt: at,
        ...over,
      });
    const toShare = await createSavedView(ctx, scope, ada, { name: 'To share' });
    const toTake = await createSavedView(ctx, scope, ada, {
      name: 'To take',
      visibility: 'shared',
    });
    for (let i = 1; i < MAX_SHARED_VIEWS; i++) {
      await stored({ id: `s${i}`, visibility: 'shared', createdBy: 'cma' });
    }
    // The space is full: nothing more is shared, however it gets there.
    expect(
      await refusal(updateSavedView(ctx, scope, ada, toShare.id, { visibility: 'shared' })),
    ).toEqual([`visibility: A space holds at most ${MAX_SHARED_VIEWS} shared views`]);
    expect((await getSavedView(ctx, scope, ada, toShare.id)).visibility).toBe('personal');
    // A view staying shared isn't counted against itself.
    await updateSavedView(ctx, scope, ada, toTake.id, { name: 'Renamed', visibility: 'shared' });

    for (let i = 1; i < MAX_PERSONAL_VIEWS; i++) {
      await stored({ id: `p${i}`, visibility: 'personal', createdBy: ada.subject as string });
    }
    // Taken back, a view counts against the owner's personal views.
    expect(
      await refusal(updateSavedView(ctx, scope, ada, toTake.id, { visibility: 'personal' })),
    ).toEqual([
      `visibility: A person keeps at most ${MAX_PERSONAL_VIEWS} personal views in a space`,
    ]);
    expect((await getSavedView(ctx, scope, ada, toTake.id)).visibility).toBe('shared');
    // Room made, it goes through.
    await deleteSavedView(ctx, scope, ada, 'p1');
    await updateSavedView(ctx, scope, ada, toTake.id, { visibility: 'personal' });
    expect((await getSavedView(ctx, scope, ada, toTake.id)).visibility).toBe('personal');
  });

  it('keeps the columns a role hides where they stood when that role saves columns', async () => {
    const editor = person('ed@example.com', MANAGE, [
      { contentTypeApiId: 'article', actions: ['read'], deniedFields: ['salary'] },
    ]);
    const view = await createSavedView(ctx, scope, ada, {
      name: 'Pay',
      contentTypeApiId: 'article',
      visibility: 'shared',
      columns: ['sys.status', 'salary', 'section', 'sys.updatedAt'],
    });
    const stored = async () => (await ctx.store.savedViews.get(scope, view.id))?.columns;
    const shown = await getSavedView(ctx, scope, editor, view.id);
    expect(shown.columns).toEqual(['sys.status', 'section', 'sys.updatedAt']);

    const saved = await updateSavedView(ctx, scope, editor, view.id, {
      columns: ['section', 'sys.status'],
    });
    // The editor still isn't shown it; the store and its other readers still have it, in place.
    expect(saved.columns).toEqual(['section', 'sys.status']);
    expect(await stored()).toEqual(['section', 'salary', 'sys.status']);

    // Past the end of a shorter list it goes last; a hidden column can't be added by naming it.
    await updateSavedView(ctx, scope, editor, view.id, { columns: ['section'] });
    expect(await stored()).toEqual(['section', 'salary']);
    await updateSavedView(ctx, scope, editor, view.id, { columns: ['salary'] });
    expect(await stored()).toEqual(['salary']);
    // Back to the default keeps it too, beside the default columns.
    await updateSavedView(ctx, scope, editor, view.id, { columns: null });
    expect(await stored()).toEqual(['salary', 'sys.status', 'sys.updatedAt']);
    // A role that sees it replaces it like any other column.
    await updateSavedView(ctx, scope, ada, view.id, { columns: ['section'] });
    expect(await stored()).toEqual(['section']);
    await updateSavedView(ctx, scope, ada, view.id, { columns: null });
    expect(await stored()).toBeUndefined();
  });

  it('runs sys.createdBy=me as each reader, and keeps author ids from a key not served them', async () => {
    const mine = await createEntry(actingAs(ctx, bob), scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'By Bob' } },
    });
    const view = await createSavedView(ctx, scope, ada, {
      name: 'My entries',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query: { filters: [{ field: 'sys.createdBy', op: 'eq', value: 'me' }] },
    });
    expect((await runSavedView(ctx, scope, bob, view.id)).items.map((e) => e.id)).toEqual([
      mine.entry.id,
    ]);
    expect((await runSavedView(ctx, scope, ada, view.id)).items).toEqual([]);

    // A read key isn't told who wrote what: not in the rows, and not by a query that names it.
    const reader: Principal = { spaceId: 'site', kind: 'cpa', scopes: READ };
    const all = await createSavedView(ctx, scope, ada, {
      name: 'All',
      contentTypeApiId: 'article',
      visibility: 'shared',
    });
    const rows = (await runSavedView(ctx, scope, reader, all.id)).items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((e) => 'createdBy' in e || 'updatedBy' in e)).toBe(false);
    await expect(getSavedView(ctx, scope, reader, view.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(runSavedView(ctx, scope, reader, view.id)).rejects.toBeInstanceOf(NotFoundError);
    const listed = await listSavedViews(ctx, scope, reader);
    expect(listed.map((v) => v.name)).toEqual(['All']);

    // Nor who created a view: a shared view's creator is a person's id too.
    expect(listed[0]).not.toHaveProperty('createdBy');
    expect(await getSavedView(ctx, scope, reader, all.id)).not.toHaveProperty('createdBy');
    expect((await getSavedView(ctx, scope, key, all.id)).createdBy).toBe(all.createdBy);
    expect((await getSavedView(ctx, scope, bob, all.id)).createdBy).toBe(all.createdBy);
    expect((await ctx.store.savedViews.get(scope, all.id))?.createdBy).toBe(all.createdBy);
  });

  it('holds new columns to the rule a save over a view does', async () => {
    const editor = person('ed@example.com', MANAGE, [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    const made = await createSavedView(ctx, scope, editor, {
      name: 'No pay',
      contentTypeApiId: 'article',
      columns: ['salary', 'section'],
    });
    expect(made.columns).toEqual(['section']);
    expect((await ctx.store.savedViews.get(scope, made.id))?.columns).toEqual(['section']);
  });

  it('says when a view’s content type is missing, and can still be changed and deleted', async () => {
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      apiId: 'promo',
      name: 'Promo',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    });
    await publishContentType(ctx, staging, 'promo');
    const view = await createSavedView(ctx, staging, bob, {
      name: 'Promos',
      contentTypeApiId: 'promo',
      columns: ['title'],
    });
    expect((await runSavedView(ctx, staging, bob, view.id)).typeMissing).toBeUndefined();

    // `main` has no such type: not an empty result, and not an error.
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(run).toMatchObject({ items: [], typeMissing: true });
    expect(run.view.id).toBe(view.id);
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.id)).toContain(view.id);

    // Back to the default columns, and other changes, need no type; naming columns does.
    await updateSavedView(ctx, scope, bob, view.id, { columns: null, name: 'Old promos' });
    expect(await getSavedView(ctx, scope, bob, view.id)).toMatchObject({ name: 'Old promos' });
    expect((await getSavedView(ctx, scope, bob, view.id)).columns).toBeUndefined();
    expect(
      await refusal(updateSavedView(ctx, scope, bob, view.id, { columns: ['title'] })),
    ).toEqual(['contentTypeApiId: No content type "promo" in this environment']);
    await deleteSavedView(ctx, scope, bob, view.id);
    await expect(getSavedView(ctx, scope, bob, view.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports a type the delete flow took, and picks it up again if the type comes back', async () => {
    const promo = {
      apiId: 'promo',
      name: 'Promo',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    };
    await createContentType(ctx, SYSTEM_CALLER, scope, promo);
    await createContentType(ctx, SYSTEM_CALLER, staging, promo);
    await publishContentType(ctx, staging, 'promo');
    const mine = await createSavedView(ctx, scope, bob, {
      name: 'Promos',
      contentTypeApiId: 'promo',
      columns: ['title'],
    });
    const shared = await createSavedView(ctx, scope, ada, {
      name: 'Team promos',
      contentTypeApiId: 'promo',
      visibility: 'shared',
      query: { filters: [{ field: 'title', op: 'match', value: 'team' }] },
    });
    const everyType = await createSavedView(ctx, scope, bob, { name: 'Everything' });

    // A view is no dependent: nothing asks for it to go first, and the delete leaves it alone.
    await deleteContentType(ctx, scope, 'promo');

    for (const id of [mine.id, shared.id]) {
      expect(await runSavedView(ctx, scope, bob, id)).toMatchObject({
        items: [],
        typeMissing: true,
      });
    }
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.name)).toEqual(
      expect.arrayContaining(['Promos', 'Team promos', 'Everything']),
    );
    // Only this environment lost it, and a view over every type never needed it.
    expect((await runSavedView(ctx, staging, bob, mine.id)).typeMissing).toBeUndefined();
    expect((await runSavedView(ctx, scope, bob, everyType.id)).typeMissing).toBeUndefined();

    await createContentType(ctx, SYSTEM_CALLER, scope, promo);
    await publishContentType(ctx, scope, 'promo');
    await createEntry(ctx, scope, {
      contentTypeApiId: 'promo',
      fields: { title: { 'en-US': 'About' } },
    });
    const back = await runSavedView(ctx, scope, bob, mine.id);
    expect(back.typeMissing).toBeUndefined();
    expect(back.items).toHaveLength(1);
  });

  it('caps the personal views a person keeps', async () => {
    for (let i = 0; i < MAX_PERSONAL_VIEWS; i++) {
      await createSavedView(ctx, scope, bob, { name: `View ${i}` });
    }
    expect(await refusal(createSavedView(ctx, scope, bob, { name: 'One more' }))).toEqual([
      `visibility: A person keeps at most ${MAX_PERSONAL_VIEWS} personal views in a space`,
    ]);
    // Someone else's cap is their own.
    await createSavedView(ctx, scope, ada, { name: 'Ada’s first' });
  });
});

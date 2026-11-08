// @vitest-environment jsdom
import type { ContentType, SavedView } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryListQuery, EntryPage } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const views: SavedView[] = [];
const access = { scopes: ['preview:read', 'content:manage'] as string[] };
const client = {
  listEntryPage: vi.fn(
    async (_t?: string, _q?: EntryListQuery): Promise<EntryPage> => ({
      items: [
        {
          id: 'e1',
          contentType: 'article',
          status: 'draft',
          version: 1,
          fields: { title: { 'en-US': 'Pricing' }, section: { 'en-US': 'news' } },
        },
      ],
    }),
  ),
  contentTypeEntryCounts: vi.fn(async () => []),
  getSpaceAccess: vi.fn(async () => ({
    spaceId: 's1',
    kind: 'user',
    subject: 'ada',
    ...access,
    bulkJobs: [],
  })),
  listSavedViews: vi.fn(async () => [...views]),
  createSavedView: vi.fn(async (input: Partial<SavedView>) => {
    const made = view({ ...input, id: 'v-new' });
    views.push(made);
    return made;
  }),
  updateSavedView: vi.fn(async (id: string, changes: Partial<SavedView>) => {
    const i = views.findIndex((v) => v.id === id);
    const { revision: _r, ...rest } = changes;
    const next = { ...(views[i] as SavedView), ...rest, revision: (views[i]?.revision ?? 0) + 1 };
    views[i] = next as SavedView;
    return next;
  }),
  deleteSavedView: vi.fn(async (id: string) => {
    views.splice(
      views.findIndex((v) => v.id === id),
      1,
    );
  }),
};
const runner = async (fn: () => Promise<void>) => {
  try {
    await fn();
  } catch {}
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's1', environment: 'main', locale: 'en-US' },
    busy: false,
    run: runner,
  }),
  useLocalRun: () => ({ busy: false, run: runner }),
}));
vi.mock('~/cms/lib/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/cms/lib/assistant')>()),
  useAssistantEdit: () => () => Promise.resolve(null),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');
const { EntriesList } = await import('~/cms/routes/EntriesList');

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: 'v1',
    name: 'News',
    contentTypeApiId: 'article',
    visibility: 'personal',
    createdBy: 'ada',
    query: {},
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  views.length = 0;
  access.scopes = ['preview:read', 'content:manage'];
});

const article = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
    {
      apiId: 'section',
      name: 'Section',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'RichText',
      localized: false,
      required: false,
      position: 2,
    },
    {
      apiId: 'blocks',
      name: 'Blocks',
      type: 'Array',
      localized: false,
      required: false,
      position: 3,
    },
  ],
} as ContentType;

function Where() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function setup(url = '/content/article', type: ContentType = article) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [type], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route
                path=":typeId"
                element={
                  <>
                    <EntriesList />
                    <Where />
                  </>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const search = () => decodeURIComponent(screen.getByTestId('search').textContent ?? '');
const open = async (name: RegExp | string) => {
  const trigger = await screen.findByRole('button', { name }, { timeout: 5000 });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

describe('the entries list URL', () => {
  it('lists what a link says: its filters, sort, search and columns', async () => {
    setup('/content/article?fields.section[match]=ne&order=-fields.title&columns=section');
    await screen.findByRole('link', { name: 'Pricing' }, { timeout: 5000 });
    expect(client.listEntryPage).toHaveBeenLastCalledWith(
      'article',
      expect.objectContaining({
        filters: [{ field: 'section', op: 'match', value: 'ne' }],
        order: [{ field: 'title', direction: 'desc' }],
      }),
      undefined,
    );
    expect(screen.getByRole('columnheader', { name: 'Section' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'news' })).toBeTruthy();
  });

  it('writes a search and a column choice into the URL', async () => {
    setup();
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search entries' }), {
      target: { value: 'launch' },
    });
    await waitFor(() => expect(search()).toContain('query=launch'));
    await open('Columns');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Section' }));
    await waitFor(() => expect(search()).toContain('columns=sys.status,sys.updatedAt,section'));
  });

  it('writes the search on a pause, and follows a URL something else changed', async () => {
    views.push(view({ query: { search: 'from the view' } }));
    setup('/content/article?query=old');
    const box = (await screen.findByRole('searchbox', {
      name: 'Search entries',
    })) as HTMLInputElement;
    expect(box.value).toBe('old');
    // Every keystroke shows at once, whatever the URL has caught up to.
    for (const value of ['ol', 'o', 'on', 'one']) {
      fireEvent.change(box, { target: { value } });
      expect(box.value).toBe(value);
    }
    expect(search()).toBe('?query=old');
    await waitFor(() => expect(search()).toBe('?query=one'));
    expect(box.value).toBe('one');

    await waitFor(() => expect(client.listSavedViews).toHaveBeenCalled());
    await open('Views');
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'News' }));
    await waitFor(() => expect(box.value).toBe('from the view'));
  });

  it('keeps columns in the picker’s order, whatever order they’re clicked in', async () => {
    setup('/content/article?columns=body');
    await open('Columns');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Section' }));
    await waitFor(() => expect(search()).toBe('?columns=section,body'));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
    await waitFor(() => expect(search()).toBe('?columns=sys.status,section,body'));
  });

  it('lets go of a column the type doesn’t have once the columns change', async () => {
    setup('/content/article?columns=gone,section');
    await open('Columns');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Status' }));
    await waitFor(() => expect(search()).toBe('?columns=sys.status,section'));
  });

  it('sorts from a header only where a field has one value to sort by', async () => {
    setup('/content/article?columns=sys.status,section,body,blocks');
    await screen.findByRole('link', { name: 'Pricing' }, { timeout: 5000 });
    for (const name of ['Title', 'Status', 'Section']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    for (const name of ['Body', 'Blocks']) {
      expect(screen.getByRole('columnheader', { name })).toBeTruthy();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('names what a cell can’t show, and titles what it may cut short', async () => {
    const long = 'A section name long enough that a column would cut it short';
    client.listEntryPage.mockResolvedValueOnce({
      items: [
        {
          id: 'e1',
          contentType: 'article',
          status: 'draft',
          version: 1,
          fields: {
            title: { 'en-US': 'Pricing' },
            section: { 'en-US': long },
            body: { 'en-US': { nodeType: 'document', content: [] } },
            blocks: { 'en-US': [{ a: 1 }, { a: 2 }, { a: 3 }] },
          },
        },
      ],
    });
    setup('/content/article?columns=section,body,blocks');
    expect((await screen.findByRole('cell', { name: long })).getAttribute('title')).toBe(long);
    const body = screen.getByRole('cell', { name: 'Rich text' });
    expect(body.className).toContain('text-muted-foreground');
    expect(body.getAttribute('title')).toBeNull();
    expect(screen.getByRole('cell', { name: '3 items' })).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('joins a list of scalars and shows a date as written, sorting only the date', async () => {
    const column = (apiId: string, name: string, over: object) => ({
      apiId,
      name,
      localized: false,
      required: false,
      position: 4,
      ...over,
    });
    const event = {
      ...article,
      fields: [
        ...article.fields,
        column('tags', 'Tags', { type: 'Array', items: { type: 'Symbol' } }),
        column('scores', 'Scores', { type: 'Array', items: { type: 'Number' } }),
        column('days', 'Days', { type: 'Array', items: { type: 'Date', format: 'date' } }),
        column('doors', 'Doors', { type: 'Date', format: 'time' }),
        column('spare', 'Spare', { type: 'Array', items: { type: 'Integer' } }),
      ],
    } as ContentType;
    client.listEntryPage.mockResolvedValueOnce({
      items: [
        {
          id: 'e1',
          contentType: 'article',
          status: 'draft',
          version: 1,
          fields: {
            title: { 'en-US': 'Pricing' },
            tags: { 'en-US': ['news', 'launch'] },
            scores: { 'en-US': [1.5, 0, 3] },
            days: { 'en-US': ['2026-11-03', '2026-11-04'] },
            doors: { 'en-US': '14:30' },
            spare: { 'en-US': [] },
          },
        },
      ],
    });
    setup('/content/article?columns=tags,scores,days,doors,spare', event);
    await screen.findByRole('cell', { name: 'news, launch' }, { timeout: 5000 });
    // A zero is a value, and a list with nothing in it says nothing.
    expect(screen.getByRole('cell', { name: '1.5, 0, 3' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '2026-11-03, 2026-11-04' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '14:30' })).toBeTruthy();
    expect(screen.queryByText(/\bitems?\b/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Doors' })).toBeTruthy();
    for (const name of ['Tags', 'Scores', 'Days', 'Spare']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('always renders the status for a phone, once, whichever columns are picked', async () => {
    setup('/content/article?columns=section');
    const row = (await screen.findByRole('link', { name: 'Pricing' })).closest('tr') as HTMLElement;
    const status = within(row).getByText('Draft').closest('td') as HTMLElement;
    expect(status.className).toContain('md:hidden');
    cleanup();
    setup('/content/article');
    const picked = (await screen.findByRole('link', { name: 'Pricing' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(picked).getAllByText('Draft')).toHaveLength(1);
    expect(within(picked).getByText('Draft').closest('td')?.className).not.toContain('md:hidden');
  });
});

describe('the views menu', () => {
  it('opens a view as its URL, and says when the list has moved off it', async () => {
    views.push(
      view({
        query: { filters: [{ field: 'section', op: 'eq', value: 'news' }] },
        columns: ['section'],
      }),
      view({ id: 'v2', name: 'Team picks', visibility: 'shared', createdBy: 'lead' }),
    );
    setup();
    await waitFor(() => expect(client.listSavedViews).toHaveBeenCalledWith('article'));
    await open('Views');
    expect(await screen.findByText('Your views')).toBeTruthy();
    expect(screen.getByText('Shared with the space')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'News' }));
    await waitFor(() => expect(search()).toBe('?view=v1&fields.section=news&columns=section'));
    await waitFor(() =>
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ filters: [{ field: 'section', op: 'eq', value: 'news' }] }),
        undefined,
      ),
    );
    const trigger = screen.getByRole('button', { name: /^View:\s*News/ });
    expect(trigger.textContent).not.toContain('edited');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search entries' }), {
      target: { value: 'x' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /News.*edited/ })).toBeTruthy());

    // Save changes writes the list back over the view, at the revision read.
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        query: { filters: [{ field: 'section', op: 'eq', value: 'news' }], search: 'x' },
        revision: 1,
      }),
    );
  });

  it('sends columns with a save only when they changed', async () => {
    views.push(view({ columns: ['section'] }));
    setup('/content/article?view=v1&columns=section,body');
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        query: {},
        columns: ['section', 'body'],
        revision: 1,
      }),
    );
  });

  it('saves the list as a new view, shared when asked, in the structured form', async () => {
    setup('/content/article?sys.status[in]=draft,changed&order=fields.title&columns=section');
    await open('Views');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as new view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'In progress' },
    });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Share with the space' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }));
    await waitFor(() =>
      expect(client.createSavedView).toHaveBeenCalledWith({
        name: 'In progress',
        contentTypeApiId: 'article',
        visibility: 'shared',
        query: {
          filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
          order: [{ field: 'title', direction: 'asc' }],
        },
        columns: ['section'],
      }),
    );
    await waitFor(() => expect(search()).toContain('view=v-new'));
  });

  it('works on a singleton’s list as on any other, its one row and all', async () => {
    views.push(view({ name: 'Settings by status', columns: ['section'] }));
    setup('/content/article', { ...article, singleton: true } as ContentType);
    await screen.findByRole('link', { name: 'Pricing' }, { timeout: 5000 });
    expect(client.listSavedViews).toHaveBeenCalledWith('article');
    await open(/views/i);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Settings by status/ }));
    await waitFor(() => expect(search()).toContain('view=v1'));
    expect(search()).toContain('columns=section');
    expect(await screen.findByRole('columnheader', { name: 'Section' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pricing' })).toBeTruthy();
  });

  it('offers no sharing, and no changes to a shared view, without content:manage', async () => {
    access.scopes = ['preview:read'];
    views.push(view(), view({ id: 'v2', name: 'Team picks', visibility: 'shared' }));
    setup('/content/article?view=v2');
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    await open(/Team picks/);
    expect(screen.queryByRole('menuitem', { name: 'Rename…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Stop sharing' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete view…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as new view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('keeps a saved comparand’s type when saving changes over it', async () => {
    views.push(view({ query: { filters: [{ field: 'section', op: 'gt', value: 3 }] } }));
    setup('/content/article?view=v1&fields.section[gt]=3&query=x');
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        query: { filters: [{ field: 'section', op: 'gt', value: 3 }], search: 'x' },
        revision: 1,
      }),
    );
  });

  it('reads the view again when a save loses to someone else’s', async () => {
    views.push(view());
    client.updateSavedView.mockRejectedValueOnce(new ApiError(409, 'Saved by someone else'));
    setup('/content/article?view=v1&query=x');
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() => expect(client.listSavedViews).toHaveBeenCalledTimes(2));
    expect(search()).toContain('query=x');
  });

  it('leaves a type’s field columns out of a view over every type', async () => {
    views.push(view({ contentTypeApiId: null, columns: ['sys.status'] }));
    // Only the columns differ, and they can't be saved here: nothing to save over the view.
    setup('/content/article?view=v1&columns=sys.status,section');
    await open(/News.*edited/);
    expect(screen.queryByRole('menuitem', { name: 'Save changes to “News”' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Save as new view…' })).toBeTruthy();
    cleanup();

    // The query changed too: that is saved, and the list keeps showing the columns picked.
    setup('/content/article?view=v1&columns=sys.status,section&query=x');
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        query: { search: 'x' },
        revision: 1,
      }),
    );
    await waitFor(() => expect(search()).toContain('columns=sys.status,section'));
    cleanup();

    // Columns that all fit are saved like any others.
    setup('/content/article?view=v1&columns=sys.updatedAt');
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenLastCalledWith(
        'v1',
        expect.objectContaining({ columns: ['sys.updatedAt'] }),
      ),
    );
  });

  it('offers Stop sharing to the view’s creator alone', async () => {
    views.push(
      view({ visibility: 'shared' }),
      view({ id: 'v2', name: 'Theirs', createdBy: 'lead', visibility: 'shared' }),
    );
    setup('/content/article?view=v2');
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    await open(/^View:\s*Theirs/);
    expect(await screen.findByRole('menuitem', { name: 'Rename…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Stop sharing' })).toBeNull();
    cleanup();

    setup('/content/article?view=v1');
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    await open(/^View:\s*News/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop sharing' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        visibility: 'personal',
        revision: 1,
      }),
    );
  });

  it('renames, shares and deletes the open view', async () => {
    views.push(view());
    setup('/content/article?view=v1');
    await open(/^View:\s*News/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with the space' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        visibility: 'shared',
        revision: 1,
      }),
    );
    await screen.findByText('“News” is shared with everyone in the space');

    await open(/^View:\s*News/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Newsroom' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByText('Renamed to “Newsroom”');

    await open(/^View:\s*Newsroom/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Newsroom”?' });
    expect(confirm.textContent).toContain('Everyone in the space loses this view');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(client.deleteSavedView).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(search()).not.toContain('view='));
  });
});

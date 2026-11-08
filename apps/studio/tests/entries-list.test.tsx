// @vitest-environment jsdom
import type { ContentType } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryListQuery, EntryPage, PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom has no layout, so it has no scrollIntoView; every real browser does.
Element.prototype.scrollIntoView ??= () => {};

type ListPage = (type?: string, query?: EntryListQuery, cursor?: string) => Promise<EntryPage>;
const client = {
  listEntryPage: vi.fn<ListPage>(),
  contentTypeEntryCounts: vi.fn(async (): Promise<{ contentType: string; total: number }[]> => []),
  trashEntry: vi.fn(async () => {}),
  restoreEntry: vi.fn(async () => {}),
  publishEntry: vi.fn<(id: string) => Promise<unknown>>(async () => ({})),
  diffVersions: vi.fn(async (entryId: string) => ({
    entryId,
    contentType: 'article',
    from: 1,
    to: 2,
    changes: [
      {
        field: 'title',
        name: 'Title',
        fieldType: 'Symbol',
        kind: 'changed',
        locales: [{ locale: 'en-US', kind: 'changed', before: 'Pricing', after: 'Pricing page' }],
      },
    ],
  })),
  unpublishEntry: vi.fn<(id: string) => Promise<unknown>>(async () => ({})),
  bulkEntryAction: vi.fn(async (_action: string, ids: string[]) => ({
    succeeded: ids.length,
    failed: 0,
    results: ids.map((id) => ({ id, ok: true })),
  })),
  purgeEntry: vi.fn(async () => {}),
  duplicateEntry: vi.fn(),
  startEntryBulkJob: vi.fn(async (action: string, ids: string[]) =>
    jobOf(action, { totalItems: ids.length, succeeded: ids.length }),
  ),
  getBulkJob: vi.fn(async (_id: string) => jobOf('restore', {})),
  getBulkJobReport: vi.fn(async (_id: string) => ({
    job: jobOf('purge', {}),
    chunks: [] as { failures: { id: string; error: string }[] }[],
  })),
  cancelBulkJob: vi.fn(),
  getSpaceAccess: vi.fn(async () => fullAccess),
  listSavedViews: vi.fn(async () => []),
};

/** The session's access in the space: an unrestricted publisher unless a test says otherwise. */
const fullAccess = {
  spaceId: 's1',
  kind: 'web',
  scopes: ['content:write', 'content:publish'],
  restricted: false,
  bulkJobs: ['publish', 'unpublish', 'trash', 'restore', 'purge'] as string[],
};

/** A bulk job as the API reports it: one batch, finished unless said otherwise. */
function jobOf(action: string, over: Record<string, unknown>) {
  return {
    id: 'job-1',
    action,
    status: 'completed',
    totalItems: 2,
    totalChunks: 1,
    completedChunks: 1,
    succeeded: 2,
    failed: 0,
    ...over,
  } as never;
}
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    // Like the real runner: a failure is surfaced, never rethrown.
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
  useLocalRun: () => ({
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));

// The assistant, when a test stands one in: `edit` answers each page edit as the panel would (its
// output, or declined). Null by default: no shell here, so the page edits through the API itself.
const assistant = vi.hoisted(() => ({
  edit: null as null | ((tool: string, input: unknown, about?: string) => Promise<unknown>),
}));
vi.mock('~/cms/lib/assistant', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/cms/lib/assistant')>();
  return {
    ...real,
    useAssistantEdit: () => (tool: string, input: unknown, about?: string) =>
      assistant.edit ? assistant.edit(tool, input, about) : Promise.resolve(null),
  };
});

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntriesList } = await import('~/cms/routes/EntriesList');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  client.getSpaceAccess.mockImplementation(async () => fullAccess);
  assistant.edit = null;
});

const article: ContentType = {
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
  ],
} as ContentType;

const entry = (id: string, status: string, title: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  fields: { title: { 'en-US': title } },
});

const ENTRIES = [
  entry('e-live', 'published', 'About us'),
  entry('e-changed', 'changed', 'Pricing page'),
  entry('e-draft', 'draft', 'Spring launch'),
  entry('e-live2', 'published', 'Careers'),
];

function setup(list?: ListPage, type: ContentType = article) {
  if (list) client.listEntryPage.mockImplementation(list);
  else client.listEntryPage.mockResolvedValue({ items: ENTRIES });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [type], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/content/article']}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route path=":typeId" element={<EntriesList />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Radix menus open on pointerdown (left button, no modifiers).
/**
 * The first wait after rendering: on a CI runner the list's first render can take longer than
 * testing-library's default second (it failed at 1.5 s), so this one waits up to five.
 */
const FIRST_RENDER_MS = 5000;
/**
 * The tests that render a full page of rows (100, then 200) take about 0.4 s alone but up to 15 s
 * on a CI runner busy with every other package's tests, which is the default test timeout. They
 * get twice that, so they fail only when something is actually wrong.
 */
const FULL_PAGE_TEST_MS = 30_000;

async function rowMenu(title: string, item: string) {
  const trigger = await screen.findByRole(
    'button',
    { name: `More actions for ${title}` },
    { timeout: FIRST_RENDER_MS },
  );
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

const rowOf = (title: string) => {
  const row = screen.getByRole('link', { name: title }).closest('[role="row"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return row;
};

describe('EntriesList trash and Undo', () => {
  it('offers Import for an ordinary type and not for a singleton', async () => {
    setup();
    expect(
      await screen.findByRole('button', { name: 'Import' }, { timeout: FIRST_RENDER_MS }),
    ).toBeTruthy();
    cleanup();
    setup(undefined, { ...article, singleton: true });
    await screen.findByText('About us', undefined, { timeout: FIRST_RENDER_MS });
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('undoing the trash of a published entry restores and then republishes it', async () => {
    setup();
    await rowMenu('About us', 'Move to trash');
    await screen.findByText('“About us” unpublished and moved to the trash');
    expect(client.trashEntry).toHaveBeenCalledWith('e-live');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“About us” restored and live again');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-live');
    expect(client.publishEntry).toHaveBeenCalledWith('e-live');
    const restoreOrder = client.restoreEntry.mock.invocationCallOrder[0] ?? 0;
    const publishOrder = client.publishEntry.mock.invocationCallOrder[0] ?? 0;
    expect(restoreOrder).toBeLessThan(publishOrder);
  });

  it('undoing the trash of a changed entry restores it as a draft without publishing', async () => {
    setup();
    await rowMenu('Pricing page', 'Move to trash');
    await screen.findByText('“Pricing page” unpublished and moved to the trash');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“Pricing page” restored as a draft; publish it to put it back live');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-changed');
    expect(client.publishEntry).not.toHaveBeenCalled();
  });

  it('undoing the trash of a draft only restores it', async () => {
    setup();
    await rowMenu('Spring launch', 'Move to trash');
    await screen.findByText('“Spring launch” moved to the trash');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“Spring launch” restored');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-draft');
    expect(client.publishEntry).not.toHaveBeenCalled();
  });
});

describe('EntriesList unpublish and Undo', () => {
  it('Undo on a single-row unpublish republishes that entry', async () => {
    setup();
    await rowMenu('About us', 'Unpublish');
    await screen.findByText('“About us” unpublished');
    expect(client.unpublishEntry).toHaveBeenCalledWith('e-live');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“About us” is live again');
    expect(client.publishEntry).toHaveBeenCalledExactlyOnceWith('e-live');
  });

  const tick = async (title: string) =>
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select “${title}”` }));

  it('survives the content types arriving after it first draws', async () => {
    client.listEntryPage.mockResolvedValue({ items: ENTRIES });
    const base = { locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
    const queryClient = new QueryClient();
    const wrap = (outlet: object) => (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/content/article']}>
            <Routes>
              <Route path="/content" element={<Outlet context={outlet} />}>
                <Route path=":typeId" element={<EntriesList />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );
    const view = render(wrap({ ...base, types: [], typesPending: true }));
    view.rerender(wrap({ ...base, types: [article], typesPending: false }));
    expect(await screen.findByRole('button', { name: 'View trash' })).toBeTruthy();
  });

  it('backing out of a bulk ask hands focus back to the button that asked', async () => {
    setup();
    await tick('About us');
    await tick('Careers');
    const unpublish = screen.getByRole('button', { name: 'Unpublish selected' });
    fireEvent.click(unpublish);
    const ask = await screen.findByRole('alertdialog', { name: 'Unpublish 2 entries?' });
    // The ask opens from a settled promise, outside act: it takes focus as it is drawn, but its
    // Escape handler attaches in an effect after. Let that run, as it has by the time anyone can
    // press a key, so Escape never lands before it (it did on a loaded CI runner).
    await act(async () => {});
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(ask.isConnected).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Unpublish selected' }),
      ),
    );
    expect(client.bulkEntryAction).not.toHaveBeenCalled();
  });

  it('clearing the ticks answers a question asked in place', async () => {
    setup();
    await tick('About us');
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await screen.findByRole('alertdialog', { name: 'Move 1 entry to the trash?' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await tick('About us');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  const bulkUnpublish = async (titles: string[]) => {
    for (const t of titles) {
      fireEvent.click(await screen.findByRole('checkbox', { name: `Select “${t}”` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish selected' }));
    // Without the assistant (no shell here), the page confirms in its own dialog, once it knows.
    const dialog = await screen.findByRole('alertdialog', {
      name: `Unpublish ${titles.length} entries?`,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish entries' }));
  };

  it('offers Undo on a bulk unpublish of entries that were all live, republishing them', async () => {
    setup();
    await bulkUnpublish(['About us', 'Careers']);
    await screen.findByText('Unpublished 2 entries');
    expect(client.bulkEntryAction).toHaveBeenCalledWith('unpublish', ['e-live', 'e-live2']);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Republished 2 entries');
    expect(client.bulkEntryAction).toHaveBeenLastCalledWith('publish', ['e-live', 'e-live2']);
  });

  it('offers no Undo when the selection included an entry that was not live', async () => {
    setup();
    await bulkUnpublish(['About us', 'Pricing page']);
    await screen.findByText('Unpublished 2 entries');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('EntriesList row Publish', () => {
  it('confirms a draft before anything goes live, and offers no Undo after', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Spring launch”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Spring launch”?' });
    expect(client.publishEntry).not.toHaveBeenCalled();
    // A draft has nothing live to compare with, so nothing is read and nothing holds the button.
    expect(client.diffVersions).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entry' }));
    await screen.findByText('“Spring launch” published');
    expect(client.publishEntry).toHaveBeenCalledExactlyOnceWith('e-draft');
    // Readers and webhooks already have it: an Undo wouldn't call that back.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('keeps a draft as a draft when the confirmation is declined', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Spring launch”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Spring launch”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as draft' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.publishEntry).not.toHaveBeenCalled();
    expect(within(rowOf('Spring launch')).getByText('Draft')).toBeTruthy();
  });

  it('sends a draft to the assistant’s card too, with no dialog of its own', async () => {
    const edit = vi.fn(async () => ({ output: { id: 'e-draft', status: 'published' } }));
    assistant.edit = edit;
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Spring launch”' }));
    await screen.findByText('“Spring launch” published');
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      'entries_publish',
      expect.objectContaining({ id: 'e-draft' }),
      'Spring launch',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.publishEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('confirms a changed entry with what changes before anything goes live', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Pricing page”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Pricing page”?' });
    // The draft against the published version, as the editor's confirm and the card compare it.
    await within(dialog).findByText('1 field changed');
    expect(client.diffVersions).toHaveBeenCalledWith('e-changed', 'published', 'draft');
    expect(within(dialog).getByText('Pricing page')).toBeTruthy();
    expect(client.publishEntry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entry' }));
    await screen.findByText('“Pricing page” published');
    expect(client.publishEntry).toHaveBeenCalledExactlyOnceWith('e-changed');
    // Replacing a live version has no exact inverse, so there is no Undo to offer.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('keeps a changed entry as a draft when the confirmation is declined', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Pricing page”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Pricing page”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep live version' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.publishEntry).not.toHaveBeenCalled();
    expect(within(rowOf('Pricing page')).getByText('Changed')).toBeTruthy();
  });

  it('sends a changed entry to the assistant’s card, with no dialog of its own', async () => {
    const edit = vi.fn(async () => ({ output: { id: 'e-changed', status: 'published' } }));
    assistant.edit = edit;
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Pricing page”' }));
    await screen.findByText('“Pricing page” published');
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      'entries_publish',
      { id: 'e-changed', expectedVersion: 1 },
      'Pricing page',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.publishEntry).not.toHaveBeenCalled();
  });

  it('rolls a draft back and offers no Undo when its publish fails', async () => {
    setup();
    client.publishEntry.mockRejectedValueOnce(new Error('Validation failed'));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Spring launch”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Spring launch”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entry' }));
    await waitFor(() => expect(client.publishEntry).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(rowOf('Spring launch')).getByText('Draft')).toBeTruthy());
    expect(screen.queryByText('“Spring launch” published')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('EntriesList optimistic status', () => {
  it('rolls the status badge back when the change fails', async () => {
    setup();
    let reject: (e: Error) => void = () => {};
    client.unpublishEntry.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }),
    );
    await screen.findByRole('link', { name: 'About us' });
    // Any refetch hangs, so only the rollback can restore the badge.
    client.listEntryPage.mockImplementation(() => new Promise(() => {}));

    await rowMenu('About us', 'Unpublish');
    await waitFor(() => expect(within(rowOf('About us')).getByText('Draft')).toBeTruthy());

    reject(new Error('Server said no'));
    await waitFor(() => expect(within(rowOf('About us')).getByText('Published')).toBeTruthy());
    expect(within(rowOf('About us')).queryByText('Draft')).toBeNull();
    expect(screen.queryByText('“About us” unpublished')).toBeNull();
  });
});

describe('EntriesList through the assistant', () => {
  it('publishes a row through its card, held to the version it shows, and changes nothing through the API itself', async () => {
    const edit = vi.fn(async () => ({ output: { id: 'e-draft', status: 'published' } }));
    assistant.edit = edit;
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “Spring launch”' }));
    await screen.findByText('“Spring launch” published');
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      'entries_publish',
      { id: 'e-draft', expectedVersion: 1 },
      'Spring launch',
    );
    expect(client.publishEntry).not.toHaveBeenCalled();
  });

  it('leaves the row as it was when the card is declined', async () => {
    assistant.edit = vi.fn(async () => ({ declined: true }));
    setup();
    await rowMenu('About us', 'Move to trash');
    await waitFor(() => expect(assistant.edit).toHaveBeenCalledOnce());
    expect(assistant.edit).toHaveBeenCalledWith('entries_trash', { id: 'e-live' }, 'About us');
    expect(client.trashEntry).not.toHaveBeenCalled();
    expect(screen.queryByText(/moved to the trash/)).toBeNull();
  });

  it('sends a bulk change as one card, with no dialog of its own', async () => {
    const edit = vi.fn(async (_tool: string, input: unknown) => {
      const ids = (input as { ids: string[] }).ids;
      return {
        output: {
          total: ids.length,
          succeeded: ids.length,
          failed: 0,
          results: ids.map((id) => ({ id, ok: true })),
        },
      };
    });
    assistant.edit = edit;
    setup();
    for (const t of ['About us', 'Careers'])
      fireEvent.click(await screen.findByRole('checkbox', { name: `Select “${t}”` }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish selected' }));
    await screen.findByText('Unpublished 2 entries');
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      'entries_bulk_action',
      { action: 'unpublish', ids: ['e-live', 'e-live2'] },
      'Unpublish 2 entries',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.bulkEntryAction).not.toHaveBeenCalled();
  });

  it('duplicates at once and opens the copy', async () => {
    assistant.edit = vi.fn(async () => ({
      output: { entry: { id: 'e-copy', contentTypeApiId: 'article' } },
    }));
    setup();
    await rowMenu('About us', 'Duplicate');
    await screen.findByText('Entry duplicated');
    expect(assistant.edit).toHaveBeenCalledWith('entries_duplicate', { id: 'e-live' }, 'About us');
    expect(client.duplicateEntry).not.toHaveBeenCalled();
  });
});

describe('EntriesList counts and paging', () => {
  const page = (from: number, n = 100) =>
    Array.from({ length: n }, (_, i) => entry(`e${from + i}`, 'draft', `Entry ${from + i}`));

  it(
    "names the type's real total, and Load more appends the next page from its cursor",
    async () => {
      client.contentTypeEntryCounts.mockResolvedValue([{ contentType: 'article', total: 250 }]);
      setup(async (_type, _query, cursor) =>
        cursor === 'c2'
          ? { items: page(100), nextCursor: 'c3' }
          : { items: page(0), nextCursor: 'c2' },
      );
      await screen.findByText('Showing 100 of 250 entries', {}, { timeout: FIRST_RENDER_MS });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Entry 3”' }));
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('Showing 200 of 250 entries', {}, { timeout: FIRST_RENDER_MS });
      expect(client.listEntryPage).toHaveBeenLastCalledWith('article', expect.anything(), 'c2');
      // The first page stays, the second follows it, and the tick survives.
      expect(screen.getByRole('link', { name: 'Entry 0' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Entry 199' })).toBeTruthy();
      expect(
        screen.getByRole('checkbox', { name: 'Select “Entry 3”' }).getAttribute('aria-checked'),
      ).toBe('true');
    },
    FULL_PAGE_TEST_MS,
  );

  it('counts a list shorter than a page as it is, with no Load more', async () => {
    client.contentTypeEntryCounts.mockResolvedValue([]);
    setup();
    await screen.findByText('4 entries', {}, { timeout: FIRST_RENDER_MS });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it(
    'starts again from the first page on a search, and a miss keeps the headers',
    async () => {
      // A few rows and a cursor prove the restart; a full page only slows the render under load.
      setup(async (_type, query) =>
        query?.search ? { items: [] } : { items: page(0).slice(0, 5), nextCursor: 'c2' },
      );
      await screen.findByRole('link', { name: 'Entry 0' }, { timeout: FIRST_RENDER_MS });
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search entries' }), {
        target: { value: 'zzz' },
      });
      await screen.findByText('No entries match the current filters.', undefined, {
        timeout: FIRST_RENDER_MS,
      });
      expect(screen.getByRole('columnheader', { name: 'Title' })).toBeTruthy();
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ search: 'zzz' }),
        undefined,
      );
    },
    FULL_PAGE_TEST_MS,
  );
});

describe('EntriesList sorting from the headers', () => {
  it('asks for the column’s order, and Updated flips newest first and back to the default', async () => {
    setup();
    const header = await screen.findByRole(
      'button',
      { name: 'Title' },
      { timeout: FIRST_RENDER_MS },
    );
    fireEvent.click(header);
    await waitFor(() =>
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ order: [{ field: 'title', direction: 'asc' }] }),
        undefined,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    await waitFor(() =>
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ order: [{ field: 'sys.updatedAt', direction: 'desc' }] }),
        undefined,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    await waitFor(() => expect(client.listEntryPage.mock.lastCall?.[1]?.order).toBeUndefined());
  });
});

describe('EntriesList Mine filter', () => {
  it('lists only the signed-in person’s entries, and Clear brings everyone’s back', async () => {
    setup();
    const mine = await screen.findByRole('button', { name: 'Mine' }, { timeout: FIRST_RENDER_MS });
    expect(mine.getAttribute('aria-pressed')).toBe('false');
    // Off is an outline pill, on the ink fill; the words say what it does, so no tooltip.
    expect(mine.getAttribute('data-variant')).toBe('outline');
    expect(mine.hasAttribute('title')).toBe(false);
    fireEvent.click(mine);
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(mine.getAttribute('data-variant')).toBe('default');
    await waitFor(() =>
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ mine: true }),
        undefined,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(client.listEntryPage.mock.lastCall?.[1]?.mine).toBeUndefined());
    expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('EntriesList bulk bar', () => {
  const tick = async (t: string) =>
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Select “${t}”` }, { timeout: FIRST_RENDER_MS }),
    );

  it('replaces the filter bar while anything is ticked, says how many, and clears', async () => {
    setup();
    await tick('About us');
    const bar = screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'Search entries' })).toBeNull();
    expect(screen.getByText('1 entry selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('group', { name: 'Selected entries' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search entries' })).toBeTruthy();
  });

  it('offers only what applies: no Publish for live entries, no Unpublish for drafts', async () => {
    setup();
    await tick('About us');
    const bar = () => screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar()).queryByRole('button', { name: 'Publish selected' })).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Unpublish selected' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “About us”' }));
    await tick('Spring launch');
    expect(within(bar()).getByRole('button', { name: 'Publish selected' })).toBeTruthy();
    expect(within(bar()).queryByRole('button', { name: 'Unpublish selected' })).toBeNull();
  });

  it('names the entries in the confirm, and sends only those the action changes', async () => {
    setup();
    for (const t of ['About us', 'Spring launch', 'Pricing page']) await tick(t);
    fireEvent.click(screen.getByRole('button', { name: 'Publish selected' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish 2 entries?' });
    expect(within(dialog).getByText('Spring launch')).toBeTruthy();
    expect(within(dialog).getByText('Pricing page')).toBeTruthy();
    expect(within(dialog).queryByText('About us')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entries' }));
    await screen.findByText('Published 2 entries');
    expect(client.bulkEntryAction).toHaveBeenCalledWith('publish', ['e-draft', 'e-changed']);
  });

  it('counts past five names in the confirm', async () => {
    const many = Array.from({ length: 7 }, (_, i) => entry(`d${i}`, 'draft', `Draft ${i}`));
    setup(async () => ({ items: many }));
    await screen.findByRole('link', { name: 'Draft 0' }, { timeout: FIRST_RENDER_MS });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all entries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish selected' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish 7 entries?' });
    expect(within(dialog).getByText('Draft 4')).toBeTruthy();
    expect(within(dialog).queryByText('Draft 5')).toBeNull();
    expect(within(dialog).getByText('and 2 more')).toBeTruthy();
  });

  it('keeps the entries that failed ticked, and names them', async () => {
    client.bulkEntryAction.mockResolvedValueOnce({
      succeeded: 1,
      failed: 1,
      results: [
        { id: 'e-live', ok: true },
        { id: 'e-live2', ok: false, error: 'Locked by a release' },
      ],
    } as never);
    setup();
    for (const t of ['About us', 'Careers']) await tick(t);
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish selected' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unpublish 2 entries?' });
    // In place under the bar, naming what it changes, with the safe choice focused.
    expect(dialog.closest('[data-slot="alert-dialog-content"]')).toBeNull();
    expect(within(dialog).getByText('About us')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Keep as is' }),
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish entries' }));
    await screen.findByText('1 entry failed');
    expect(screen.getByText(/Locked by a release/)).toBeTruthy();
    const bar = screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'Select “Careers”' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByRole('checkbox', { name: 'Select “About us”' }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('leaves ticked only what a new order still shows', async () => {
    // Sorted, the first page holds two of the four: Careers is past it.
    setup(async (_type, query) => ({
      items: query?.order ? ENTRIES.filter((e) => e.id !== 'e-live2') : ENTRIES,
      ...(query?.order ? { nextCursor: 'c2' } : {}),
    }));
    await tick('About us');
    await tick('Careers');
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Careers' })).toBeNull());
    await screen.findByText('1 selected');
    expect(screen.getByText('1 entry selected')).toBeTruthy();
  });
});

describe('EntriesList trash jobs', () => {
  const tick = async (t: string) =>
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Select “${t}”` }, { timeout: FIRST_RENDER_MS }),
    );
  const TRASHED = [
    entry('t-1', 'archived', 'Old promo'),
    entry('t-2', 'archived', 'Draft FAQ'),
    entry('t-3', 'archived', 'Retired page'),
  ];
  // The list for the entries, and the trash for `trashed: true`.
  const withTrash: ListPage = async (_type, query) => ({
    items: query?.trashed ? TRASHED : ENTRIES,
  });
  const openTrash = async () => {
    fireEvent.click(
      await screen.findByRole('button', { name: 'View trash' }, { timeout: FIRST_RENDER_MS }),
    );
    await screen.findByText('Old promo', undefined, { timeout: FIRST_RENDER_MS });
  };

  it('moves the ticked entries to the trash as one job, once the batch is confirmed', async () => {
    setup();
    await tick('About us');
    await tick('Spring launch');
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Move 2 entries to the trash?',
    });
    expect(within(dialog).getByText(/unpublished first/)).toBeTruthy();
    expect(within(dialog).getByText('About us')).toBeTruthy();
    expect(dialog.closest('[data-slot="alert-dialog-content"]')).toBeNull();
    expect(client.startEntryBulkJob).not.toHaveBeenCalled();
    const before = client.listEntryPage.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
    await screen.findByText('Trashed 2 entries', { selector: '[role="status"]' });
    expect(client.startEntryBulkJob).toHaveBeenCalledExactlyOnceWith('trash', [
      'e-live',
      'e-draft',
    ]);
    // The list reloads as the job ends, and the selection goes with what moved.
    await waitFor(() => expect(client.listEntryPage.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole('group', { name: 'Selected entries' })).toBeNull();
  });

  it('disables the job actions, saying why, for a role limited to some content types', async () => {
    client.getSpaceAccess.mockImplementation(async () => ({
      ...fullAccess,
      restricted: true,
      bulkJobs: [],
    }));
    setup(withTrash);
    await tick('About us');
    const trash = screen.getByRole('button', { name: 'Move to trash' }) as HTMLButtonElement;
    await waitFor(() => expect(trash.disabled).toBe(true));
    expect(trash.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/allowed to do that to every content type/)).toBeTruthy();
    // Unpublishing doesn't run as a job, so it stays on offer.
    expect(
      (screen.getByRole('button', { name: 'Unpublish selected' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    await openTrash();
    await tick('Old promo');
    for (const name of ['Restore selected', 'Delete permanently…']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('enables the job actions for a member whose role may run them, one by one', async () => {
    // As the api answers for the Administrator preset: every entry job.
    setup(withTrash);
    await tick('About us');
    const trash = screen.getByRole('button', { name: 'Move to trash' }) as HTMLButtonElement;
    await waitFor(() => expect(trash.disabled).toBe(false));
    expect(trash.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    // A role that may restore but not delete (its `*` grant withholds delete).
    client.getSpaceAccess.mockImplementation(async () => ({
      ...fullAccess,
      restricted: true,
      bulkJobs: ['publish', 'unpublish', 'restore'],
    }));
    cleanup();
    setup(withTrash);
    await openTrash();
    await tick('Old promo');
    const purge = screen.getByRole('button', { name: 'Delete permanently…' }) as HTMLButtonElement;
    await waitFor(() => expect(purge.disabled).toBe(true));
    expect(
      (screen.getByRole('button', { name: 'Restore selected' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('offers Restore and Delete permanently for what is ticked in the trash', async () => {
    setup(withTrash);
    await openTrash();
    await tick('Old promo');
    const bar = screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar).getByRole('button', { name: 'Restore selected' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Delete permanently…' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: 'Move to trash' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Publish selected' })).toBeNull();
  });

  it(
    'restores at once as a job, follows it until it ends, then reloads the trash',
    async () => {
      client.startEntryBulkJob.mockResolvedValueOnce(
        jobOf('restore', { status: 'running', completedChunks: 0, succeeded: 0 }),
      );
      client.getBulkJob.mockResolvedValueOnce(jobOf('restore', {}));
      setup(withTrash);
      await openTrash();
      await tick('Old promo');
      await tick('Draft FAQ');
      fireEvent.click(screen.getByRole('button', { name: 'Restore selected' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      await screen.findByText('Restoring 2 entries…');
      expect(client.startEntryBulkJob).toHaveBeenCalledWith('restore', ['t-1', 't-2']);
      // While it runs, the bar waits.
      expect(screen.getByRole('button', { name: 'Restore selected' })).toHaveProperty(
        'disabled',
        true,
      );
      await screen.findByText(
        'Restored 2 entries',
        { selector: '[role="status"]' },
        { timeout: 5000 },
      );
      expect(client.getBulkJob).toHaveBeenCalledWith('job-1');
    },
    FULL_PAGE_TEST_MS,
  );

  it('deletes permanently only once confirmed by name, and names what was kept', async () => {
    client.startEntryBulkJob.mockResolvedValueOnce(
      jobOf('purge', { totalItems: 2, succeeded: 1, failed: 1 }),
    );
    client.getBulkJobReport.mockResolvedValueOnce({
      job: jobOf('purge', {}),
      chunks: [{ failures: [{ id: 't-3', error: '1 published entry links to this one' }] }],
    });
    setup(withTrash);
    await openTrash();
    await tick('Old promo');
    await tick('Retired page');
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Permanently delete 2 entries?' });
    expect(within(dialog).getByText(/can’t be undone/)).toBeTruthy();
    expect(within(dialog).getByText('Old promo')).toBeTruthy();
    expect(within(dialog).getByText('Retired page')).toBeTruthy();
    // Backing out deletes nothing and keeps the selection.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep in trash' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.startEntryBulkJob).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Permanently delete 2 entries?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await screen.findByText('1 entry failed');
    expect(client.startEntryBulkJob).toHaveBeenCalledExactlyOnceWith('purge', ['t-1', 't-3']);
    expect(screen.getByText(/1 published entry links to this one/)).toBeTruthy();
    // What was kept stays ticked, to try again once the links are gone.
    const bar = screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
  });

  it('sends Move to trash to the assistant as one job card, and follows the job it started', async () => {
    const edit = vi.fn(async (_tool: string, input: unknown) => {
      const { entryIds } = input as { entryIds: string[] };
      return { output: jobOf('trash', { totalItems: entryIds.length }) };
    });
    assistant.edit = edit;
    setup();
    await tick('About us');
    await tick('Careers');
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await screen.findByText('Trashed 2 entries', { selector: '[role="status"]' });
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      'bulk_job_start',
      { action: 'trash', entryIds: ['e-live', 'e-live2'] },
      'Move 2 entries to the trash',
    );
    // The card was the confirm: no dialog of the page's own, and nothing started a second time.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.startEntryBulkJob).not.toHaveBeenCalled();
  });

  it('sends Delete permanently to the assistant’s card, and does nothing when it is declined', async () => {
    const edit = vi.fn(async () => ({ declined: true }));
    assistant.edit = edit;
    setup(withTrash);
    await openTrash();
    await tick('Old promo');
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(
        'bulk_job_start',
        { action: 'purge', entryIds: ['t-1'] },
        'Permanently delete 1 entry',
      ),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Bulk job' })).toBeNull();
    expect(client.startEntryBulkJob).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('restores straight through the API even with the assistant there, and focuses Stop', async () => {
    const edit = vi.fn();
    assistant.edit = edit;
    client.startEntryBulkJob.mockResolvedValueOnce(
      jobOf('restore', { status: 'running', totalItems: 1, completedChunks: 0, succeeded: 0 }),
    );
    setup(withTrash);
    await openTrash();
    await tick('Old promo');
    const restore = screen.getByRole('button', { name: 'Restore selected' });
    // Enabled once the session's access has been read.
    await waitFor(() => expect(restore).toHaveProperty('disabled', false));
    restore.focus();
    fireEvent.click(restore);
    await screen.findByText('Restoring 1 entry…');
    expect(edit).not.toHaveBeenCalled();
    // The bar's button now waits: focus moved to the job's Stop, not the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' })),
    );
  });

  it('counts the failures it can’t name, and leaves ticked only what is still listed', async () => {
    const { ApiError } = await import('~/cms/lib/management');
    client.startEntryBulkJob.mockResolvedValueOnce(
      jobOf('purge', { totalItems: 2, succeeded: 1, failed: 1 }),
    );
    client.getBulkJobReport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    let purged = false;
    setup(async (_type, query) => ({
      items: query?.trashed ? TRASHED.filter((e) => !(purged && e.id === 't-1')) : ENTRIES,
    }));
    await openTrash();
    await tick('Old promo');
    await tick('Retired page');
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Permanently delete 2 entries?',
    });
    purged = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await screen.findByText('1 entry failed');
    expect(screen.getByText(/report couldn’t be read \(Forbidden\)/)).toBeTruthy();
    // Old promo went; Retired page, still listed, stays ticked to try again.
    await waitFor(() => expect(screen.queryByText('Old promo')).toBeNull());
    const bar = screen.getByRole('group', { name: 'Selected entries' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
  });
});

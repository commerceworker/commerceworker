// @vitest-environment jsdom
// The entry editor's Activity view: an entry's audit rows in words, what each save changed, and
// a row from before changes were recorded never read as "no changes"; loading, empty, failure and
// paging; and the view offered only to a space administrator, as the audit log is.
import type { ContentType, EntryChange } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuditLogPage, PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const client = {
  listEntryActivity:
    vi.fn<(id: string, q: { limit?: number; cursor?: string }) => Promise<AuditLogPage>>(),
  getSpaceAccess: vi.fn(async () => ({ subject: 'usr_me', scopes: ['space:admin'] })),
  getTeam: vi.fn(async () => ({
    people: [{ id: 'usr_ada', email: 'ada@example.com', name: 'Ada' }],
  })),
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAppExtensions: vi.fn(async () => []),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));
vi.mock('~/cms/components/CollaborationPanel', () => ({ CollaborationPanel: () => null }));
vi.mock('~/cms/components/EntryMetadataPanel', () => ({ EntryMetadataPanel: () => null }));
vi.mock('~/cms/components/VersionHistory', () => ({ VersionHistory: () => null }));
vi.mock('~/cms/components/ReferencedBy', () => ({ ReferencedBy: () => null }));
vi.mock('~/cms/components/SemanticPanel', () => ({ SemanticPanel: () => null }));
vi.mock('~/cms/components/AiAssistPanel', () => ({ AiAssistPanel: () => null }));

const { EntryActivity } = await import('~/cms/components/entries/EntryActivity');
const { activityAction } = await import('~/cms/lib/activity');
const { ToastProvider } = await import('~/cms/lib/toast');
const { EntryEditor } = await import('~/cms/routes/EntryEditor');

const ARTICLE = {
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
      localized: true,
      required: false,
      position: 0,
    },
    {
      apiId: 'hero',
      name: 'Hero',
      type: 'Component',
      localized: false,
      required: false,
      position: 1,
    },
  ],
} as ContentType;

const SCOPED = 'PUT /spaces/:space/environments/:env/entries/:id';
const change = (over: Partial<EntryChange> = {}): EntryChange => ({
  entryId: 'e1',
  contentType: 'article',
  kind: 'updated',
  version: 2,
  paths: ['fields.title', 'fields.hero.alt'],
  locales: ['de'],
  ...over,
});
const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `a${n}`,
  spaceId: 's',
  environmentId: 'main',
  actor: 'usr_ada',
  action: SCOPED,
  targetType: 'entry',
  targetId: 'e1',
  status: 200,
  at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function show() {
  render(
    <QueryClientProvider client={queryClient()}>
      <EntryActivity
        entryId="e1"
        contentType={ARTICLE}
        directory={{
          me: 'usr_me',
          people: [{ id: 'usr_ada', email: 'ada@example.com', name: 'Ada' }],
        }}
      />
    </QueryClientProvider>,
  );
}
const list = () => screen.getByRole('list', { name: 'Activity, newest first' });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the entry’s activity', () => {
  it('says what happened, who did it and what a save changed, in the model’s words', async () => {
    client.listEntryActivity.mockResolvedValue({
      items: [
        row(3, { action: 'MCP entries_publish', actor: 'usr_me' }),
        row(2, { detail: { entries: [change()] } }),
        row(1, {
          action: 'POST /spaces/:space/environments/:env/agent-reviews/:id/approve',
          targetType: 'agent_review',
          targetId: 'r1',
          actor: 'agent:enrich',
          detail: {
            entries: [change({ entryId: 'e9' }), change({ paths: ['fields.title'], locales: [] })],
          },
        }),
      ],
    });
    show();
    const items = within(
      await screen.findByRole('list', { name: 'Activity, newest first' }),
    ).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Published');
    expect(items[0]?.textContent).toContain('You · through MCP');
    expect(items[1]?.textContent).toContain('Saved');
    expect(items[1]?.textContent).toContain('Ada');
    expect(items[1]?.textContent).toContain('Title, Hero › alt in de');
    expect(items[2]?.textContent).toContain('Approved an agent’s proposal');
    expect(items[2]?.textContent).toContain('The enrich agent');
    expect(items[2]?.textContent).toContain('With 1 other entry');
    // Nothing here is an id.
    expect(list().textContent).not.toContain('usr_ada');
  });

  it('shows a row without detail with no list of changes, never as no changes', async () => {
    client.listEntryActivity.mockResolvedValue({ items: [row(1)] });
    show();
    const [item] = within(
      await screen.findByRole('list', { name: 'Activity, newest first' }),
    ).getAllByRole('listitem');
    expect(item?.textContent).toContain('Saved');
    expect(item?.textContent).not.toMatch(/No field changed|no changes/i);
  });

  it('says a save that changed nothing, when its detail says so', async () => {
    client.listEntryActivity.mockResolvedValue({
      items: [row(1, { detail: { entries: [change({ paths: [], locales: [] })] } })],
    });
    show();
    expect(await screen.findByText('No field changed')).toBeTruthy();
  });

  it('keeps an action it has no words for as recorded', async () => {
    client.listEntryActivity.mockResolvedValue({
      items: [row(1, { action: 'MCP something_new' })],
    });
    show();
    expect(await screen.findByText('MCP something_new')).toBeTruthy();
  });

  it('says when there is no activity yet', async () => {
    client.listEntryActivity.mockResolvedValue({ items: [] });
    show();
    expect(await screen.findByText('No activity recorded for this entry yet.')).toBeTruthy();
  });

  it('says a failed read as one, and tries again', async () => {
    client.listEntryActivity.mockRejectedValueOnce(new Error('space:admin required'));
    client.listEntryActivity.mockResolvedValueOnce({ items: [row(1)] });
    show();
    expect(await screen.findByText('The activity didn’t load')).toBeTruthy();
    expect(screen.queryByText('No activity recorded for this entry yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Activity, newest first' })).toBeTruthy();
  });

  it('loads more from the cursor and hands focus to the first row it brought', async () => {
    client.listEntryActivity.mockImplementation(async (_id, q) =>
      q.cursor === 'c1'
        ? { items: [row(3, { action: 'MCP entries_unpublish' })] }
        : {
            items: [row(1), row(2)],
            nextCursor: 'c1',
          },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(3));
    expect(client.listEntryActivity).toHaveBeenLastCalledWith('e1', { limit: 20, cursor: 'c1' });
    // The row itself takes focus, so it is read whole: what, who and when.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Unpublished'));
    expect(document.activeElement?.tagName).toBe('LI');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps the rows it has when the next page fails, and says so beside them', async () => {
    client.listEntryActivity.mockImplementation(async (_id, q) => {
      if (q.cursor) throw new Error('The api is down');
      return { items: [row(1), row(2)], nextCursor: 'c1' };
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('More activity didn’t load.');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the rows it has when a refresh fails, and says they may be out of date', async () => {
    client.listEntryActivity.mockResolvedValueOnce({ items: [row(1)] });
    client.listEntryActivity.mockRejectedValueOnce(new Error('The api is down'));
    show();
    await screen.findByRole('list', { name: 'Activity, newest first' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findByRole('alert')).textContent).toContain('may be out of date');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('The activity didn’t load')).toBeNull();
  });

  it('says when a row saved this entry but its part of the detail didn’t fit', async () => {
    client.listEntryActivity.mockResolvedValue({
      items: [
        row(2, {
          targetType: 'job',
          targetId: 'j1',
          detail: { entries: [change({ entryId: 'e9' })], truncated: true },
        }),
        row(1, { detail: { entries: [change({ paths: ['fields.title'] })], truncated: true } }),
      ],
    });
    show();
    const items = within(
      await screen.findByRole('list', { name: 'Activity, newest first' }),
    ).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Its changes to this entry aren’t listed');
    expect(items[1]?.textContent).toContain('Title in de');
    expect(items[1]?.textContent).toContain('Other changes not listed');
  });

  it('calls a duplicate’s row on the copy where it came from', () => {
    const duplicated = row(1, {
      action: 'POST /spaces/:space/environments/:env/entries/:id/duplicate',
      targetId: 'e-source',
    });
    expect(activityAction(duplicated, 'e-copy').words).toBe('Created as a copy');
    expect(activityAction(duplicated, 'e-source').words).toBe('Duplicated');
  });

  it('names a block patch the same through the API and a tool', () => {
    const viaApi = row(1, { action: 'PATCH /spaces/:space/environments/:env/entries/:id/blocks' });
    const viaTool = row(2, { action: 'MCP entry_blocks_patch' });
    expect(activityAction(viaApi, 'e1')).toEqual({ words: 'Changed blocks', viaMcp: false });
    expect(activityAction(viaTool, 'e1')).toEqual({ words: 'Changed blocks', viaMcp: true });
  });
});

describe('the Activity view in the editor', () => {
  function editor() {
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'article',
      status: 'draft',
      version: 2,
      fields: { title: { 'en-US': 'Pricing page' } },
    });
    client.listEntryActivity.mockResolvedValue({ items: [row(1)] });
    const outlet = { types: [ARTICLE], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
    const router = createMemoryRouter(
      [
        {
          path: '/content',
          element: <Outlet context={outlet} />,
          children: [{ path: ':typeId/:entryId', element: <EntryEditor /> }],
        },
      ],
      { initialEntries: ['/content/article/e1'] },
    );
    render(
      <QueryClientProvider client={queryClient()}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('is a third view of the side pane for a space administrator', async () => {
    editor();
    fireEvent.click(await screen.findByRole('radio', { name: 'Activity' }));
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(client.listEntryActivity).toHaveBeenCalledWith('e1', { limit: 20, cursor: undefined });
  });

  it('isn’t offered to anyone else, even when it was the view last picked', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({ subject: 'usr_me', scopes: ['content:write'] });
    localStorage.setItem('cw.entry-pane.view', 'activity');
    editor();
    await screen.findByRole('radio', { name: 'Details' });
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    // Its answer, not just its asking: until then nobody is offered Activity.
    await act(async () => {
      await client.getSpaceAccess.mock.results[0]?.value;
    });
    expect(screen.queryByRole('radio', { name: 'Activity' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Details' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(client.listEntryActivity).not.toHaveBeenCalled();
  });
});

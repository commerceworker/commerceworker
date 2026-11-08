// @vitest-environment jsdom
import type { ContentType } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const client = {
  listReleases: vi.fn(),
  listScheduledActions: vi.fn(async () => []),
  getRelease: vi.fn(),
  getEntry: vi.fn(),
  listContentTypes: vi.fn(),
  listEntries: vi.fn(async () => []),
  publishRelease: vi.fn(async () => ({})),
  deleteRelease: vi.fn(async () => {}),
  listWorkflows: vi.fn(async () => [
    { id: 'wf-1', name: 'Editorial', steps: [{ id: 'st-1', name: 'Draft', requiredScope: 'x' }] },
  ]),
  listWorkflowGraphs: vi.fn(async () => [
    {
      id: 'wf-1',
      name: 'Editorial',
      description: '',
      contentTypes: [],
      gatesPublish: false,
      publishGated: false,
      graph: { nodes: [], edges: [] },
      steps: [],
      latestVersion: 1,
      legacy: false,
      updatedAt: null,
      publishedTrigger: null,
      startsAlongside: [],
    },
  ]),
  deleteWorkflow: vi.fn(async () => {}),
  listSchemes: vi.fn(async () => [{ id: 'sc-1', name: 'Topics' }]),
  listConcepts: vi.fn(async () => []),
  deleteScheme: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listAIActions: vi.fn(async () => [
    {
      id: 'ai-1',
      name: 'Shorten',
      promptTemplate: 'Shorten this',
      variables: [],
      tier: 'fast',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]),
  deleteAIAction: vi.fn(async () => {}),
  listComments: vi.fn(async () => [
    {
      id: 'c-1',
      entryId: 'e-1',
      parentId: null,
      author: 'Ada',
      body: 'Looks good',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]),
  deleteComment: vi.fn(async () => {}),
  listTasks: vi.fn(async () => []),
  getEntryWorkflowState: vi.fn(async () => null),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
  useLocalRun: () => ({ busy: false, run: (fn: () => Promise<void>) => fn() }),
}));

const { ApiError } = await import('~/cms/lib/management');
const { ConfirmDialog } = await import('~/cms/components/ConfirmDialog');
const { ConfirmButton, InlineConfirm } = await import('~/cms/components/InlineConfirm');
const { ToastProvider, useToast } = await import('~/cms/lib/toast');
const { Releases } = await import('~/cms/routes/Releases');
const { ReleasePublishConfirm } = await import('~/cms/components/ReleasePublishConfirm');
const { Workflows } = await import('~/cms/routes/Workflows');
const { Taxonomy } = await import('~/cms/routes/Taxonomy');
const { AiActions } = await import('~/cms/components/AiActions');
const { CollaborationPanel } = await import('~/cms/components/CollaborationPanel');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConfirmDialog', () => {
  function Harness(props: { onConfirm: () => void }) {
    return (
      <ConfirmDialog
        message="Delete “Spring”?"
        note="This can’t be undone."
        cancelLabel="Keep it"
        confirmLabel="Delete release"
        onConfirm={props.onConfirm}
      >
        {(ask) => (
          <button type="button" onClick={ask}>
            Delete
          </button>
        )}
      </ConfirmDialog>
    );
  }

  it('asks in a modal, focusing the safe choice, and only acts on the named action', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Spring”?' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it' })),
    );
    const confirm = within(dialog).getByRole('button', { name: 'Delete release' });
    expect(confirm.className).toContain('destructive');
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('backs out on Escape and returns focus to the trigger', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Delete' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('alertdialog');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog holding for its answer', () => {
  function Held(props: { onConfirm: () => Promise<unknown> }) {
    return (
      <ConfirmDialog
        message="Delete “Spring”?"
        note="This can’t be undone."
        confirmLabel="Delete release"
        onConfirm={props.onConfirm}
      >
        {(ask) => (
          <button type="button" onClick={ask}>
            Delete
          </button>
        )}
      </ConfirmDialog>
    );
  }
  const open = async (onConfirm: () => Promise<unknown>) => {
    render(<Held onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    return screen.findByRole('alertdialog');
  };

  it('sends once, and waits with no way out until the answer', async () => {
    let answer = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    const dialog = await open(onConfirm);
    const confirm = within(dialog).getByRole('button', { name: 'Delete release' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByRole('status').textContent).toContain('closes when it’s done');

    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBe(dialog);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('says a refusal in the dialog and lets the person out', async () => {
    const dialog = await open(() => Promise.reject(new ApiError(409, 'It is in use')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete release' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('It is in use');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel.hasAttribute('disabled')).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('after no answer, stops offering to keep anything, and a refused retry doesn’t undo that', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'DELETE → 503'))
      .mockRejectedValueOnce(new ApiError(404, 'DELETE → 404'));
    const dialog = await open(onConfirm);
    const confirm = within(dialog).getByRole('button', { name: 'Delete release' });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'may still have gone through',
    );
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();

    fireEvent.click(confirm);
    await within(dialog).findByText(/This try was refused/);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('lets go of an answer that never comes, without saying nothing happened', async () => {
    const dialog = await open(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete release' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(within(dialog).getByRole('alert').textContent).toContain('may still have gone through');
    expect(within(dialog).getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('InlineConfirm', () => {
  function Harness(props: { onConfirm: () => void }) {
    return (
      <ConfirmButton
        message="Delete “Spring”?"
        note="This can’t be undone."
        confirmLabel="Delete release"
        onConfirm={props.onConfirm}
      >
        {(ask) => (
          <button type="button" onClick={ask}>
            Delete
          </button>
        )}
      </ConfirmButton>
    );
  }

  it('asks in place, focusing the safe choice, and only acts on the named action', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Spring”?' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete release' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('backs out on Escape and returns focus to the trigger it replaced', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Delete' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('cancels only the newest confirm and keeps Escape from reaching an enclosing sheet', () => {
    const outerEscape = vi.fn();
    document.addEventListener('keydown', outerEscape);
    function Two() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <>
          {a && (
            <InlineConfirm message="First?" onCancel={() => setA(false)}>
              <button type="button">Do first</button>
            </InlineConfirm>
          )}
          {b && (
            <InlineConfirm message="Second?" onCancel={() => setB(false)}>
              <button type="button">Do second</button>
            </InlineConfirm>
          )}
        </>
      );
    }
    render(<Two />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: 'Second?' })).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'First?' })).toBeTruthy();
    expect(outerEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outerEscape);
  });
});

describe('toast actions', () => {
  it('offers an action that runs once and dismisses the toast', () => {
    const undo = vi.fn();
    function Probe() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            toast.success('“Hello” moved to the trash', {
              action: { label: 'Undo', onAction: undo },
            })
          }
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    // The action lives inside the polite live region with its message.
    const message = screen.getByText('“Hello” moved to the trash');
    expect(message.closest('[aria-live="polite"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('“Hello” moved to the trash')).toBeNull();
  });
});

describe('Releases destructive actions', () => {
  const article: ContentType = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [],
  };
  const release = {
    id: 'rel-1',
    title: 'Spring campaign',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const entry = (id: string, title: string, status: string) => ({
    id,
    contentType: 'article',
    status,
    version: 1,
    fields: { title: { 'en-US': title } },
  });

  /** Answers the batched by-id lookup (`sys.id[in]`) with the entries that still exist. */
  const entriesById =
    (...existing: ReturnType<typeof entry>[]) =>
    async (_type?: string, query?: { filters?: { field: string; value: unknown }[] }) => {
      const ids = query?.filters?.find((f) => f.field === 'sys.id')?.value;
      return Array.isArray(ids) ? existing.filter((e) => ids.includes(e.id)) : existing;
    };

  function setup() {
    client.listReleases.mockResolvedValue([{ ...release, itemCount: 3 }]);
    client.listContentTypes.mockResolvedValue([article]);
    // e-3 is gone (deleted, or hidden from this principal).
    client.listEntries.mockImplementation(
      entriesById(
        entry('e-1', 'Hello world', 'changed'),
        entry('e-2', 'Brand new', 'draft'),
      ) as never,
    );
    client.getRelease.mockResolvedValue({
      release,
      items: [
        { entityType: 'Entry', entityId: 'e-1', action: 'publish' },
        { entityType: 'Entry', entityId: 'e-2', action: 'publish' },
        { entityType: 'Entry', entityId: 'e-3', action: 'unpublish' },
      ],
    });
    client.getEntry.mockImplementation(async (id: string) => {
      if (id === 'e-1') return entry('e-1', 'Hello world', 'changed');
      if (id === 'e-2') return entry('e-2', 'Brand new', 'draft');
      throw new Error('Not found');
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Releases />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('lists each release with its entry count, and publishes only from inside it', async () => {
    setup();
    const row = (await screen.findByRole('button', { name: 'Spring campaign' })).closest('li');
    if (!row) throw new Error('no row');
    expect(await within(row).findByText('3')).toBeTruthy();
    // The count rides on the list; no release is fetched just to count its members.
    expect(client.getRelease).not.toHaveBeenCalled();
    // Looking is the row's path; nothing on it ships the release.
    expect(within(row).queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('shows when a scheduled release goes out, and reads as scheduled', async () => {
    client.listScheduledActions.mockResolvedValueOnce([
      {
        id: 'sa-1',
        action: 'publish',
        entityType: 'Release',
        entityId: 'rel-1',
        scheduledFor: '2026-11-07T14:00:00.000Z',
        status: 'pending',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ] as never);
    setup();
    const row = (await screen.findByRole('button', { name: 'Spring campaign' })).closest('li');
    if (!row) throw new Error('no row');
    const when = within(row).getByText(/Nov 7, 2026/);
    expect(when.closest('time')?.getAttribute('dateTime')).toBe('2026-11-07T14:00:00.000Z');
    expect(within(row).getByText('Scheduled')).toBeTruthy();
  });

  it('names a release’s entries by title inside it, linked, never by id', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Spring campaign' }));
    const sheet = await screen.findByRole('dialog');
    const hello = await within(sheet).findByRole('link', { name: 'Hello world' });
    expect(hello.getAttribute('href')).toBe('/content/article/e-1');
    expect(within(sheet).getByRole('link', { name: 'Brand new' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Remove “Hello world” from the release' }));
    // A member the lookup can't return is said to be gone, not shown as its id.
    expect(await within(sheet).findByText('Entry no longer available')).toBeTruthy();
    expect(within(sheet).queryByText(/e-[123]/)).toBeNull();
  });

  it('names scheduled entries by title, linked, never by id', async () => {
    client.listScheduledActions.mockResolvedValueOnce([
      {
        id: 'sa-1',
        action: 'publish',
        entityType: 'Entry',
        entityId: 'e-1',
        scheduledFor: '2026-11-07T14:00:00.000Z',
        status: 'pending',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'sa-2',
        action: 'unpublish',
        entityType: 'Entry',
        entityId: 'e-3',
        scheduledFor: '2026-11-08T14:00:00.000Z',
        status: 'pending',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ] as never);
    setup();
    const tab = await screen.findByRole('tab', { name: /Scheduled/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    const table = await screen.findByRole('list', { name: 'Scheduled publishes' });
    const hello = await within(table).findByRole('link', { name: 'Hello world' });
    expect(hello.getAttribute('href')).toBe('/content/article/e-1');
    expect(await within(table).findByText('Entry no longer available')).toBeTruthy();
    expect(within(table).queryByText(/e-[13]/)).toBeNull();
  });

  it('confirms a publish from the release with the member titles and flags before shipping', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Spring campaign' }));
    const publishNow = await screen.findByRole('button', { name: 'Publish now…' });
    await waitFor(() => expect((publishNow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(publishNow);

    const dialog = screen.getByRole('alertdialog', { name: 'Publish “Spring campaign”?' });
    // It can't be undone, so it is a modal, and the safe choice has focus.
    expect(dialog.getAttribute('data-slot')).toBe('alert-dialog-content');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })),
    );
    expect(client.publishRelease).not.toHaveBeenCalled();
    expect(await within(dialog).findByText('Hello world')).toBeTruthy();
    expect(await within(dialog).findByText('Brand new')).toBeTruthy();
    expect(within(dialog).getByText('unpublish')).toBeTruthy();
    expect(await within(dialog).findByText('missing')).toBeTruthy();
    expect(within(dialog).getByText('1 entry has never been published.')).toBeTruthy();
    expect(within(dialog).getByText(/in the trash or missing/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish 3 entries' }));
    await waitFor(() => expect(client.publishRelease).toHaveBeenCalledWith('rel-1'));
  });

  it('confirms a release delete by name; cancelling sends nothing', async () => {
    setup();
    const trigger = await screen.findByRole('button', { name: 'Delete “Spring campaign”' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Spring campaign”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.deleteRelease).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete release' }));
    await waitFor(() => expect(client.deleteRelease).toHaveBeenCalledWith('rel-1'));
  });
});

describe('permanent deletes', () => {
  const modal = [
    {
      name: 'Workflows route',
      ui: () => (
        <MemoryRouter>
          <Workflows />
        </MemoryRouter>
      ),
      trigger: 'Delete “Editorial”',
      dialog: 'Delete “Editorial”?',
      confirm: 'Delete workflow',
      call: () => client.deleteWorkflow,
      arg: 'wf-1',
    },
    {
      name: 'Taxonomy scheme',
      ui: () => <Taxonomy />,
      trigger: 'Delete “Topics”',
      dialog: 'Delete “Topics”?',
      confirm: 'Delete scheme',
      call: () => client.deleteScheme,
      arg: 'sc-1',
    },
  ];
  const inPlace = [
    {
      name: 'AI action',
      ui: () => <AiActions client={client as unknown as ManagementClient} />,
      trigger: 'Delete',
      dialog: 'Delete “Shorten”?',
      confirm: 'Delete action',
      call: () => client.deleteAIAction,
      arg: 'ai-1',
    },
    {
      name: 'collaboration comment',
      ui: () => <CollaborationPanel entryId="e-1" />,
      trigger: 'Delete comment by Ada',
      dialog: 'Delete this comment?',
      confirm: 'Delete comment',
      call: () => client.deleteComment,
      arg: 'c-1',
    },
  ];

  it.each(modal)(
    'what reaches content asks in a modal and sends nothing until confirmed ($name)',
    async ({ ui, trigger, dialog, confirm, call, arg }) => {
      renderWithProviders(ui());
      const button = await screen.findByRole('button', { name: trigger });
      button.focus();
      fireEvent.click(button);
      const ask = await screen.findByRole('alertdialog', { name: dialog });
      expect(ask.closest('[data-slot="alert-dialog-content"]')).toBe(ask);
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(button));
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(button);
      fireEvent.click(await screen.findByRole('button', { name: confirm }));
      await waitFor(() => expect(call()).toHaveBeenCalledExactlyOnceWith(arg));
    },
  );

  it.each(inPlace)(
    'a small config row asks in place and sends nothing until confirmed ($name)',
    async ({ ui, trigger, dialog, confirm, call, arg }) => {
      renderWithProviders(ui());
      fireEvent.click(await screen.findByRole('button', { name: trigger }));
      expect(screen.getByRole('alertdialog', { name: dialog })).toBeTruthy();
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: trigger }));
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: trigger }));
      fireEvent.click(screen.getByRole('button', { name: confirm }));
      await waitFor(() => expect(call()).toHaveBeenCalledExactlyOnceWith(arg));
    },
  );
});

describe('Release publish confirm', () => {
  const release = {
    id: 'rel-1',
    title: 'Spring campaign',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('keeps the publish button disabled while members load and for an empty release', async () => {
    client.listContentTypes.mockResolvedValue([]);
    let resolveDetail: (v: unknown) => void = () => {};
    client.getRelease.mockImplementation(
      () =>
        new Promise((r) => {
          resolveDetail = r;
        }),
    );
    renderWithProviders(
      <ReleasePublishConfirm
        releaseId="rel-1"
        releaseTitle="Spring campaign"
        busy={false}
        onCancel={() => {}}
        onConfirm={() => void client.publishRelease()}
      />,
    );

    const dialog = screen.getByRole('alertdialog', { name: 'Publish “Spring campaign”?' });
    expect(within(dialog).getByText('Checking its entries…')).toBeTruthy();
    const publish = () => within(dialog).getByRole('button', { name: 'Publish' });
    expect((publish() as HTMLButtonElement).disabled).toBe(true);

    resolveDetail({ release, items: [] });
    expect(
      await within(dialog).findByText('It has no entries yet, so there is nothing to ship.'),
    ).toBeTruthy();
    expect((publish() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(publish());
    expect(client.publishRelease).not.toHaveBeenCalled();
  });

  it('filters to archived releases, which no other status shows', async () => {
    client.listReleases.mockResolvedValue([
      { ...release, itemCount: 1 },
      { ...release, id: 'rel-2', title: 'Old launch', status: 'archived', itemCount: 2 },
    ]);
    client.listContentTypes.mockResolvedValue([]);
    renderWithProviders(
      <MemoryRouter>
        <Releases />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Old launch' });
    fireEvent.click(screen.getByRole('radio', { name: 'Open' }));
    expect(screen.queryByRole('button', { name: 'Old launch' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }));
    expect(screen.getByRole('button', { name: 'Old launch' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Spring campaign' })).toBeNull();
  });

  it('offers no publish inside an empty release', async () => {
    client.listReleases.mockResolvedValue([{ ...release, itemCount: 0 }]);
    client.listContentTypes.mockResolvedValue([]);
    client.getRelease.mockResolvedValue({ release, items: [] });
    renderWithProviders(
      <MemoryRouter>
        <Releases />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Spring campaign' }));
    const publishNow = await screen.findByRole('button', { name: 'Publish now…' });
    expect(await screen.findByText('0 entries · Open')).toBeTruthy();
    expect((publishNow as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('running an AI action', () => {
  it('can be left while the model hangs, and a late answer is dropped', async () => {
    let answer: (r: { output: string }) => void = () => {};
    const runAIAction = vi.fn(
      (_id: string, _input: unknown, _signal: AbortSignal) =>
        new Promise<{ output: string }>((resolve) => {
          answer = resolve;
        }),
    );
    const hanging = {
      listAIActions: async () => [
        {
          id: 'ai-2',
          name: 'Translate',
          promptTemplate: 'Into {{language}}',
          variables: ['language'],
          tier: 'fast',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      runAIAction,
    };
    renderWithProviders(<AiActions client={hanging as unknown as ManagementClient} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run action' }));
    await within(dialog).findByRole('button', { name: 'Running…' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(runAIAction.mock.calls[0]?.[2].aborted).toBe(true);
    answer({ output: 'Too late' });
    await Promise.resolve();
    expect(screen.queryByText('Too late')).toBeNull();
  });
});

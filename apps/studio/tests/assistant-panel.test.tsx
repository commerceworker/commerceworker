// @vitest-environment jsdom
// The assistant panel with its agent stood in for: a page's edits sent as one `act` each (a line at
// once, or a card the page waits on), cards answered through `resolve`, the page making the edit
// itself while the socket is down; and the parts a card and an edit line are drawn with.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = { space: 'sp_1', environment: 'main', locale: 'en-US' };
let conn = home;
const client = vi.hoisted(() => ({
  diffVersions: vi.fn<(id: string, from: unknown, to: unknown) => Promise<unknown>>(),
  getEntry: vi.fn<(id: string) => Promise<unknown>>(),
  listContentTypes: vi.fn(async () => [] as unknown[]),
  listEntries: vi.fn(async () => [] as unknown[]),
  getAsset: vi.fn<(id: string) => Promise<unknown>>(),
  listTags: vi.fn(async () => [] as unknown[]),
  getRelease: vi.fn<(id: string) => Promise<unknown>>(),
  listStarters: vi.fn(async () => [] as unknown[]),
  getBlocksOutline: vi.fn<(id: string) => Promise<unknown>>(),
  checkBlockPatch: vi.fn<(id: string, patch: unknown) => Promise<unknown>>(),
}));
let scopeState: 'loading' | 'no-spaces' | 'error' | 'ready' = 'ready';
let admin = true;
const updateConn = vi.fn();
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn, client, updateConn }),
  useScopeState: () => scopeState,
}));
vi.mock('~/lib/use-me', () => ({
  useMe: () => ({ kind: 'user', id: 'usr_1', role: 'admin' }),
  useCan: () => admin,
}));

type Handlers = {
  onOpen?: () => void;
  onClose?: (e?: { code: number }) => void;
  name?: string;
  agent?: string;
};
const socket = vi.hoisted(() => ({
  options: {} as Handlers,
  call: vi.fn<(method: string, args?: unknown[]) => Promise<unknown>>(),
  close: vi.fn(),
}));
vi.mock('agents/react', () => ({
  useAgent: (options: Handlers) => {
    socket.options = options;
    return socket;
  },
}));

const chat = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  addToolApprovalResponse: vi.fn(),
  body: undefined as undefined | (() => unknown),
}));
vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: (options: { body?: () => unknown }) => {
    chat.body = options.body;
    return {
      messages: chat.messages,
      sendMessage: vi.fn(),
      regenerate: vi.fn(),
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
      clearError: vi.fn(),
      addToolApprovalResponse: chat.addToolApprovalResponse,
      clearHistory: vi.fn(),
      isStreaming: false,
      isRecovering: false,
    };
  },
}));

const { AssistantProvider, useAssistantEdit } = await import('~/cms/lib/assistant');
const { AssistantPanel } = await import('~/cms/components/assistant/panel');
const { ActionCard, EditLine, ReadLine, entryHref, turnErrorText, whenLabel } = await import(
  '~/cms/components/assistant/parts'
);
const { ApiError } = await import('~/cms/lib/management');

type Edit = ReturnType<typeof useAssistantEdit>;
let edit!: Edit;
function Page() {
  edit = useAssistantEdit();
  return null;
}

const queries = new QueryClient();
const tree = () => (
  <QueryClientProvider client={queries}>
    <MemoryRouter>
      <AssistantProvider>
        <Page />
        <AssistantPanel />
      </AssistantProvider>
    </MemoryRouter>
  </QueryClientProvider>
);
/** Renders the panel; `sync()` re-renders it with the conversation as `chat.messages` now holds. */
const renderPanel = () => {
  const view = render(tree());
  return { sync: () => view.rerender(tree()) };
};

/** A diff of the entry: its title changed, its body didn't. */
const diff = {
  entryId: 'e1',
  contentType: 'article',
  from: 1,
  to: 2,
  changes: [
    {
      field: 'title',
      name: 'Title',
      fieldType: 'Symbol',
      kind: 'changed',
      locales: [{ locale: 'en-US', kind: 'changed', before: 'Old', after: 'New' }],
    },
    {
      field: 'body',
      name: 'Body',
      fieldType: 'Text',
      kind: 'unchanged',
      locales: [{ locale: 'en-US', kind: 'unchanged', before: 'Same', after: 'Same' }],
    },
  ],
};

const card = (over: Record<string, unknown> = {}) =>
  ({
    type: 'tool-entries_publish',
    toolCallId: 'direct_1',
    state: 'approval-requested',
    input: { id: 'e1', space: 'sp_1', environment: 'main' },
    approval: { id: 'direct_1' },
    toolMetadata: { direct: true, about: 'Spring launch notes' },
    ...over,
  }) as never;

beforeEach(() => {
  chat.messages = [];
  socket.call.mockReset();
  chat.addToolApprovalResponse.mockReset();
  client.diffVersions.mockReset().mockResolvedValue(diff);
  client.getEntry.mockReset();
  conn = home;
  scopeState = 'ready';
  admin = true;
  updateConn.mockReset();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('first run with no space yet', () => {
  const inRouter = (ui: React.ReactNode) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  /** A space Coworker created, its card confirmed and run. */
  const createdTurn = (spaceId: string, starter: string) =>
    ({
      id: 'm_created',
      role: 'assistant',
      parts: [
        {
          type: 'tool-space_create',
          toolCallId: 'call_space',
          state: 'output-available',
          input: { name: 'Field guide', spaceId, defaultLocale: 'en-US', starter },
          output: { id: spaceId },
        },
      ],
    }) as unknown as UIMessage;

  it('asks a deployment admin what the first space will hold, and sets it up with no space', () => {
    scopeState = 'no-spaces';
    renderPanel();
    expect(screen.getByText('What will your first space hold?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'An empty space to model my own' })).toBeTruthy();
    expect(screen.queryByText('What’s waiting to be published?')).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Message Coworker' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    // There is no page to ask about, and the turn runs in setup, not in a space.
    expect(screen.queryByRole('button', { name: /Asking about/ })).toBeNull();
    expect(chat.body!()).toEqual({
      context: { scope: { spaceId: '*', environmentId: '*' }, page: { kind: 'everything' } },
    });
  });

  it('tells someone who can’t set one up who can add them, and takes no question', () => {
    scopeState = 'no-spaces';
    admin = false;
    renderPanel();
    expect(screen.getByText('You aren’t on a space yet.')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Message Coworker' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((chat.body!() as { context: { scope: unknown } }).context.scope).toMatchObject({
      spaceId: 'sp_1',
    });
  });

  it('moves into the space it created, once the list has it, then offers what to try there', async () => {
    scopeState = 'no-spaces';
    const { sync } = renderPanel();
    chat.messages = [createdTurn('field-guide', 'empty')];
    sync();
    await waitFor(() =>
      expect(updateConn).toHaveBeenCalledWith({ space: 'field-guide', environment: 'main' }),
    );
    scopeState = 'ready';
    sync();
    expect(
      screen.getByRole('button', { name: 'How do I model my first content type?' }),
    ).toBeTruthy();
  });

  it('doesn’t move into a space created before the panel opened', () => {
    scopeState = 'no-spaces';
    chat.messages = [createdTurn('gone', 'sample')];
    renderPanel();
    expect(updateConn).not.toHaveBeenCalled();
  });

  it('offers the usual ideas once a space exists', () => {
    renderPanel();
    expect(screen.getByText('What’s waiting to be published?')).toBeTruthy();
    expect(screen.queryByText('What will your first space hold?')).toBeNull();
  });

  it('shows what the space will be on its card, from the call’s own input', async () => {
    inRouter(
      <ActionCard
        part={
          {
            type: 'tool-space_create',
            toolCallId: 'call_1',
            state: 'approval-requested',
            input: {
              name: 'Field guide',
              spaceId: 'field-guide',
              defaultLocale: 'en-US',
              starter: 'sample',
            },
            approval: { id: 'call_1' },
          } as never
        }
        respond={vi.fn()}
        actionKey="m1:0"
        direct={false}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Create this space' })).toBeTruthy();
    expect(screen.getByText('field-guide')).toBeTruthy();
    // Named as the New space form names it, from the deployment's own list.
    expect(await screen.findByText('Start with sample content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });
});

describe('a page’s edits through the panel', () => {
  it('connects to the person’s own agent', () => {
    renderPanel();
    expect(socket.options).toMatchObject({ agent: 'assistant-agent', name: 'usr_1' });
  });

  it('sends an instant edit as one act, with the scope and page, and hands the page its output', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    const view = { entry: { id: 'e1', contentTypeApiId: 'article' }, fields: {} };
    socket.call.mockResolvedValueOnce({ callId: 'direct_9', output: view });
    let saved!: Promise<unknown>;
    act(() => {
      saved = edit('entries_update', { id: 'e1', fields: {} }, 'Spring launch notes');
    });
    await expect(saved).resolves.toEqual({ output: view });
    expect(socket.call).toHaveBeenCalledExactlyOnceWith('act', [
      'entries_update',
      { space: 'sp_1', environment: 'main', id: 'e1', fields: {} },
      {
        scope: { spaceId: 'sp_1', environmentId: 'main', locale: 'en-US' },
        page: { kind: 'everything' },
      },
      'Spring launch notes',
    ]);
    // An instant edit leaves the panel as it was.
    expect(screen.getByRole('complementary', { name: 'Coworker' }).hasAttribute('inert')).toBe(
      true,
    );
  });

  it('opens at an action’s card, and the page waits until it is confirmed', async () => {
    const { sync } = renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    let publishing!: Promise<unknown>;
    act(() => {
      publishing = edit('entries_publish', { id: 'e1' }, 'Spring launch notes');
    });
    const panel = screen.getByRole('complementary', { name: 'Coworker' });
    await waitFor(() => expect(panel.hasAttribute('inert')).toBe(false));

    let settled = false;
    void publishing.then(() => {
      settled = true;
    });
    // The card the agent wrote into the conversation arrives with the next sync.
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
    sync();
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(within(panel).getByRole('heading', { name: 'Publish this entry' })).toBeTruthy();
    expect(within(panel).getByText('Spring launch notes')).toBeTruthy();
    // The card a page asked for takes focus on its safe choice.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
    expect(settled).toBe(false);

    const agg = { id: 'e1', contentTypeApiId: 'article', publishedVersion: 4 };
    socket.call.mockResolvedValueOnce({ output: agg });
    fireEvent.click(confirm);
    await expect(publishing).resolves.toEqual({ output: agg });
    expect(socket.call).toHaveBeenLastCalledWith('resolve', ['direct_1', true]);
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it('leaves everything as it was when the card is declined', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
    let trashing!: Promise<unknown>;
    act(() => {
      trashing = edit('entries_publish', { id: 'e1' }, 'Spring launch notes');
    });
    socket.call.mockResolvedValueOnce({ done: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await expect(trashing).resolves.toEqual({ declined: true });
    expect(socket.call).toHaveBeenLastCalledWith('resolve', ['direct_1', false]);
  });

  it('settles the waiting page when its card was answered somewhere else', async () => {
    const { sync } = renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    let publishing!: Promise<unknown>;
    act(() => {
      publishing = edit('entries_publish', { id: 'e1' });
    });
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Coworker' }).hasAttribute('inert')).toBe(
        false,
      ),
    );
    // Confirmed on the phone: the conversation syncs the card's outcome.
    const output = { id: 'e1', contentTypeApiId: 'article' };
    chat.messages = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          card({ state: 'output-available', output, approval: { id: 'direct_1', approved: true } }),
        ],
      },
    ];
    sync();
    await expect(publishing).resolves.toEqual({ output });
  });

  it('answers a card the model proposed through the AI SDK, not resolve', async () => {
    client.getEntry.mockResolvedValue({ id: 'e1', status: 'changed', fields: {} });
    chat.messages = [
      {
        id: 'm1',
        role: 'assistant',
        metadata: { scope: { spaceId: 'sp_1', environmentId: 'main' } },
        parts: [card({ toolCallId: 'call_7', approval: { id: 'ap_7' }, toolMetadata: undefined })],
      },
    ];
    renderPanel();
    act(() => socket.options.onOpen?.());
    await screen.findByText('1 field goes live:');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(chat.addToolApprovalResponse).toHaveBeenCalledExactlyOnceWith({
      id: 'ap_7',
      approved: true,
    });
    expect(socket.call).not.toHaveBeenCalled();
  });

  it('hands the edit back to the page while the socket is down, and says so quietly', async () => {
    renderPanel();
    act(() => socket.options.onClose?.());
    await expect(edit('entries_publish', { id: 'e1' })).resolves.toBeNull();
    expect(socket.call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Can’t reach Coworker right now/)).toBeTruthy();
  });

  it('stops reconnecting and asks for a reload once the sign-in has ended', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    act(() => socket.options.onClose?.({ code: 4401 }));
    expect(socket.close).toHaveBeenCalled();
    expect(await screen.findByText(/Your sign-in has ended. Reload the page/)).toBeTruthy();
    // A later ordinary close (the socket shutting) doesn't turn it back into "trying again".
    act(() => socket.options.onClose?.({ code: 1006 }));
    expect(screen.queryByText(/trying again/)).toBeNull();
    await expect(edit('entries_publish', { id: 'e1' })).resolves.toBeNull();
  });

  it('passes a refusal on to the page', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockRejectedValueOnce(new Error('You can’t publish in this space'));
    await expect(edit('entries_publish', { id: 'e1' })).rejects.toThrow(
      'You can’t publish in this space',
    );
  });
});

describe('a card', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('names the action and what it is about, and answers Confirm or Not now once', async () => {
    const respond = vi.fn();
    inRouter(<ActionCard part={card()} respond={respond} actionKey="m1:0" direct />);
    await screen.findByText('1 field goes live:');
    const region = screen.getByRole('region', { name: 'Publish this entry' });
    expect(within(region).getByText('Spring launch notes')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Confirm' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.anything(), true);
    expect(
      (within(region).getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says what a batch does to how many entries when the page gave no label', () => {
    inRouter(
      <ActionCard
        part={card({
          type: 'tool-entries_bulk_action',
          input: { action: 'publish', ids: ['a', 'b', 'c'] },
          toolMetadata: undefined,
        })}
        respond={vi.fn()}
        actionKey="m1:0"
        direct={false}
      />,
    );
    expect(screen.getByText('Change these entries')).toBeTruthy();
    expect(screen.getByText('Publish 3 entries')).toBeTruthy();
  });

  it('says what a bulk job does to how many entries, and marks a removal destructive', () => {
    const job = (action: string, n: number) =>
      card({
        type: 'tool-bulk_job_start',
        input: { action, entryIds: Array.from({ length: n }, (_, i) => `e${i}`) },
        toolMetadata: undefined,
      });
    const confirmOf = (action: string, n: number, about: string) => {
      const view = inRouter(
        <ActionCard part={job(action, n)} respond={vi.fn()} actionKey="m1:0" direct={false} />,
      );
      const region = screen.getByRole('region', { name: 'Run a job on these entries' });
      expect(within(region).getByText(about)).toBeTruthy();
      const variant = within(region)
        .getByRole('button', { name: 'Confirm' })
        .getAttribute('data-variant');
      view.unmount();
      return variant;
    };
    // A model's proposal to delete 500 entries says so, and its confirm reads as a removal.
    expect(confirmOf('purge', 500, 'Permanently delete 500 entries')).toBe('destructive');
    expect(confirmOf('trash', 12, 'Move 12 entries to the trash')).toBe('destructive');
    expect(confirmOf('unpublish', 1, 'Unpublish 1 entry')).toBe('destructive');
    expect(confirmOf('restore', 3, 'Restore 3 entries from the trash')).toBe('default');
    expect(confirmOf('publish', 2, 'Publish 2 entries')).toBe('default');
  });

  it('stops asking once a newer identical request replaced it', () => {
    inRouter(<ActionCard part={card()} respond={vi.fn()} actionKey="m1:0" direct replaced />);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByText(/replaced by the newer request/)).toBeTruthy();
  });

  it('says in the past tense what stayed as it was once declined', () => {
    inRouter(
      <ActionCard
        part={card({ state: 'output-denied', approval: { id: 'direct_1', approved: false } })}
        respond={vi.fn()}
        actionKey="m1:0"
        direct
      />,
    );
    expect(screen.getByText('Not published · Spring launch notes')).toBeTruthy();
  });
});

describe('a publish card', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
  const confirm = () => screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
  const show = (part = card()) =>
    inRouter(<ActionCard part={part} respond={vi.fn()} actionKey="m1:0" direct />);

  it('lists the changed fields from the version diff, and reviews them in full', async () => {
    show();
    await screen.findByText('1 field goes live:');
    expect(client.diffVersions).toHaveBeenCalledExactlyOnceWith('e1', 'published', 'draft');
    const list = screen.getByRole('list', { name: 'Changed fields' });
    expect(within(list).getByText('Title')).toBeTruthy();
    expect(within(list).queryByText('Body')).toBeNull();

    expect(screen.queryByText('Old')).toBeNull();
    const review = screen.getByRole('button', { name: 'Review changes' });
    fireEvent.click(review);
    expect(review.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    // Unchanged fields stay out of the way there too.
    expect(screen.queryByText('Same')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 unchanged field' }));
    expect(screen.getByText('Same')).toBeTruthy();
  });

  it('reads the version the card is held to, not whatever the draft has become', async () => {
    show(card({ input: { id: 'e1', expectedVersion: 7, space: 'sp_1', environment: 'main' } }));
    await screen.findByText('1 field goes live:');
    expect(client.diffVersions).toHaveBeenCalledExactlyOnceWith('e1', 'published', 7);
  });

  it('shows the system’s fields, whatever a model put in its proposal', async () => {
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'article',
      status: 'changed',
      fields: {},
    });
    inRouter(
      <ActionCard
        part={card({
          toolCallId: 'call_1',
          toolMetadata: undefined,
          input: {
            id: 'e1',
            summary: 'Only a typo fix',
            changes: [{ field: 'Pricing', kind: 'changed' }],
          },
        })}
        respond={vi.fn()}
        actionKey="m1:0"
        direct={false}
        turn={{ spaceId: 'sp_1', environmentId: 'main' }}
      />,
    );
    await screen.findByText('1 field goes live:');
    expect(screen.getByRole('list', { name: 'Changed fields' }).textContent).toBe('TitleChanged');
    expect(screen.queryByText(/typo/)).toBeNull();
    expect(screen.queryByText('Pricing')).toBeNull();
    // A proposal has no page to name its entry: the entry does.
    expect(client.getEntry).toHaveBeenCalledWith('e1');
    expect(screen.getByText('Untitled entry')).toBeTruthy();
  });

  it('waits for the diff before it can be confirmed; Not now never waits', async () => {
    let arrive = (_: unknown) => {};
    client.diffVersions.mockReturnValue(new Promise((r) => (arrive = r)));
    show();
    expect(screen.getByText('Comparing with what’s live…')).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => arrive(diff));
    expect(confirm().disabled).toBe(false);
  });

  const reason = 'You can’t confirm until this can show what goes live.';
  /** Confirm is off, says why in words a screen reader is pointed at, and Not now still answers. */
  const expectBlocked = () => {
    const button = confirm();
    expect(button.disabled).toBe(true);
    const why = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe(reason);
    expect(why?.getAttribute('role')).toBe('status');
    expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  };

  it('won’t confirm after a failed read, and Not now still answers', async () => {
    client.diffVersions.mockRejectedValue(new Error('down'));
    const respond = vi.fn();
    inRouter(<ActionCard part={card()} respond={respond} actionKey="m1:0" direct />);
    await screen.findByText('Couldn’t load what changed');
    expectBlocked();
    expect(screen.queryByRole('list', { name: 'Changed fields' })).toBeNull();
    fireEvent.click(confirm());
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.anything(), false);
  });

  it('reads again on Try again, keeps focus on Not now, and confirms once it can show', async () => {
    client.diffVersions.mockRejectedValueOnce(new Error('down'));
    show();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
    await screen.findByText('1 field goes live:');
    expect(client.diffVersions).toHaveBeenCalledTimes(2);
    expect(confirm().disabled).toBe(false);
    expect(confirm().getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('stays off when trying again fails too, and offers it again', async () => {
    client.diffVersions.mockRejectedValue(new Error('down'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.diffVersions).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Try again' });
    expectBlocked();
  });

  it('says a first publish puts the whole entry live', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(404, 'EntryVersion not found'));
    client.getEntry.mockResolvedValue({ id: 'e1', status: 'draft', fields: {} });
    show();
    await screen.findByText(
      'This entry hasn’t been published before, so the whole entry goes live.',
    );
  });

  it('claims nothing about an entry that can’t be read', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(404, 'Entry not found'));
    client.getEntry.mockRejectedValue(new ApiError(404, 'Entry not found'));
    show();
    await screen.findByText('Couldn’t load what changed');
    expect(screen.queryByText(/whole entry goes live/)).toBeNull();
  });

  it('says when nothing would change', async () => {
    client.diffVersions.mockResolvedValue({ ...diff, changes: [diff.changes[1]] });
    show();
    await screen.findByText('The draft matches the published version; publishing re-confirms it.');
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
  });

  it('never says nothing changed while a field the person can’t read did', async () => {
    client.diffVersions.mockResolvedValue({
      ...diff,
      changes: [diff.changes[1]],
      hiddenChanges: 1,
    });
    show();
    await screen.findByText('1 field you can’t read goes live.');
    expect(screen.queryByText(/draft matches/)).toBeNull();
  });

  it('adds what the person can’t read to what they can', async () => {
    client.diffVersions.mockResolvedValue({ ...diff, hiddenChanges: 2 });
    show();
    await screen.findByText('2 fields you can’t read also go live.');
    expect(screen.getByRole('list', { name: 'Changed fields' }).textContent).toBe('TitleChanged');
  });

  it('reads nothing from the wrong environment: an id there can be another entry', async () => {
    show(card({ input: { id: 'e1', space: 'sp_1', environment: 'staging' } }));
    await screen.findByText(/another space or environment/);
    expect(client.diffVersions).not.toHaveBeenCalled();
    expectBlocked();
  });

  it('reads and confirms as normal once the person switches back', async () => {
    const elsewhere = card({ input: { id: 'e1', space: 'sp_1', environment: 'main' } });
    conn = { ...home, environment: 'staging' };
    const tree = () => (
      <MemoryRouter>
        <ActionCard part={elsewhere} respond={vi.fn()} actionKey="m1:0" direct />
      </MemoryRouter>
    );
    const view = render(tree());
    await screen.findByText(/Switch back/);
    expectBlocked();
    conn = home;
    view.rerender(tree());
    await screen.findByText('1 field goes live:');
    expect(confirm().disabled).toBe(false);
  });

  it('hands focus to Not now when Confirm turns off under it', async () => {
    const part = card();
    const tree = () => (
      <MemoryRouter>
        <ActionCard part={part} respond={vi.fn()} actionKey="m1:0" direct />
      </MemoryRouter>
    );
    const view = render(tree());
    await screen.findByText('1 field goes live:');
    confirm().focus();
    conn = { ...home, environment: 'staging' };
    view.rerender(tree());
    await screen.findByText(/Switch back/);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
  });

  it('confirms a first publish and a publish that changes nothing, as ever', async () => {
    client.diffVersions.mockRejectedValueOnce(new ApiError(404, 'EntryVersion not found'));
    client.getEntry.mockResolvedValue({ id: 'e1', status: 'draft', fields: {} });
    const first = show();
    await screen.findByText(/whole entry goes live/);
    expect(confirm().disabled).toBe(false);
    first.unmount();
    client.diffVersions.mockResolvedValue({ ...diff, changes: [diff.changes[1]] });
    show();
    await screen.findByText(/draft matches/);
    expect(confirm().disabled).toBe(false);
  });

  it.each([
    [
      'ran elsewhere',
      { spaceId: 'sp_1', environmentId: 'staging' },
      /another space or environment/,
    ],
    ['can’t say where it ran', undefined, /Choose Not now, then ask again/],
  ])(
    'reads nothing for a model’s card whose turn %s, whatever its input says',
    async (_, turn, says) => {
      inRouter(
        <ActionCard
          part={card({
            toolCallId: 'call_1',
            toolMetadata: undefined,
            input: { id: 'e1', space: 'sp_1', environment: 'main' },
          })}
          respond={vi.fn()}
          actionKey="m1:0"
          direct={false}
          {...(turn ? { turn } : {})}
        />,
      );
      await screen.findByText(says);
      expect(client.diffVersions).not.toHaveBeenCalled();
      expectBlocked();
    },
  );

  it.each([
    ['entries_unpublish', { id: 'e1' }],
    ['entries_trash', { id: 'e1' }],
    ['entries_restore_version', { id: 'e1', version: 2 }],
    ['entries_bulk_action', { action: 'publish', ids: ['e1', 'e2'] }],
    ['bulk_job_start', { action: 'publish', entryIds: ['e1', 'e2'] }],
  ])('keeps %s as it was: no list, nothing read', (tool, input) => {
    show(card({ type: `tool-${tool}`, input }));
    expect(screen.queryByRole('list', { name: 'Changed fields' })).toBeNull();
    expect(client.diffVersions).not.toHaveBeenCalled();
    expect(confirm().disabled).toBe(false);
  });
});

describe('a card’s focus', () => {
  const answered = card({
    state: 'output-denied',
    approval: { id: 'direct_1', approved: false },
  });
  const Frame = (props: { part: unknown }) => (
    <MemoryRouter>
      <div data-testid="card">
        <ActionCard part={props.part as never} respond={vi.fn()} actionKey="m1:0" direct />
      </div>
    </MemoryRouter>
  );

  it.each(['Not now', 'Confirm'])('keeps focus on the card when %s is pressed', async (name) => {
    const view = render(<Frame part={card()} />);
    await screen.findByText('1 field goes live:');
    fireEvent.click(screen.getByRole('button', { name }));
    const holder = screen.getByTestId('card').firstElementChild;
    await waitFor(() => expect(document.activeElement).toBe(holder));
    // The answer lands: the buttons go, and focus stays with the line that replaces them.
    view.rerender(<Frame part={answered} />);
    expect(screen.getByText(/Not published/)).toBeTruthy();
    expect(document.activeElement).toBe(holder);
  });

  it('keeps focus when the card is answered somewhere else', async () => {
    const view = render(<Frame part={card()} />);
    await screen.findByText('1 field goes live:');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
    view.rerender(<Frame part={answered} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('card').firstElementChild),
    );
  });

  it('leaves focus alone when it was elsewhere on the page', async () => {
    const view = render(
      <>
        <input aria-label="Somewhere else" />
        <Frame part={card()} />
      </>,
    );
    await screen.findByText('1 field goes live:');
    const field = screen.getByRole('textbox', { name: 'Somewhere else' });
    field.focus();
    view.rerender(
      <>
        <input aria-label="Somewhere else" />
        <Frame part={answered} />
      </>,
    );
    expect(document.activeElement).toBe(field);
  });

  it('takes focus on a cold open only once the panel has opened', async () => {
    // The card's message beats the page's answer: it is in the conversation, in an inert panel.
    socket.call.mockImplementation(async (method) => {
      if (method !== 'act') return {};
      chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
      view.sync();
      expect(document.activeElement).not.toBe(screen.queryByRole('button', { name: 'Not now' }));
      return { callId: 'direct_1', waiting: true };
    });
    const view = renderPanel();
    act(() => socket.options.onOpen?.());
    await act(async () => {
      void edit('entries_publish', { id: 'e1' }, 'Spring launch notes');
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
  });

  it('brings the waiting card back on the safe choice, past its Review changes', async () => {
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
    renderPanel();
    const review = await screen.findByRole('button', { name: 'Review changes' });
    review.focus();
    fireEvent.click(screen.getByRole('button', { name: /Waiting for you/ }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })),
    );
  });
});

describe('an edit line', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('says what was done and to what, linking to the entry it changed', () => {
    inRouter(
      <EditLine
        part={card({
          state: 'output-available',
          output: { id: 'e1', contentTypeApiId: 'article', publishedVersion: 2 },
          approval: { id: 'direct_1', approved: true },
        })}
      />,
    );
    const link = screen.getByRole('link', { name: 'Published · Spring launch notes' });
    expect(link.getAttribute('href')).toBe('/content/article/e1');
  });

  it('links a saved draft through its view, and an edit without an entry not at all', () => {
    expect(entryHref({ entry: { id: 'e 2', contentTypeApiId: 'news' }, fields: {} })).toBe(
      '/content/news/e%202',
    );
    expect(entryHref({ total: 3, succeeded: 3, failed: 0, results: [] })).toBeNull();
    inRouter(
      <EditLine
        part={card({
          type: 'tool-entries_bulk_action',
          state: 'output-available',
          input: { action: 'publish', ids: ['a', 'b'] },
          output: { total: 2, succeeded: 2, failed: 0, results: [] },
          toolMetadata: { direct: true, about: 'Publish 2 entries' },
        })}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Changed entries')).toBeTruthy();
  });

  it('says why an edit didn’t go through', () => {
    inRouter(
      <EditLine
        part={card({
          state: 'output-error',
          errorText: 'Publish blocked by moderation',
          approval: { id: 'direct_1', approved: true },
        })}
      />,
    );
    expect(screen.getByText(/didn’t go through/)).toBeTruthy();
    expect(screen.getByText('Publish blocked by moderation')).toBeTruthy();
  });
});

describe('a model’s proposal', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
  const here = { spaceId: 'sp_1', environmentId: 'main' };
  const article = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      { apiId: 'title', name: 'Title', type: 'Symbol', position: 0 },
      { apiId: 'body', name: 'Body', type: 'Text', position: 1 },
    ],
  };
  const proposal = (type: string, input: Record<string, unknown>) =>
    ({
      type: `tool-${type}`,
      toolCallId: 'call_1',
      state: 'approval-requested',
      input,
      approval: { id: 'call_1' },
    }) as never;
  const confirm = () => screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
  const show = (part: never, turn: unknown = here) =>
    inRouter(
      <ActionCard
        part={part}
        respond={vi.fn()}
        actionKey="m1:0"
        direct={false}
        turn={turn as never}
      />,
    );

  beforeEach(() => {
    client.listContentTypes.mockReset().mockResolvedValue([article]);
    client.listEntries.mockReset().mockResolvedValue([]);
    client.listTags.mockReset().mockResolvedValue([]);
    client.getRelease.mockReset();
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'article',
      status: 'draft',
      version: 3,
      fields: { title: { 'en-US': 'Old' }, body: { 'en-US': 'Same' } },
    });
  });

  it('says Coworker suggested it, and a page’s card that the person asked', async () => {
    show(proposal('entries_update', { id: 'e1', fields: {} }));
    expect(screen.getByText('Coworker suggests this')).toBeTruthy();
    cleanup();
    inRouter(<ActionCard part={card()} respond={vi.fn()} actionKey="m1:0" direct />);
    expect(screen.getByText('You asked for this on the page')).toBeTruthy();
  });

  it('shows a draft save as the change from what the draft holds now, and holds Confirm until then', async () => {
    show(
      proposal('entries_update', {
        id: 'e1',
        fields: { title: { 'en-US': 'New' }, body: { 'en-US': 'Same' } },
      }),
    );
    expect(confirm().disabled).toBe(true);
    await screen.findByText('1 field changes in the draft:');
    // Named by the entry's own title, read from the system.
    expect(screen.getByText('Old')).toBeTruthy();
    expect(confirm().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Now')).toBeTruthy();
    expect(within(changes).getByText('After saving')).toBeTruthy();
    expect(within(changes).getByText('New')).toBeTruthy();
  });

  it('counts a field a save leaves out as removed: the save is the whole new version', async () => {
    show(proposal('entries_update', { id: 'e1', fields: { title: { 'en-US': 'Old' } } }));
    await screen.findByText('1 field changes in the draft:');
    const list = screen.getByRole('list', { name: 'Changed fields' });
    expect(within(list).getByText('Body')).toBeTruthy();
  });

  it('names a batch’s first entries and counts the rest, before a removal can be confirmed', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `e${i}`);
    client.listEntries.mockResolvedValue(
      ids.slice(0, 5).map((id) => ({
        id,
        contentType: 'article',
        status: 'draft',
        version: 1,
        fields: { title: { 'en-US': `Story ${id}` } },
      })),
    );
    show(proposal('bulk_job_start', { action: 'purge', entryIds: ids }));
    expect(screen.getByText('Permanently delete 8 entries')).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    await screen.findByText('Story e0');
    expect(screen.getByText('Story e4')).toBeTruthy();
    expect(screen.queryByText('Story e5')).toBeNull();
    expect(screen.getByText('and 3 more')).toBeTruthy();
    expect(confirm().disabled).toBe(false);
    expect(confirm().getAttribute('data-variant')).toBe('destructive');
  });

  it('won’t confirm what it can’t read, and Try again reads it again', async () => {
    client.getEntry.mockReset().mockRejectedValueOnce(new Error('down'));
    show(proposal('entries_trash', { id: 'e1' }));
    await screen.findByRole('button', { name: 'Try again' });
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('You can’t confirm until this can show what changes.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'article',
      status: 'draft',
      version: 1,
      fields: { title: { 'en-US': 'Spring notes' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Spring notes');
    expect(confirm().disabled).toBe(false);
  });

  it('reads nothing for a proposal made in another environment', () => {
    show(proposal('entries_update', { id: 'e1', fields: {} }), {
      spaceId: 'sp_1',
      environmentId: 'staging',
    });
    expect(screen.getByText(/Switch back to see what changes/)).toBeTruthy();
    expect(client.getEntry).not.toHaveBeenCalled();
    expect(confirm().disabled).toBe(true);
  });

  it('names the tags a tagging would add, and the ones it would make', async () => {
    client.listTags.mockResolvedValue([{ id: 't1', name: 'Launch' }]);
    show(proposal('entry_apply_tags', { id: 'e1', tagIds: ['t1'], newTags: ['Spring'] }));
    await screen.findByText('Launch');
    expect(screen.getByText('Spring')).toBeTruthy();
    expect(confirm().disabled).toBe(false);
  });

  it('names the release an entry would join', async () => {
    client.getRelease.mockResolvedValue({ release: { id: 'r1', title: 'May launch' }, items: [] });
    show(proposal('releases_add_entry', { releaseId: 'r1', entryId: 'e1' }));
    await screen.findByText('May launch');
    expect(screen.getByText(/Publishes with/)).toBeTruthy();
  });
});

describe('a model’s block patch', () => {
  const here = { spaceId: 'sp_1', environmentId: 'main' };
  const symbol = (apiId: string, name: string) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position: 0,
  });
  const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 'Heading')] };
  const cta = { apiId: 'cta', name: 'Call to action', fields: [symbol('label', 'Label')] };
  const blocks = (apiId: string, name: string, variants: unknown[], position = 1) => ({
    apiId,
    name,
    type: 'Array',
    localized: false,
    required: false,
    position,
    items: { type: 'Component', variants },
  });
  const section = {
    apiId: 'section',
    name: 'Section',
    fields: [symbol('title', 'Title'), blocks('items', 'Items', [hero, cta])],
  };
  const page = {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      symbol('title', 'Title'),
      { ...blocks('body', 'Body', [hero, cta, section]), localized: true },
      blocks('notes', 'Notes', [cta], 2),
    ],
  };
  const heroBlock = { _type: 'hero', _key: 'k-hero', heading: 'Welcome' };
  const ctaBlock = { _type: 'cta', _key: 'k-cta', label: 'Sign up' };
  const sectionBlock = { _type: 'section', _key: 'k-sec', title: 'Features', items: [] };
  const fields = {
    title: { 'en-US': 'Home' },
    body: {
      'en-US': [heroBlock, ctaBlock, sectionBlock],
      de: [{ ...ctaBlock, label: 'Anmelden' }],
    },
  };
  const outline = (readable = ['body', 'notes']) => ({
    entryId: 'e1',
    version: 3,
    fields: Object.fromEntries(readable.map((f) => [f, {}])),
  });
  /** The dry run's answer: the fields as the save would store them, and the patch as applied. */
  const checked = (body: Record<string, unknown[]>, applied: unknown[]) => ({
    valid: true,
    contentTypeApiId: 'page',
    fields: { ...fields, body },
    applied,
    keys: {},
  });
  const unprocessable = (issues: unknown[]) =>
    new ApiError(422, 'One or more fields are invalid', {
      error: { code: 'validation_failed', issues },
    });
  const forbidden = (details?: Record<string, unknown>) =>
    new ApiError(403, 'Missing required scope "content:write:page"', {
      error: { code: 'forbidden', ...(details ? { details } : {}) },
    });
  const patch = (input: Record<string, unknown>) =>
    ({
      type: 'tool-entry_blocks_patch',
      toolCallId: 'call_1',
      state: 'approval-requested',
      input: { id: 'e1', expectedVersion: 3, ...input },
      approval: { id: 'call_1' },
    }) as never;
  const remove = { op: 'remove', field: 'body', key: 'k-cta' };
  const confirm = () => screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
  const notNow = () => screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement;
  const stepsText = async () =>
    within(await screen.findByRole('list', { name: 'Steps' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
  const hold = (text: string) => {
    const line = screen.getByText(text);
    expect(line.getAttribute('role')).toBe('status');
    expect(confirm().getAttribute('aria-describedby')).toBe(line.id);
  };
  const show = (part: never) =>
    render(
      <MemoryRouter>
        <ActionCard part={part} respond={vi.fn()} actionKey="m1:0" direct={false} turn={here} />
      </MemoryRouter>,
    );

  beforeEach(() => {
    client.listContentTypes.mockReset().mockResolvedValue([page]);
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields,
    });
    client.getBlocksOutline.mockReset().mockResolvedValue(outline());
    client.checkBlockPatch.mockReset();
  });

  it('says each step and where it lands, reviews the order by name, then lets it be confirmed', async () => {
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [ctaBlock, sectionBlock, heroBlock], de: fields.body.de }, [
        { op: 'move', field: 'body', locale: 'en-US', key: 'k-hero', to: { index: 2 } },
        { op: 'move', field: 'body', locale: 'en-US', key: 'k-cta', to: { index: 0 } },
      ]),
    );
    const ops = [
      { op: 'move', field: 'body', key: 'k-hero', to: { index: 2 } },
      { op: 'move', field: 'body', key: 'k-cta', to: { index: 0 } },
    ];
    show(patch({ ops }));
    expect(confirm().disabled).toBe(true);
    expect(await stepsText()).toEqual([
      'Moves Hero “Welcome” to the end of Body',
      'Moves Call to action “Sign up” to the start of Body',
    ]);
    // The call that runs on Confirm is the one checked.
    expect(client.checkBlockPatch).toHaveBeenCalledWith('e1', { expectedVersion: 3, ops });
    expect(screen.getByText('1 change in the draft:')).toBeTruthy();
    expect(confirm().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    // The slot's order before and after, by block name: never a diff of whatever sits at index 0.
    expect(
      within(changes).getByText('Hero “Welcome” · Call to action “Sign up” · Section “Features”'),
    ).toBeTruthy();
    expect(
      within(changes).getByText('Call to action “Sign up” · Section “Features” · Hero “Welcome”'),
    ).toBeTruthy();
    // Said once: open, the summary list steps aside for the review that names the same change.
    expect(screen.queryByRole('list', { name: 'Changed fields' })).toBeNull();
    expect(within(changes).getAllByText('Body')).toHaveLength(1);
  });

  it('says where an insert lands: after a sibling, into a block, in another locale', async () => {
    const added = { _type: 'cta', _key: 'n-1', label: 'Docs' };
    const inside = { _type: 'hero', _key: 'n-2', heading: 'Inside' };
    client.checkBlockPatch.mockResolvedValue(
      checked(
        {
          'en-US': [heroBlock, added, ctaBlock, { ...sectionBlock, items: [inside] }],
          de: [],
        },
        [
          { op: 'insert', field: 'body', locale: 'en-US', index: 1, block: added },
          {
            op: 'insert',
            field: 'body',
            locale: 'en-US',
            parent: { key: 'k-sec', slot: 'items' },
            index: 0,
            block: inside,
          },
          { op: 'remove', field: 'body', locale: 'de', key: 'k-cta' },
        ],
      ),
    );
    show(
      patch({
        ops: [
          { op: 'insert', field: 'body', after: 'k-hero', block: { _type: 'cta', label: 'Docs' } },
          {
            op: 'insert',
            field: 'body',
            parent: { key: 'k-sec', slot: 'items' },
            block: { _type: 'hero', heading: 'Inside' },
          },
          { op: 'remove', field: 'body', locale: 'de', key: 'k-cta' },
        ],
      }),
    );
    expect(await stepsText()).toEqual([
      'Adds Call to action “Docs” after Hero “Welcome”',
      'Adds Hero “Inside” into Section “Features”',
      // The de block shares its key with en-US's; it is named from its own locale.
      'Removes Call to action “Anmelden” (de)',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Section “Features” › Items')).toBeTruthy();
    // The section's slot before its first block, and the de field after its last went.
    expect(within(changes).getAllByText('No blocks')).toHaveLength(2);
  });

  it('reviews an update as the block’s own fields, matched by key', async () => {
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [{ ...heroBlock, heading: 'Hi' }, ctaBlock, sectionBlock], de: [] }, [
        {
          op: 'update',
          field: 'body',
          locale: 'en-US',
          key: 'k-hero',
          set: { heading: 'Hi' },
        },
      ]),
    );
    show(patch({ ops: [{ op: 'update', field: 'body', key: 'k-hero', set: { heading: 'Hi' } }] }));
    expect(await stepsText()).toEqual(['Changes Hero “Welcome”']);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Hero “Welcome” › Heading')).toBeTruthy();
    expect(within(changes).getByText('Welcome')).toBeTruthy();
    expect(within(changes).getByText('Hi')).toBeTruthy();
  });

  it('says a duplicate by its original, and a move across slots by where it goes in', async () => {
    const copy = { ...heroBlock, _key: 'n-1' };
    const inside = { _type: 'cta', _key: 'k-in', label: 'Inside' };
    const last = { _type: 'hero', _key: 'k-last', heading: 'Last' };
    const startWith = {
      ...fields,
      body: {
        'en-US': [heroBlock, ctaBlock, { ...sectionBlock, items: [inside, last] }],
        de: [],
      },
    };
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields: startWith,
    });
    client.checkBlockPatch.mockResolvedValue(
      checked(
        {
          'en-US': [heroBlock, copy, { ...sectionBlock, items: [inside, ctaBlock, last] }],
          de: [],
        },
        [
          { op: 'insert', field: 'body', locale: 'en-US', index: 1, block: copy },
          {
            op: 'move',
            field: 'body',
            locale: 'en-US',
            key: 'k-cta',
            to: { parent: { key: 'k-sec', slot: 'items' }, index: 1 },
          },
        ],
      ),
    );
    show(
      patch({
        ops: [
          { op: 'duplicate', field: 'body', key: 'k-hero' },
          {
            op: 'move',
            field: 'body',
            key: 'k-cta',
            to: { parent: { key: 'k-sec', slot: 'items' }, after: 'k-in' },
          },
        ],
      }),
    );
    expect(await stepsText()).toEqual([
      'Duplicates Hero “Welcome”',
      'Moves Call to action “Sign up” into Section “Features”, after Call to action “Inside”',
    ]);
  });

  it('sees two same-named blocks swap, numbering them, rather than calling it no change', async () => {
    const one = { _type: 'hero', _key: 'k-1' };
    const two = { _type: 'hero', _key: 'k-2' };
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields: { ...fields, body: { 'en-US': [one, two] } },
    });
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [two, one] }, [
        { op: 'move', field: 'body', locale: 'en-US', key: 'k-1', to: { index: 1 } },
      ]),
    );
    show(patch({ ops: [{ op: 'move', field: 'body', key: 'k-1', to: { index: 1 } }] }));
    expect(await stepsText()).toEqual(['Moves Hero to the end of Body']);
    expect(confirm().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Hero (1) · Hero (2)')).toBeTruthy();
    expect(within(changes).getByText('Hero (2) · Hero (1)')).toBeTruthy();
  });

  it('counts a block with no key in the place a step lands, and in the order', async () => {
    const keyless = { _type: 'cta', label: 'Old' };
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields: { ...fields, body: { 'en-US': [keyless, heroBlock, ctaBlock] } },
    });
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [keyless, ctaBlock, heroBlock] }, [
        { op: 'move', field: 'body', locale: 'en-US', key: 'k-cta', to: { index: 1 } },
      ]),
    );
    show(patch({ ops: [{ op: 'move', field: 'body', key: 'k-cta', to: { index: 1 } }] }));
    // Index 1 is after the keyless block, not the start.
    expect(await stepsText()).toEqual([
      'Moves Call to action “Sign up” after Call to action “Old”',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      screen.getByText('Call to action “Old” · Hero “Welcome” · Call to action “Sign up”'),
    ).toBeTruthy();
  });

  it('sees a link pointed elsewhere as a change, though both read “Linked entry”', async () => {
    const linkPage = {
      ...page,
      fields: [
        symbol('title', 'Title'),
        blocks('body', 'Body', [
          {
            apiId: 'cta',
            name: 'Call to action',
            fields: [
              symbol('label', 'Label'),
              { ...symbol('target', 'Target'), type: 'Link', linkType: 'Entry' },
            ],
          },
        ]),
      ],
    };
    client.listContentTypes.mockResolvedValue([linkPage]);
    const was = { ...ctaBlock, target: { id: 'a', linkType: 'Entry' } };
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields: { ...fields, body: { 'en-US': [was] } },
    });
    client.getBlocksOutline.mockResolvedValue(outline(['body']));
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [{ ...was, target: { id: 'b', linkType: 'Entry' } }] }, [
        {
          op: 'update',
          field: 'body',
          locale: 'en-US',
          key: 'k-cta',
          set: { target: { id: 'b', linkType: 'Entry' } },
        },
      ]),
    );
    show(
      patch({
        ops: [
          {
            op: 'update',
            field: 'body',
            key: 'k-cta',
            set: { target: { id: 'b', linkType: 'Entry' } },
          },
        ],
      }),
    );
    expect(await stepsText()).toEqual(['Changes Call to action “Sign up”']);
    expect(confirm().disabled).toBe(false);
  });

  it('shows what a new block would hold before it is confirmed', async () => {
    const added = { _type: 'hero', _key: 'n-1', heading: 'Spring launch' };
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [heroBlock, ctaBlock, sectionBlock, added], de: fields.body.de }, [
        { op: 'insert', field: 'body', locale: 'en-US', index: 3, block: added },
      ]),
    );
    show(
      patch({
        ops: [{ op: 'insert', field: 'body', block: { _type: 'hero', heading: 'Spring launch' } }],
      }),
    );
    expect(await stepsText()).toEqual(['Adds Hero “Spring launch” to the end of Body']);
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Hero “Spring launch” › Heading')).toBeTruthy();
    // With the review open the summary is no longer a lead-in to a list.
    expect(screen.getByText('2 changes in the draft.')).toBeTruthy();
  });

  it('names a rule broken in a new block by its type, the api having minted its key', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          field: 'body[3].label',
          locale: 'en-US',
          message: 'Field is required',
          block: { key: 'minted', type: 'cta', path: 'label' },
        },
      ]),
    );
    show(patch({ ops: [{ op: 'insert', field: 'body', block: { _type: 'cta' } }] }));
    await screen.findByText(
      'The new call to action › Label: Field is required. Choose Not now, then ask again.',
    );
  });

  it('words every step refusal from its code, never the api’s own text', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          op: 0,
          field: 'ops[0]',
          locale: 'en-US',
          code: 'holds_blocks',
          key: 'k-sec',
          message: '"items" holds blocks: change them with insert, move, remove or duplicate',
        },
      ]),
    );
    show(patch({ ops: [{ op: 'update', field: 'body', key: 'k-sec', set: { items: [] } }] }));
    await screen.findByText(/Section “Features” keeps its blocks in a field a change can’t set/);
    expect(screen.queryByText(/"items"/)).toBeNull();
  });

  it('refuses, never offers Try again, when the person can’t read the entry it would change', async () => {
    client.getEntry.mockRejectedValue(
      new ApiError(403, 'Missing required scope "content:read:page"'),
    );
    show(patch({ ops: [remove] }));
    await screen.findByText('Your role can’t change this entry');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it('won’t confirm a patch made for a version the draft has moved past', async () => {
    client.checkBlockPatch.mockRejectedValue(
      new ApiError(409, 'Entry "e1" is at version 4, not 3', {
        error: { code: 'conflict', details: { currentVersion: 4, expectedVersion: 3 } },
      }),
    );
    show(patch({ ops: [remove] }));
    await screen.findByText('The entry changed after this was proposed');
    expect(
      screen.getByText(
        'Its draft is at version 4; this change was made for version 3. Choose Not now, then ask again.',
      ),
    ).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    hold('You can’t confirm this: the entry changed after it was proposed.');
    expect(notNow().disabled).toBe(false);
  });

  it('says why a step doesn’t fit from its code, naming the block by its key', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          op: 1,
          field: 'ops[1]',
          locale: 'en-US',
          code: 'keyless_parent',
          key: 'k-hero',
          message: 'Block "k-hero" sits in a block with no _key; save the entry once to key it',
        },
      ]),
    );
    show(patch({ ops: [remove, { op: 'remove', field: 'body', key: 'k-hero' }] }));
    await screen.findByText('Step 2 doesn’t fit this entry');
    expect(
      screen.getByText(
        'Hero “Welcome” sits in a block with no key; save the entry once to give it one. Choose Not now, then ask again.',
      ),
    ).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    hold('You can’t confirm this: step 2 doesn’t fit this entry.');
  });

  it('says a new block’s key is taken, naming the block that holds it', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          op: 0,
          field: 'ops[0]',
          locale: 'en-US',
          code: 'key_taken',
          key: 'k-hero',
          message: '_key "k-hero" is already held by a block in body (en-US)',
        },
      ]),
    );
    show(
      patch({ ops: [{ op: 'insert', field: 'body', block: { _type: 'cta', _key: 'k-hero' } }] }),
    );
    await screen.findByText(/The new block’s key is already Hero “Welcome”’s\./);
    expect(screen.queryByText(/k-hero/)).toBeNull();
  });

  it('reads an op the call can’t even express as that step', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([{ field: 'ops.0.op', message: 'Invalid input' }]),
    );
    show(patch({ ops: [{ op: 'rename', field: 'body', key: 'k-cta' }] }));
    await screen.findByText('Step 1 doesn’t fit this entry');
    expect(confirm().disabled).toBe(true);
  });

  it('names the block a broken rule falls in, by its key, and its field', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          field: 'body[0].label',
          locale: 'en-US',
          message: 'Field is required',
          block: { key: 'k-cta', type: 'cta', path: 'label' },
        },
      ]),
    );
    show(patch({ ops: [{ op: 'update', field: 'body', key: 'k-cta', unset: ['label'] }] }));
    await screen.findByText('The entry wouldn’t be valid after this');
    // One full stop, whatever the message ends with.
    expect(
      screen.getByText(
        'Call to action “Sign up” › Label: Field is required. Choose Not now, then ask again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/body\[0\]/i)).toBeNull();
    hold('You can’t confirm this: the entry wouldn’t be valid after it.');
  });

  it('keeps a message’s own full stop rather than doubling it', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([{ field: 'title', locale: 'en-US', message: 'Too long.' }]),
    );
    show(patch({ ops: [remove] }));
    await screen.findByText('Title: Too long. Choose Not now, then ask again.');
  });

  it('refuses a field the role can read but not write, named from the 403’s details', async () => {
    client.checkBlockPatch.mockRejectedValue(forbidden({ reason: 'read_only', field: 'body' }));
    show(patch({ ops: [remove] }));
    await screen.findByText('Your role can’t change Body');
    expect(confirm().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    hold('You can’t confirm this: it changes a field your role can’t change.');
  });

  it('counts the fields the dry run says the person can’t read', async () => {
    client.checkBlockPatch.mockRejectedValue(forbidden({ reason: 'hidden', hidden: 2 }));
    show(patch({ ops: [remove] }));
    await screen.findByText('2 fields you can’t read are in this change, so it can’t be saved.');
    hold('You can’t confirm this: it changes a field you can’t read.');
  });

  it('counts stored values the person can’t read that fail a rule, never naming them', async () => {
    client.checkBlockPatch.mockRejectedValue(
      unprocessable([
        {
          field: '',
          code: 'hidden',
          hidden: 1,
          message:
            '1 field you can’t read isn’t valid; someone who can read it has to fix it first',
        },
      ]),
    );
    show(patch({ ops: [remove] }));
    await screen.findByText(
      '1 field you can’t read isn’t valid, so this change can’t be saved until someone who can read it fixes it.',
    );
    expect(confirm().disabled).toBe(true);
    hold('You can’t confirm this: a field you can’t read isn’t valid.');
  });

  it('counts a field missing from the outline without asking the dry run', async () => {
    client.getBlocksOutline.mockResolvedValue(outline(['body']));
    show(patch({ ops: [{ op: 'insert', field: 'notes', block: { _type: 'cta' } }] }));
    await screen.findByText('1 field you can’t read is in this change, so it can’t be saved.');
    expect(client.checkBlockPatch).not.toHaveBeenCalled();
  });

  it('refuses, never offers Try again, when the role can’t change the entry at all', async () => {
    client.checkBlockPatch.mockRejectedValue(forbidden());
    show(patch({ ops: [remove] }));
    await screen.findByText('Your role can’t change this entry');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(confirm().disabled).toBe(true);
    hold('You can’t confirm this: your role can’t change this entry.');
  });

  it('holds Confirm when the patch changes nothing in the draft', async () => {
    client.checkBlockPatch.mockResolvedValue(
      checked(fields.body, [
        {
          op: 'update',
          field: 'body',
          locale: 'en-US',
          key: 'k-cta',
          set: { label: 'Sign up' },
        },
      ]),
    );
    show(
      patch({ ops: [{ op: 'update', field: 'body', key: 'k-cta', set: { label: 'Sign up' } }] }),
    );
    await screen.findByText('The draft already holds this; the change does nothing.');
    hold('You can’t confirm this: it changes nothing in the draft.');
  });

  it('holds Confirm for a call that doesn’t say what to change', async () => {
    show(patch({ expectedVersion: undefined, ops: [] }));
    await screen.findByText(/Coworker didn’t say which entry or what to change/);
    expect(confirm().disabled).toBe(true);
    expect(client.getEntry).not.toHaveBeenCalled();
  });

  it('offers Try again when the draft can’t be read, and Not now meanwhile', async () => {
    client.getBlocksOutline.mockReset().mockRejectedValueOnce(new Error('down'));
    client.checkBlockPatch.mockResolvedValue(
      checked({ 'en-US': [heroBlock, sectionBlock], de: fields.body.de }, [
        { ...remove, locale: 'en-US' },
      ]),
    );
    show(patch({ ops: [remove] }));
    await screen.findByRole('button', { name: 'Try again' });
    expect(confirm().disabled).toBe(true);
    hold('You can’t confirm until this can show what changes.');
    expect(notNow().disabled).toBe(false);
    client.getBlocksOutline.mockResolvedValue(outline());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await stepsText()).toEqual(['Removes Call to action “Sign up”']);
    expect(confirm().disabled).toBe(false);
  });

  it('treats a server failure other than a refusal as a failed read', async () => {
    client.checkBlockPatch.mockRejectedValue(new ApiError(500, 'Internal error'));
    show(patch({ ops: [remove] }));
    await screen.findByRole('button', { name: 'Try again' });
    expect(confirm().disabled).toBe(true);
  });
});

describe('a line’s words', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('says a finished read in the past tense, with what it found', () => {
    inRouter(
      <ReadLine
        part={
          {
            type: 'tool-entries_query',
            toolCallId: 'r1',
            state: 'output-available',
            input: {},
            output: { items: [1, 2, 3], total: 10 },
          } as never
        }
        streaming={false}
      />,
    );
    expect(screen.getByText('Found entries · 10 results')).toBeTruthy();
  });

  it('dates an edit in its margin', () => {
    const at = Date.UTC(2026, 10, 2, 14, 5);
    inRouter(
      <EditLine
        at={at}
        part={card({
          state: 'output-available',
          output: { id: 'e1', contentTypeApiId: 'article' },
          approval: { id: 'direct_1', approved: true },
        })}
      />,
    );
    const time = document.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(new Date(at).toISOString());
    expect(time?.textContent).toBe(whenLabel(at));
    // The time isn't part of where the line links.
    expect(screen.getByRole('link').textContent).not.toContain(whenLabel(at));
  });

  it('reads a time today, and a day before today', () => {
    const now = new Date(2026, 10, 7, 16, 0).getTime();
    expect(whenLabel(new Date(2026, 10, 7, 9, 30).getTime(), now)).toMatch(/9:30/);
    expect(whenLabel(new Date(2026, 10, 2, 9, 30).getTime(), now)).toMatch(/2/);
    expect(whenLabel(new Date(2026, 10, 2, 9, 30).getTime(), now)).not.toMatch(/9:30/);
  });

  it('words a dropped connection for the person, and keeps the agent’s own words', () => {
    expect(turnErrorText('Failed to fetch')).toMatch(/connection dropped/);
    expect(turnErrorText('')).toMatch(/connection dropped/);
    expect(turnErrorText('You can’t publish entries of this type.')).toBe(
      'You can’t publish entries of this type.',
    );
  });
});

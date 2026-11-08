// @vitest-environment jsdom
import { nodeSpec, type WorkflowGraph, withDefaults } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowListItem } from '~/cms/lib/management';

const graph = (trigger: string): WorkflowGraph => ({
  nodes: [
    {
      id: 'start',
      type: trigger,
      label: 'Start',
      config: withDefaults(trigger),
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
});

/**
 * A workflow as the list route returns it. By default its draft and published version start on
 * the same trigger and nothing starts alongside it; the API decides both, so tests set them.
 */
const workflow = (
  id: string,
  name: string,
  trigger: string,
  over: Partial<WorkflowListItem> = {},
): WorkflowListItem => ({
  id,
  name,
  description: '',
  contentTypes: [],
  gatesPublish: false,
  publishGated: false,
  graph: graph(trigger),
  steps: [],
  latestVersion: 1,
  legacy: false,
  updatedAt: null,
  publishedTrigger: { type: trigger, label: nodeSpec(trigger)?.label ?? trigger },
  startsAlongside: [],
  ...over,
});

const UNPUBLISHED = { latestVersion: null, publishedTrigger: null, startsAlongside: null };

const client = {
  listWorkflowGraphs: vi.fn<() => Promise<WorkflowListItem[]>>(),
  listContentTypes: vi.fn(async () => [{ apiId: 'article', name: 'Article' }]),
  createWorkflowDraft: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { Workflows } = await import('~/cms/routes/Workflows');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(workflows: WorkflowListItem[]) {
  client.listWorkflowGraphs.mockResolvedValue(workflows);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Workflows />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = async (name: string) => {
  const row = (await screen.findByRole('link', { name })).closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};

describe('workflows list', () => {
  it('holds the New workflow sheet while it creates, rather than offer to discard', async () => {
    let finish: (r: { workflow: { id: string } }) => void = () => {};
    client.createWorkflowDraft.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    setup([]);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: 'Legal' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create workflow' }));
    await within(sheet).findByRole('button', { name: 'Creating…' });

    expect(within(sheet).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(sheet).getByRole('status').textContent).toContain('Still saving');
    await act(async () => finish({ workflow: { id: 'wf-new' } }));
  });

  it('lists each workflow as a row with what starts it, what it covers and its version', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual', {
        contentTypes: ['article'],
        gatesPublish: true,
        publishGated: true,
      }),
    ]);
    const row = await rowOf('Editorial review');
    expect(row.getByText('Starts on Submit for review')).toBeTruthy();
    expect(row.getByText('Covers Article')).toBeTruthy();
    expect(row.getByText('Publishing: Only through this workflow')).toBeTruthy();
    expect(row.getByText('Published v1')).toBeTruthy();
    // No nested cards: the workflows are the rows of one list.
    const list = screen.getByRole('list', { name: 'All workflows' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).queryByRole('list')).toBeNull();
  });

  it('names the other published workflows the API says start the same way', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual', { startsAlongside: ['wf-2'] }),
      workflow('wf-2', 'Legal review', 'trigger.manual', { startsAlongside: ['wf-1'] }),
      workflow('wf-3', 'Tag on publish', 'trigger.entry_published'),
      workflow('wf-4', 'Unpublished draft', 'trigger.manual', UNPUBLISHED),
    ]);
    const editorial = await rowOf('Editorial review');
    expect(editorial.getByText('Editors choose between this and Legal review')).toBeTruthy();
    const legal = await rowOf('Legal review');
    expect(legal.getByText('Editors choose between this and Editorial review')).toBeTruthy();
    const tagging = await rowOf('Tag on publish');
    expect(tagging.queryByText(/choose between|Also starts/)).toBeNull();
    // A draft never published starts nothing; the row says what it would start on.
    const draft = await rowOf('Unpublished draft');
    expect(draft.getByText('Not published')).toBeTruthy();
    expect(draft.getByText('Draft starts on Submit for review')).toBeTruthy();
    expect(draft.queryByText(/choose between|Also starts/)).toBeNull();
  });

  it('says which event-started workflows run together', async () => {
    setup([
      workflow('wf-1', 'Tag on publish', 'trigger.entry_published', { startsAlongside: ['wf-2'] }),
      workflow('wf-2', 'Notify on publish', 'trigger.entry_published', {
        contentTypes: ['article'],
        startsAlongside: ['wf-1'],
      }),
    ]);
    const row = await rowOf('Tag on publish');
    expect(row.getByText('Also starts: Notify on publish')).toBeTruthy();
  });

  it('describes the published version, and the draft only where its trigger differs', async () => {
    setup([
      // Published on "Entry published"; the draft has since moved to "Submit for review".
      workflow('wf-1', 'Announce', 'trigger.manual', {
        publishedTrigger: { type: 'trigger.entry_published', label: 'Entry published' },
      }),
      // Two manual workflows for every type that the API reports as not overlapping: the list
      // renders what it is told and works nothing out from the draft graphs.
      workflow('wf-2', 'Review', 'trigger.manual'),
      workflow('wf-3', 'Second review', 'trigger.manual'),
    ]);
    const announce = await rowOf('Announce');
    expect(announce.getByText('Starts on Entry published')).toBeTruthy();
    expect(announce.getByText('Draft starts on Submit for review')).toBeTruthy();
    const review = await rowOf('Review');
    expect(review.getByText('Starts on Submit for review')).toBeTruthy();
    expect(review.queryByText(/Draft starts on|choose between|Also starts/)).toBeNull();
  });

  it('says in words what each column used to say by its header', async () => {
    setup([
      workflow('wf-1', 'Broad', 'trigger.manual', {
        description: 'For everything',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      workflow('wf-2', 'Unfinished', 'trigger.manual', UNPUBLISHED),
    ]);
    const broad = await rowOf('Broad');
    expect(broad.getByText('For everything')).toBeTruthy();
    expect(broad.getByText('Covers every content type')).toBeTruthy();
    expect(broad.getByText('Publishing: Not gated')).toBeTruthy();
    expect(broad.getByText(/^Edited/)).toBeTruthy();
    expect(broad.getByText('Steps').nextElementSibling?.textContent).toBe('1');
    const unfinished = await rowOf('Unfinished');
    expect(unfinished.getByText('No description yet.')).toBeTruthy();
    expect(unfinished.getByText('Draft, never published')).toBeTruthy();
  });

  it('filters in the card, and a miss offers the way out', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual', { description: 'Two editors' }),
      workflow('wf-2', 'Legal review', 'trigger.manual'),
    ]);
    await rowOf('Editorial review');
    const search = screen.getByRole('searchbox', { name: 'Filter workflows' });

    fireEvent.change(search, { target: { value: 'two EDITORS' } });
    expect(screen.getByRole('link', { name: 'Editorial review' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Legal review' })).toBeNull();

    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(screen.getByText(/No workflow matches “nothing like it”/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'All workflows' })).toBeNull();
    // The field's own Clear and the miss's: the search stays, so it can still be changed.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await rowOf('Legal review')).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('offers no filter when there are no workflows at all', async () => {
    setup([]);
    expect(await screen.findByText(/No workflows yet/)).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

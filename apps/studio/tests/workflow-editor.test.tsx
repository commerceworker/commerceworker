// @vitest-environment jsdom
import { type WorkflowGraph, withDefaults } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The workflow editor (routes/WorkflowEditor.tsx) against a mocked client: palette add, wiring
 * through the Connections panel with its cycle check, inspector validation, undo/redo, Publish
 * refused while validateGraph has errors, and the review-only view below lg.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// React Flow reads transforms through DOMMatrixReadOnly, which jsdom lacks.
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

/** Wide (lg and up) or not; every other media query is false. */
let wide = true;
beforeEach(() => {
  wide = true;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1024px') ? wide : query.includes('pointer: fine'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const node = (id: string, type: string, label: string, x = 0) => ({
  id,
  type,
  label,
  config: withDefaults(type),
  position: { x, y: 0 },
});

/** Submit for review → Comment A → Comment B, and an unconnected Comment C. */
const GRAPH: WorkflowGraph = {
  nodes: [
    node('start', 'trigger.manual', 'Start'),
    node('a', 'content.comment', 'Comment A', 280),
    node('b', 'content.comment', 'Comment B', 560),
    node('c', 'content.comment', 'Comment C', 840),
  ],
  edges: [
    { id: 'start-a', source: 'start', target: 'a', sourceHandle: null, targetHandle: null },
    { id: 'a-b', source: 'a', target: 'b', sourceHandle: null, targetHandle: null },
  ],
};

const summary = (graph: WorkflowGraph) => ({
  id: 'wf-1',
  name: 'Editorial review',
  description: '',
  contentTypes: [],
  gatesPublish: false,
  publishGated: false,
  graph,
  steps: [],
  latestVersion: null,
  legacy: false,
  updatedAt: null,
});

const client = {
  getWorkflow: vi.fn(async () => summary(GRAPH)),
  listWorkflowVersions: vi.fn(async () => []),
  getWorkflowVersion: vi.fn(),
  listContentTypes: vi.fn(async () => []),
  listReleases: vi.fn(async () => [
    { id: 'rel-1', title: 'Spring launch', status: 'open', createdAt: '2026-10-01T00:00:00Z' },
  ]),
  saveWorkflowDraft: vi.fn(async (_id: string, input: { graph: WorkflowGraph }) => ({
    workflow: summary(input.graph),
    validation: { ok: true, errors: [], warnings: [] },
  })),
  publishWorkflowVersion: vi.fn(async () => ({ version: 1 })),
  workflowCopilot: vi.fn(),
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

const { WorkflowEditor } = await import('~/cms/routes/WorkflowEditor');
const { ToastProvider } = await import('~/cms/lib/toast');
const { wouldCycle } = await import('~/cms/components/workflow/graph');

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/workflows/:id', element: <WorkflowEditor /> },
      { path: '/workflows', element: <p>Workflows list</p> },
    ],
    { initialEntries: ['/workflows/wf-1'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** The checks list, which names every problem; picking one selects its step. */
const checks = () => screen.getByRole('list', { name: 'Checks' });
const pickCheck = (text: RegExp) =>
  fireEvent.click(within(checks()).getByRole('button', { name: text }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  client.getWorkflow.mockImplementation(async () => summary(GRAPH));
});

describe('workflow editor', () => {
  it('adds a palette step after the selected step and selects it', async () => {
    renderEditor();
    await screen.findByRole('textbox', { name: 'Workflow name' });
    // Comment B has no outgoing edge (a warning); picking it selects it.
    pickCheck(/Comment B has no outgoing edge/);
    fireEvent.click(screen.getByRole('button', { name: /^Add End\b/ }));

    // The new step is selected (its settings show) and wired in after Comment B.
    expect(await screen.findByRole('heading', { name: 'End' })).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(client.saveWorkflowDraft).toHaveBeenCalledOnce());
    const saved = client.saveWorkflowDraft.mock.calls[0]?.[1].graph as WorkflowGraph;
    expect(saved.nodes.map((n) => n.id)).toContain('end_1');
    expect(saved.edges).toContainEqual(expect.objectContaining({ source: 'b', target: 'end_1' }));
  });

  it('wires outputs from the Connections panel and never offers a cycle', async () => {
    renderEditor();
    await screen.findByRole('textbox', { name: 'Workflow name' });
    expect(
      within(checks()).getByText(/Comment C is not connected to anything upstream/),
    ).toBeTruthy();

    pickCheck(/Comment B has no outgoing edge/);
    const connect = screen.getByRole('combobox', { name: 'Connect out to' });
    const offered = within(connect)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    // A and the trigger lead into B, so connecting to them would close a cycle.
    expect(offered).toEqual(['', 'c']);
    fireEvent.change(connect, { target: { value: 'c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect out' }));
    expect(
      await screen.findByRole('button', { name: 'Disconnect out from Comment C' }),
    ).toBeTruthy();

    // Escape deselects, back to the checks.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(within(checks()).queryByText(/Comment C is not connected/)).toBeNull(),
    );
    // From C, every other step is upstream: nothing to offer at all.
    pickCheck(/Comment C has no outgoing edge/);
    expect(screen.queryByRole('combobox', { name: 'Connect out to' })).toBeNull();
    expect(wouldCycle(GRAPH, 'b', 'a')).toBe(true);
    expect(wouldCycle(GRAPH, 'b', 'c')).toBe(false);
  });

  it('names a step whose label is only its id by its kind, never by the id', async () => {
    client.getWorkflow.mockImplementation(async () =>
      summary({
        nodes: GRAPH.nodes.map((n) => (n.id === 'c' ? { ...n, label: 'c' } : n)),
        edges: GRAPH.edges,
      }),
    );
    renderEditor();
    await screen.findByRole('textbox', { name: 'Workflow name' });
    pickCheck(/Comment B has no outgoing edge/);
    const connect = screen.getByRole('combobox', { name: 'Connect out to' });
    const names = within(connect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['Connect to…', 'Comment']);
  });

  it('offers Discard changes only once there is something to discard', async () => {
    renderEditor();
    const name = await screen.findByRole('textbox', { name: 'Workflow name' });
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Editorial review'));
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  });

  it('shows a step’s validation problems in the inspector until they are fixed', async () => {
    client.getWorkflow.mockImplementation(async () =>
      summary({
        nodes: [
          node('start', 'trigger.manual', 'Start'),
          node('rel', 'content.add_to_release', 'Add to release', 280),
        ],
        edges: [
          {
            id: 'start-rel',
            source: 'start',
            target: 'rel',
            sourceHandle: null,
            targetHandle: null,
          },
        ],
      }),
    );
    renderEditor();
    await screen.findByRole('textbox', { name: 'Workflow name' });
    pickCheck(/Release is required/);

    const problems = screen.getByRole('list', { name: 'Problems with this step' });
    expect(within(problems).getByText(/Release is required/)).toBeTruthy();
    // The release picker reads the space's open releases.
    const picker = await screen.findByRole('combobox', { name: 'Release' });
    await screen.findByRole('option', { name: 'Spring launch' });
    fireEvent.change(picker, { target: { value: 'rel-1' } });
    expect(screen.queryByRole('list', { name: 'Problems with this step' })).toBeNull();

    // A duration that doesn't parse says so in place.
    const timeout = screen.getByRole('textbox', { name: 'Timeout' });
    fireEvent.change(timeout, { target: { value: 'soon' } });
    expect(timeout.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use e.g. “5 minutes”')).toBeTruthy();
  });

  it('undoes and redoes edits, a burst of typing as one step', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    renderEditor();
    const name = await screen.findByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(name, { target: { value: 'Editorial review 2' } });
    now += 100;
    fireEvent.change(name, { target: { value: 'Editorial review 23' } });
    now += 1000;
    pickCheck(/Comment B has no outgoing edge/);
    fireEvent.click(screen.getByRole('button', { name: /^Add End\b/ }));
    expect(await screen.findByRole('heading', { name: 'End' })).toBeTruthy();

    // ⌘Z takes the step back out; the typing burst then undoes in one go.
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'End' })).toBeNull());
    expect((name as HTMLInputElement).value).toBe('Editorial review 23');
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    expect((name as HTMLInputElement).value).toBe('Editorial review');
    expect(screen.queryByText('Unsaved')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Redo/ }));
    expect((name as HTMLInputElement).value).toBe('Editorial review 23');
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    expect(await screen.findByRole('heading', { name: 'End' })).toBeTruthy();
    clock.mockRestore();
  });

  it('refuses to publish while the checks have errors, listing them, and sends nothing', async () => {
    renderEditor();
    await screen.findByRole('textbox', { name: 'Workflow name' });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Can’t publish yet: 1 check to fix/)).toBeTruthy();
    expect(within(alert).getByText(/Comment C is not connected/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.saveWorkflowDraft).not.toHaveBeenCalled();
    expect(client.publishWorkflowVersion).not.toHaveBeenCalled();
  });

  it('publishes the draft on screen after asking in place, saving it first', async () => {
    client.getWorkflow.mockImplementation(async () =>
      summary({ nodes: GRAPH.nodes.slice(0, 3), edges: GRAPH.edges }),
    );
    renderEditor();
    const name = await screen.findByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(name, { target: { value: 'Editorial review v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    const confirm = screen.getByRole('alertdialog', {
      name: /Publish “Editorial review v2” as v1/,
    });
    // An edit while the question is open withdraws it: it was about the draft as it was.
    fireEvent.change(name, { target: { value: 'Editorial review v3' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(confirm.isConnected).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save and publish' }),
    );
    await waitFor(() => expect(client.publishWorkflowVersion).toHaveBeenCalledWith('wf-1'));
    expect(client.saveWorkflowDraft).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ name: 'Editorial review v3' }),
    );
    expect(client.saveWorkflowDraft.mock.invocationCallOrder[0]).toBeLessThan(
      client.publishWorkflowVersion.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await screen.findByText('Published v1')).toBeTruthy();
  });

  it('is review-only below lg, and says so in place', async () => {
    wide = false;
    renderEditor();
    const name = await screen.findByRole('textbox', { name: 'Workflow name' });
    expect(screen.getByText(/Building workflows needs a wider screen/)).toBeTruthy();
    expect((name as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /Save draft/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Steps' })).toBeNull();
    // A step's settings still show, read-only, with no way to wire or delete it.
    pickCheck(/Comment B has no outgoing edge/);
    expect((screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: /Delete step/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Connect/ })).toBeNull();
  });
});

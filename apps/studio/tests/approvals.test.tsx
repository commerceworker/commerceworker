// The Approvals inbox: pending workflow steps and agent proposals, decided in place, through the
// real Management client against a mocked same-origin fetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { usePendingApprovalsCount } from '~/cms/lib/approvals';
import { ClientProvider } from '~/cms/lib/client-context';
import { ToastProvider } from '~/cms/lib/toast';
import { Approvals } from '~/cms/routes/Approvals';

const BASE = '/spaces/space-1/environments/main';

const task = {
  id: 'task-1',
  runId: 'run-1',
  workflowId: 'wf-1',
  nodeId: 'n1',
  eventType: 'approve:n1',
  kind: 'approval',
  entryId: 'entry-1',
  contentTypeApiId: 'article',
  title: 'Legal sign-off',
  instructions: 'Check the claims.',
  assignee: null,
  event: null,
  requiredScope: 'workflow:approve',
  separateDuties: false,
  reviewId: null,
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  status: 'pending',
  requestedAt: new Date(Date.now() - 600_000).toISOString(),
  decidedAt: null,
  decidedBy: null,
  note: null,
  startedBy: 'someone',
};

const LONG_BODY = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the new body.`).join(
  '\n',
);

const review = {
  id: 'review-1',
  workflow: 'enrich',
  entryId: 'entry-2',
  // Out of field order, with a long value and a second locale.
  proposed: {
    body: { 'en-US': LONG_BODY },
    summary: { 'en-US': 'A summary', 'de-DE': 'Eine Zusammenfassung' },
  },
  notes: ['Added a summary from the body.'],
  status: 'pending',
  awaiting: false,
  createdAt: new Date(Date.now() - 300_000).toISOString(),
};

// A proposal whose entry has since been deleted: the lookup doesn't return it.
const orphan = {
  ...review,
  id: 'review-2',
  workflow: 'repurpose',
  entryId: 'entry-gone',
  proposed: { title: { 'en-US': 'New title' } },
  notes: [],
  createdAt: new Date(Date.now() - 200_000).toISOString(),
};

const post = {
  apiId: 'post',
  name: 'Blog post',
  displayField: 'title',
  fields: [
    { apiId: 'title', name: 'Title', type: 'Symbol', localized: true, required: true, position: 0 },
    {
      apiId: 'summary',
      name: 'Summary',
      type: 'Text',
      localized: true,
      required: false,
      position: 1,
    },
    {
      apiId: 'body',
      name: 'Body copy',
      type: 'Text',
      localized: true,
      required: false,
      position: 2,
    },
  ],
};
const article = { ...post, apiId: 'article', name: 'Article' };

const entries = [
  {
    id: 'entry-1',
    contentType: 'article',
    status: 'draft',
    version: 1,
    fields: { title: { 'en-US': 'Spring launch' } },
  },
  {
    id: 'entry-2',
    contentType: 'post',
    status: 'draft',
    version: 1,
    fields: { title: { 'en-US': 'Winter menu' }, summary: { 'en-US': 'Old summary' } },
  },
];

function setup(
  opts: { hangLookupAfterApprove?: boolean; beside?: React.ReactNode; noTasks?: boolean } = {},
) {
  let approved = false;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url === '/spaces') return json({ items: [{ id: 'space-1', name: 'Space 1' }] });
    if (url === `${BASE}/approvals/count`)
      return json({ workflowTasks: 1, agentReviews: 2, total: 3 });
    if (url.startsWith(`${BASE}/workflow-tasks?`))
      return json({ items: opts.noTasks ? [] : [task] });
    if (url.startsWith(`${BASE}/agent-reviews?`))
      return json({ items: approved ? [orphan] : [review, orphan] });
    if (url === `${BASE}/content-types`) return json({ items: [post, article] });
    // Every row's entry in one request: the preview list filtered by `sys.id[in]`.
    if (url.startsWith('/preview/space-1/main/entries?')) {
      // A lookup for a new set of ids that never answers: what's on screen meanwhile is the point.
      if (approved && opts.hangLookupAfterApprove) return new Promise<Response>(() => {});
      const ids = new URL(url, 'http://x').searchParams.get('sys.id[in]')?.split(',') ?? [];
      return json({ items: entries.filter((e) => ids.includes(e.id)) });
    }
    if (url.endsWith('/decide'))
      return json({ taskId: 'task-1', runId: 'run-1', decision: 'approved', by: 'me' });
    if (url.endsWith('/approve')) {
      approved = true;
      return json({ ...review, status: 'approved' });
    }
    return json({});
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <ToastProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ClientProvider
            initial={{ space: 'space-1', environment: 'main', locale: 'en-US' }}
            fetchImpl={fetchImpl}
          >
            <Approvals />
            {opts.beside}
          </ClientProvider>
        </QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return calls;
}

const proposalFor = (name: string) => screen.findByRole('listitem', { name });

/** The shell's badge, mounted beside the inbox as the shell mounts it. */
function Badge() {
  const n = usePendingApprovalsCount();
  return <p data-testid="badge">{n ?? ''}</p>;
}

describe('Approvals', () => {
  it('asks the shell’s count again whenever its lists load, so the badge agrees with it', async () => {
    const calls = setup({ beside: <Badge /> });
    await screen.findByRole('listitem', { name: 'Legal sign-off' });
    const counts = () => calls.filter((c) => c.url === `${BASE}/approvals/count`).length;
    // Once for the badge itself, once more after the lists arrived.
    await waitFor(() => expect(counts()).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('badge').textContent).toBe('3');
  });

  it('names every entry by its title, from one batched lookup', async () => {
    const calls = setup();
    const step = await screen.findByRole('listitem', { name: 'Legal sign-off' });
    expect(within(step).getByText('Check the claims.')).toBeTruthy();
    expect(within(step).getByText('Pending')).toBeTruthy();
    const link = await within(step).findByRole('link', { name: 'Spring launch' });
    expect(link.getAttribute('href')).toBe('/content/article/entry-1');
    const lookups = calls.filter((c) => c.url.startsWith('/preview/space-1/main/entries?'));
    expect(lookups).toHaveLength(1);
    expect(new URL(lookups[0]!.url, 'http://x').searchParams.get('sys.id[in]')).toBe(
      'entry-1,entry-2,entry-gone',
    );
    // Up to the API's cap of 200, so the shell's count reads 99+ past it, not the default 50.
    expect(calls.some((c) => c.url === `${BASE}/workflow-tasks?status=pending&limit=200`)).toBe(
      true,
    );
    expect(calls.some((c) => c.url === `${BASE}/agent-reviews?status=pending`)).toBe(true);
    // No id is ever shown as a name.
    await proposalFor('Proposal for Winter menu');
    expect(screen.queryByText(/entry-\d|entry-gone/)).toBeNull();
  });

  it('shows a proposal as a diff of current against proposed values, by field name', async () => {
    setup();
    const proposal = await proposalFor('Proposal for Winter menu');
    expect(within(proposal).getByRole('link', { name: 'Winter menu' }).getAttribute('href')).toBe(
      '/content/post/entry-2',
    );
    expect(within(proposal).getByText(/Proposed by the Enrich agent/)).toBeTruthy();
    expect(within(proposal).getByText('Needs review')).toBeTruthy();
    expect(within(proposal).getByText('Added a summary from the body.')).toBeTruthy();
    // Two fields, three rows (summary in two locales): the count is of fields.
    expect(within(proposal).getByText('Changes 2 fields')).toBeTruthy();

    const table = within(proposal).getByRole('table', {
      name: 'Changes proposed to Winter menu',
    });
    const rows = within(table).getAllByRole('row').slice(1);
    // The content type's field order and names; the second locale named beside it.
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Summaryen-US',
      'Summaryde-DE',
      'Body copy',
    ]);
    const [enSummary, deSummary, body] = rows;
    expect(within(enSummary!).getByText('Old summary')).toBeTruthy();
    expect(within(enSummary!).getByText('A summary')).toBeTruthy();
    expect(within(deSummary!).getByText('Empty')).toBeTruthy();
    expect(within(deSummary!).getByText('Eine Zusammenfassung')).toBeTruthy();
    // A long value folds behind a disclosure.
    const more = within(body!).getByRole('button', { name: 'Show all' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(body!).getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(within(proposal).queryByText('summary')).toBeNull();
  });

  it('says when a proposal’s entry is gone, and shows only the proposed values', async () => {
    setup();
    const proposal = await proposalFor('Repurpose agent proposal');
    expect(within(proposal).getByText('Entry no longer available')).toBeTruthy();
    expect(within(proposal).getByText(/current values aren’t shown/)).toBeTruthy();
    expect(within(proposal).getByText('New title')).toBeTruthy();
    // Without the content type, the field is still named in words, not by its API id.
    expect(within(proposal).getByText('Title')).toBeTruthy();
  });

  it('approves a workflow step', async () => {
    const calls = setup();
    const step = await screen.findByRole('listitem', { name: 'Legal sign-off' });
    fireEvent.click(within(step).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: `${BASE}/workflow-tasks/task-1/decide`,
        body: { decision: 'approved' },
      }),
    );
  });

  it('approves an agent proposal only once its diff is on screen', async () => {
    const calls = setup();
    const proposal = await proposalFor('Proposal for Winter menu');
    const approve = within(proposal).getByRole('button', { name: 'Approve and apply' });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url === `${BASE}/agent-reviews/review-1/approve`,
        ),
      ).toBe(true),
    );
  });

  it('keeps the other rows named while the lookup for the new set of entries loads', async () => {
    setup({ hangLookupAfterApprove: true });
    const proposal = await proposalFor('Proposal for Winter menu');
    const approve = within(proposal).getByRole('button', { name: 'Approve and apply' });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByText('Winter menu')).toBeNull());
    // The task's entry was named before; its name stays while the new lookup is in flight.
    expect(screen.getByRole('link', { name: 'Spring launch' })).toBeTruthy();
  });

  it('rejects an agent proposal', async () => {
    const calls = setup();
    const proposal = await proposalFor('Proposal for Winter menu');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === `${BASE}/agent-reviews/review-1/reject`),
      ).toBe(true),
    );
  });
});

describe('Approvals order', () => {
  const headings = () =>
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());

  it('puts what is waiting first: with no workflow step waiting, proposals come before steps', async () => {
    setup({ noTasks: true });
    await screen.findByText('No workflow step is waiting on a decision.');
    const order = headings();
    expect(order.indexOf('Agent proposals')).toBeLessThan(order.indexOf('Workflow steps'));
  });

  it('keeps workflow steps first while one is waiting', async () => {
    setup();
    // The waiting step's entry, named once the lists and the lookup have loaded.
    await screen.findAllByText('Spring launch');
    const order = headings();
    expect(order.indexOf('Workflow steps')).toBeLessThan(order.indexOf('Agent proposals'));
  });
});

// @vitest-environment jsdom
import type { ContentType } from '@commerceworker/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const article = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
} as unknown as ContentType;

const entry = (id: string, title: string, status: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  fields: { title: { 'en-US': title } },
});

const unpublished = [
  entry('0190a000-0000-7000-8000-000000000001', 'Older draft', 'draft'),
  entry('0190a000-0000-7000-8000-000000000002', 'Edited launch post', 'changed'),
];

// Not in the capped list the dashboard loads: only the by-id lookup can name these. Their ids
// share a UUIDv7 prefix with every other, so a prefix would read the same for all of them.
const offList = [
  entry('0190a000-0000-7000-8000-0000000000a1', 'Spring menu', 'draft'),
  { ...entry('0190a000-0000-7000-8000-0000000000a2', '', 'draft'), fields: {} },
];
const DELETED = '0190a000-0000-7000-8000-0000000000ff';

const reviewRun = (id: string, entryId: string, status = 'needs_review'): AgentRun => ({
  id,
  workflow: 'enrich',
  entryId,
  status,
  decisions: [],
  inputTokens: 10,
  outputTokens: 5,
  createdAt: iso(-2 * DAY),
});

const runs: AgentRun[] = [
  {
    id: 'run-1',
    workflow: 'moderate',
    entryId: '0190a000-0000-7000-8000-000000000002',
    status: 'needs_review',
    decisions: ['flagged tone'],
    inputTokens: 1200,
    outputTokens: 300,
    createdAt: iso(-1 * DAY),
  },
  {
    id: 'run-2',
    workflow: 'enrich',
    entryId: '',
    status: 'completed',
    decisions: [],
    inputTokens: 9000,
    outputTokens: 600,
    // Outside the 14-day window: must not count toward any usage card.
    createdAt: iso(-30 * DAY),
  },
  reviewRun('run-3', offList[0]!.id),
  reviewRun('run-4', offList[1]!.id, 'held'),
  reviewRun('run-5', DELETED),
];

type ListArgs = [string | undefined, { filters?: { field: string; value?: unknown }[] }?];

const client = {
  // The by-id lookup filters on `sys.id[in]`; any other list is the unpublished work.
  listEntries: vi.fn(async (...[, query]: ListArgs) => {
    const byId = query?.filters?.find((f) => f.field === 'sys.id');
    if (!byId) return unpublished;
    const ids = byId.value as string[];
    return [...unpublished, ...offList].filter((e) => ids.includes(e.id));
  }),
  listScheduledActions: vi.fn(async () => [
    {
      id: 'sa-2',
      action: 'publish',
      entityType: 'Release',
      entityId: 'rel-1',
      scheduledFor: iso(3 * DAY),
      status: 'pending',
      createdAt: iso(-DAY),
    },
    {
      id: 'sa-1',
      action: 'publish',
      entityType: 'Entry',
      entityId: '0190a000-0000-7000-8000-000000000001',
      scheduledFor: iso(DAY),
      status: 'pending',
      createdAt: iso(-DAY),
    },
  ]),
  listReleases: vi.fn(async () => [
    { id: 'rel-1', title: 'Spring campaign', status: 'open', createdAt: iso(-2 * DAY) },
    { id: 'rel-0', title: 'Shipped bundle', status: 'published', createdAt: iso(-9 * DAY) },
  ]),
  subscribeLive: vi.fn(() => new Promise<void>(() => {})),
  search: vi.fn(async () => []),
};

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 'demo', environment: 'main', locale: 'en-US' },
  }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per mount
    useEffect(() => {
      queryFn().then(setData);
    }, []);
    return { data, isLoading: data === undefined, isError: false };
  },
  useContentTypesQuery: () => ({ data: [article] }),
  useAllEntriesQuery: () => ({ data: unpublished }),
  useAgentRunsQuery: () => ({ data: runs, isLoading: false, isError: false }),
}));

const { Dashboard } = await import('~/cms/components/Dashboard');
const { ToastProvider } = await import('~/cms/lib/toast');
const { fetchEntriesById } = await import('~/cms/components/dashboard/entry-titles');
const { statusTone } = await import('~/cms/lib/format');

afterEach(cleanup);

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Dashboard />
      </ToastProvider>
    </MemoryRouter>,
  );

const card = (heading: string) =>
  screen.getByRole('heading', { name: heading }).closest('[data-slot="card"]') as HTMLElement;

describe('Dashboard', () => {
  it('shows two live events that arrive in the same millisecond as two rows', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(1_793_580_044_816);
    client.subscribeLive.mockImplementationOnce(((emit: (e: { type: string }) => void) => {
      // Two assets published at once: no entry id, one type, one clock reading.
      emit({ type: 'asset.published' });
      emit({ type: 'asset.published' });
      return new Promise<void>(() => {});
    }) as never);
    renderDashboard();
    const live = card('Live activity');
    await waitFor(() => expect(within(live).getAllByRole('listitem')).toHaveLength(2));
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    vi.restoreAllMocks();
  });

  it('leads with unpublished work, newest first, linked by title', async () => {
    renderDashboard();
    const work = card('Not yet published');
    const links = await within(work).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Edited launch post', 'Older draft']);
    expect(links[0]?.getAttribute('href')).toBe(
      '/content/article/0190a000-0000-7000-8000-000000000002',
    );
    expect(within(work).getByText('Changed')).toBeTruthy();
    expect(client.listEntries).toHaveBeenCalledWith(undefined, {
      filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
      limit: 50,
    });
  });

  it('lists scheduled actions soonest first and only open releases', async () => {
    renderDashboard();
    const upcoming = card('Coming up');
    await within(upcoming).findByText('Older draft');
    const titles = within(upcoming)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('a, span')?.textContent);
    // Scheduled (soonest first), then open releases.
    expect(titles).toEqual(['Older draft', 'Spring campaign', 'Spring campaign']);
    expect(within(upcoming).queryByText('Shipped bundle')).toBeNull();
  });

  it('names and links every agent run awaiting review by its entry, never by an id', async () => {
    renderDashboard();
    const review = card('Agent proposals awaiting review');
    // Resolved by one batched lookup, including entries the capped list doesn't hold.
    const spring = await within(review).findByRole('link', { name: 'Spring menu' });
    expect(spring.getAttribute('href')).toBe(`/content/article/${offList[0]!.id}`);
    expect(within(review).getByRole('link', { name: 'Edited launch post' })).toBeTruthy();
    // Untitled: named as such (its type beside it) and still linked.
    expect(within(review).getByRole('link', { name: 'Untitled entry' }).getAttribute('href')).toBe(
      `/content/article/${offList[1]!.id}`,
    );
    // Gone: said in words, not shown as an id.
    expect(within(review).getByText('Entry no longer available')).toBeTruthy();
    expect(within(review).queryByText(/0190a000/)).toBeNull();
    expect(within(review).getByText(/^Article · Moderate · flagged tone · /)).toBeTruthy();
    // The review states read in sentence case, in the model's-work token.
    expect(within(review).getAllByText('Needs review').length).toBe(3);
    expect(within(review).getByText('Held')).toBeTruthy();
    expect(statusTone('needs_review')).toBe('ai');
    expect(statusTone('held')).toBe('ai');
    expect(within(review).getByRole('link', { name: 'Review in Approvals' })).toBeTruthy();
    const lookups = client.listEntries.mock.calls.filter(([, q]) =>
      q?.filters?.some((f) => f.field === 'sys.id'),
    );
    expect(lookups.length).toBeGreaterThan(0);
  });

  it('batches the by-id lookup under the preview page cap', async () => {
    const listEntries = vi.fn(async () => []);
    const ids = Array.from({ length: 230 }, (_, i) => `id-${i}`);
    await fetchEntriesById({ listEntries }, [...ids, ...ids.slice(0, 10), '']);
    expect(listEntries).toHaveBeenCalledTimes(3);
    const sizes = listEntries.mock.calls.map(
      (c) => ((c as unknown as ListArgs)[1]?.filters?.[0]?.value as string[] | undefined)?.length,
    );
    expect(sizes).toEqual([100, 100, 30]);
    listEntries.mockClear();
    expect(await fetchEntriesById({ listEntries }, [])).toEqual([]);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('keeps AI usage in one labelled 14-day window and drops the credentials card', async () => {
    renderDashboard();
    await screen.findAllByText('Edited launch post');
    expect(screen.getByRole('heading', { name: 'AI usage' })).toBeTruthy();
    // Only the in-window run (1.5K) counts — the 30-day-old 9.6K run must not.
    expect(screen.getByText('Tokens by workflow')).toBeTruthy();
    expect(screen.getAllByText('1.5K').length).toBeGreaterThan(0);
    expect(screen.queryByText('9.6K')).toBeNull();
    expect(screen.getAllByText('Last 14 days').length).toBe(3);
    expect(screen.queryByText(/Account Access/i)).toBeNull();
    expect(screen.queryByLabelText(/Access token/i)).toBeNull();
  });
});

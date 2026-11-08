// @vitest-environment jsdom
import type { Asset } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJobReport, BulkJobSummary } from '~/cms/lib/management';

/** As in asset-library.test.tsx: a CI runner's first render can outlast the default second. */
configure({ asyncUtilTimeout: 5000 });

const asset = (id: string, fileName: string): Asset => ({
  id,
  status: 'draft',
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
  file: { url: '', fileName, contentType: 'application/pdf' },
});

/** More assets than the threshold: the selection a loop in the tab would take minutes over. */
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => asset(`a${i + 1}`, `file-${i + 1}.pdf`));

const job = (over: Partial<BulkJobSummary> = {}): BulkJobSummary => ({
  id: 'job1',
  action: 'asset_publish',
  status: 'running',
  totalItems: 51,
  totalChunks: 2,
  completedChunks: 0,
  succeeded: 0,
  failed: 0,
  ...over,
});

let assets: Asset[] = [];
const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({ items: assets })),
  listAssetFolders: vi.fn(async () => [
    { id: 'f1', name: 'Campaigns', path: '/f1/', createdAt: '', updatedAt: '' },
  ]),
  listTags: vi.fn(async () => [{ id: 't1', name: 'Hero' }]),
  assetUsage: vi.fn(async () => []),
  // The Versions tab stays mounted, so the sheet reads the versions (and the team) on open.
  listAssetVersions: vi.fn(async () => []),
  getTeam: vi.fn(async () => ({
    people: [],
    keys: [],
    adminCount: 1,
    settings: { ssoOnly: false },
  })),
  publishAsset: vi.fn(async () => ({})),
  unpublishAsset: vi.fn(async () => ({})),
  archiveAsset: vi.fn(async () => ({})),
  restoreAsset: vi.fn(),
  deleteAsset: vi.fn(),
  moveAssets: vi.fn(async (ids: string[]) => ({ moved: ids.length })),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(),
  uploadVideo: vi.fn(),
  searchAssets: vi.fn(),
  getAsset: vi.fn(),
  reingestAsset: vi.fn(),
  setAssetMetadata: vi.fn(),
  startAssetBulkJob: vi.fn(async (_input: unknown) => job()),
  getBulkJob: vi.fn(async (_id: string) => job()),
  getBulkJobReport: vi.fn(
    async (_id: string): Promise<BulkJobReport> => ({ job: job(), chunks: [] }),
  ),
  cancelBulkJob: vi.fn(async (_id: string) =>
    job({ status: 'cancelled', completedChunks: 1, succeeded: 25 }),
  ),
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
const { AssetLibrary } = await import('~/cms/components/AssetLibrary');
const { ApiError } = await import('~/cms/lib/management');

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  assets = [];
  try {
    localStorage.clear();
  } catch {}
});

const renderLibrary = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ToastProvider>
          <AssetLibrary locale="en-US" />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

/** The list view, everything shown selected; returns the bulk bar. */
async function selectAll() {
  localStorage.setItem('cw.assets.view', 'list');
  renderLibrary();
  await screen.findByRole('button', { name: 'Open “file-1.pdf”' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  return screen.getByRole('group', { name: 'Selected assets' });
}

const tick = () => act(() => vi.advanceTimersByTimeAsync(2100));

describe('acting on more assets than a page shows', () => {
  it('publishes them as a job, shows its progress, and names what failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = many(51);
    const bar = await selectAll();
    expect(within(bar).getByText('51 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));

    await waitFor(() => expect(client.startAssetBulkJob).toHaveBeenCalled());
    expect(client.startAssetBulkJob.mock.calls[0]?.[0]).toEqual({
      action: 'publish',
      ids: assets.map((a) => a.id),
    });
    // The tab only watches: no request per asset.
    expect(client.publishAsset).not.toHaveBeenCalled();

    const region = await screen.findByRole('region', { name: 'Bulk job' });
    expect(within(region).getByRole('status').textContent).toBe('Publishing 51 assets…');
    const progress = within(region).getByRole('progressbar', { name: 'Bulk job progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('0');
    expect(within(region).getByText(/keeps running if you close the tab/)).toBeTruthy();
    // While it runs the bar can't start another.
    expect(within(bar).getByRole('button', { name: 'Publish selected' })).toHaveProperty(
      'disabled',
      true,
    );

    client.getBulkJob.mockResolvedValueOnce(job({ completedChunks: 1, succeeded: 25 }));
    await tick();
    // One of two batches: half way.
    await waitFor(() => expect(progress.getAttribute('aria-valuenow')).toBe('50'));

    client.getBulkJob.mockResolvedValueOnce(
      job({ status: 'completed', completedChunks: 2, succeeded: 49, failed: 2 }),
    );
    client.getBulkJobReport.mockResolvedValueOnce({
      job: job(),
      chunks: [
        {
          chunkId: 'c1',
          status: 'completed',
          attempts: 1,
          itemCount: 25,
          failures: [{ id: 'a7', name: 'file-7.pdf', error: 'Asset "a7" is under embargo' }],
        },
        {
          chunkId: 'c2',
          status: 'completed',
          attempts: 1,
          itemCount: 26,
          failures: [{ id: 'a40', name: 'file-40.pdf', error: 'archived' }],
        },
      ],
    });
    await tick();
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe(
        'Published 49 of 51 assets; 2 failed',
      ),
    );
    // Ended with failures: waiting on a person, not stamped as done.
    expect(within(region).getByText('Finished with failures')).toBeTruthy();
    await waitFor(() => expect(client.getBulkJobReport).toHaveBeenCalledWith('job1'));
    const alert = (await screen.findByText('2 assets not published')).closest(
      '[data-slot="alert"]',
    ) as HTMLElement;
    expect(within(alert).getByText('file-7.pdf')).toBeTruthy();
    expect(within(alert).getByText(/under embargo/)).toBeTruthy();
    expect(within(alert).getByText('file-40.pdf')).toBeTruthy();
    // What failed stays selected, to try again; the polling has stopped.
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    const polls = client.getBulkJob.mock.calls.length;
    await tick();
    expect(client.getBulkJob.mock.calls.length).toBe(polls);
  });

  it('stops a running job after asking in place, then says how far it got', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = many(51);
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));
    const region = await screen.findByRole('region', { name: 'Bulk job' });

    // Asked in place, and backing out keeps it running.
    fireEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    const confirm = within(region).getByRole('alertdialog', { name: 'Stop this bulk job?' });
    expect(
      within(confirm).getByText(/Batches already done stay published, and one under way may still/),
    ).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Keep running');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep running' }));
    expect(client.cancelBulkJob).not.toHaveBeenCalled();
    expect(within(region).getByRole('status').textContent).toBe('Publishing 51 assets…');

    fireEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Stop job' }));
    await waitFor(() => expect(client.cancelBulkJob).toHaveBeenCalledWith('job1'));
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe('Stopped: Published 25 assets'),
    );
    expect(within(region).getByText('Cancelled')).toBeTruthy();
    expect(
      within(region).getByText(
        'Stopped after 1 of 2 batches. A batch under way when you stopped may still finish; the library shows what changed.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull();
    // Focus was on the confirm, which went with the job: it lands on Dismiss, not the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Dismiss' })),
    );
    // It no longer polls, and the bar is free again, the selection kept for what never ran.
    const polls = client.getBulkJob.mock.calls.length;
    await tick();
    expect(client.getBulkJob.mock.calls.length).toBe(polls);
    expect(within(bar).getByText('51 selected')).toBeTruthy();
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Publish selected' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
  });

  it('keeps a stopped job stopped when a poll that left before the stop comes back running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = many(51);
    let answer: (j: BulkJobSummary) => void = () => {};
    client.getBulkJob.mockImplementationOnce(
      () => new Promise<BulkJobSummary>((resolve) => (answer = resolve)),
    );
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));
    const region = await screen.findByRole('region', { name: 'Bulk job' });
    // A poll leaves and is still out when the stop lands.
    await tick();
    await waitFor(() => expect(client.getBulkJob).toHaveBeenCalledTimes(1));
    fireEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Stop job' }));
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe('Stopped: Published 25 assets'),
    );
    await act(async () => answer(job({ completedChunks: 1, succeeded: 25 })));
    await tick();
    expect(within(region).getByRole('status').textContent).toBe('Stopped: Published 25 assets');
    expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull();
    // The finish ran once: one toast, one more poll never started.
    expect(screen.getAllByText('Stopped: Published 25 assets')).toHaveLength(2);
    expect(client.getBulkJob).toHaveBeenCalledTimes(1);
  });

  it('says so when a stop is refused, and the job keeps running', async () => {
    assets = many(51);
    client.cancelBulkJob.mockRejectedValueOnce(
      new ApiError(403, 'POST → 403', {
        error: { code: 'forbidden', message: 'Needs content:publish' },
      }),
    );
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));
    const region = await screen.findByRole('region', { name: 'Bulk job' });
    fireEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Stop job' }));
    expect(await screen.findByText(/The job wasn’t stopped/)).toBeTruthy();
    expect(within(region).getByRole('status').textContent).toBe('Publishing 51 assets…');
    expect(within(region).getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);
  });

  it('counts the failures when the role can’t read the job report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = many(51);
    client.startAssetBulkJob.mockResolvedValueOnce(
      job({
        action: 'asset_archive',
        status: 'completed',
        completedChunks: 2,
        succeeded: 48,
        failed: 3,
      }),
    );
    client.getBulkJobReport.mockRejectedValueOnce(new ApiError(403, 'GET → 403'));
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Archive selected' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Archive 51 assets' }));
    await waitFor(() =>
      expect(client.startAssetBulkJob).toHaveBeenCalledWith({
        action: 'archive',
        ids: assets.map((a) => a.id),
      }),
    );
    const alert = (await screen.findByText('3 assets not archived')).closest(
      '[data-slot="alert"]',
    ) as HTMLElement;
    expect(within(alert).getByText(/can’t read the job’s report/)).toBeTruthy();
    expect(client.archiveAsset).not.toHaveBeenCalled();
  });

  it('moves and unpublishes them as jobs too', async () => {
    assets = many(51);
    client.startAssetBulkJob.mockImplementation(async (input: unknown) =>
      job({
        action: (input as { action: string }).action === 'move' ? 'asset_move' : 'asset_unpublish',
        status: 'completed',
        completedChunks: 2,
        succeeded: 51,
      }),
    );
    const bar = await selectAll();
    await waitFor(() =>
      expect(within(bar).getByRole('option', { name: 'Campaigns' })).toBeTruthy(),
    );
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Move to folder' }), {
      target: { value: 'f1' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Move selected' }));
    await waitFor(() =>
      expect(client.startAssetBulkJob).toHaveBeenCalledWith({
        action: 'move',
        ids: assets.map((a) => a.id),
        folderId: 'f1',
      }),
    );
    expect(client.moveAssets).not.toHaveBeenCalled();
    expect(await screen.findByText('Moved 51 assets')).toBeTruthy();

    // A finished job leaves nothing selected; select again for the next action.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Selected assets' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const again = screen.getByRole('group', { name: 'Selected assets' });
    fireEvent.click(within(again).getByRole('button', { name: 'Unpublish selected' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Unpublish 51 assets' }));
    await waitFor(() =>
      expect(client.startAssetBulkJob).toHaveBeenLastCalledWith({
        action: 'unpublish',
        ids: assets.map((a) => a.id),
      }),
    );
    expect(client.unpublishAsset).not.toHaveBeenCalled();
    client.startAssetBulkJob.mockImplementation(async () => job());
  });

  it('says why a job didn’t start', async () => {
    assets = many(51);
    client.startAssetBulkJob.mockRejectedValueOnce(
      new ApiError(403, 'POST → 403', {
        error: { code: 'forbidden', message: 'This needs the content:publish scope' },
      }),
    );
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));
    expect(await screen.findByText('This needs the content:publish scope')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Bulk job' })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Publish selected' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

describe('a selection one page shows', () => {
  it('still publishes in this tab, one request per asset', async () => {
    assets = many(50);
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Publish selected' }));
    expect(await screen.findByText('Published 50 assets')).toBeTruthy();
    expect(client.publishAsset).toHaveBeenCalledTimes(50);
    expect(client.startAssetBulkJob).not.toHaveBeenCalled();
  });

  it('unpublishes after asking in place', async () => {
    assets = many(2);
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: 'Unpublish selected' }));
    expect(client.unpublishAsset).not.toHaveBeenCalled();
    fireEvent.click(within(bar).getByRole('button', { name: 'Unpublish 2 assets' }));
    expect(await screen.findByText('Unpublished 2 assets')).toBeTruthy();
    expect(client.unpublishAsset).toHaveBeenCalledTimes(2);
  });

  it('tags through a job whatever the count, adding or removing the chosen tag', async () => {
    assets = many(2);
    client.startAssetBulkJob.mockResolvedValue(
      job({
        action: 'asset_tag',
        status: 'completed',
        totalItems: 2,
        completedChunks: 1,
        totalChunks: 1,
        succeeded: 2,
      }),
    );
    const bar = await selectAll();
    const add = within(bar).getByRole('button', { name: 'Add tag' });
    expect(add).toHaveProperty('disabled', true);
    await waitFor(() => expect(within(bar).getByRole('option', { name: 'Hero' })).toBeTruthy());
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Tag to add or remove' }), {
      target: { value: 't1' },
    });
    fireEvent.click(add);
    await waitFor(() =>
      expect(client.startAssetBulkJob).toHaveBeenCalledWith({
        action: 'tag',
        ids: ['a1', 'a2'],
        addTags: ['t1'],
      }),
    );
    expect(await screen.findByText('Tagged 2 assets')).toBeTruthy();
    expect(client.setAssetMetadata).not.toHaveBeenCalled();
    client.startAssetBulkJob.mockImplementation(async () => job());
  });
});

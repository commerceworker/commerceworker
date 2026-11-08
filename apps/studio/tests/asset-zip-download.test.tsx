// @vitest-environment jsdom
import type { Asset, AssetCollection } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetZip } from '~/cms/lib/management';

configure({ asyncUtilTimeout: 5000 });

const asset = (id: string, fileName: string): Asset => ({
  id,
  status: 'published',
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
  file: { url: '', fileName, contentType: 'application/pdf' },
});

const zip = (over: Partial<AssetZip> = {}): AssetZip => ({
  id: 'z1',
  status: 'pending',
  source: { kind: 'selection', assetIds: ['a1', 'a2'] },
  fileName: 'assets.zip',
  partsDone: 0,
  createdAt: '',
  expiresAt: '',
  ...over,
});

let collections: AssetCollection[] = [];
const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({
    items: [asset('a1', 'a.pdf'), asset('a2', 'b.pdf')],
  })),
  listAssetFolders: vi.fn(async () => []),
  listTags: vi.fn(async () => []),
  listAssetCollections: vi.fn(async () => ({ items: collections })),
  listAssetCollectionAssets: vi.fn(async () => ({ items: [asset('a1', 'a.pdf')] })),
  startAssetZip: vi.fn(async (_input: unknown) => zip()),
  getAssetZip: vi.fn(async (_id: string) => zip()),
  listShareLinks: vi.fn(async () => []),
  searchAssets: vi.fn(),
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
  collections = [];
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

const tick = () => act(() => vi.advanceTimersByTimeAsync(2100));

/** Selects both assets and asks for a zip; returns the zip's card. */
async function zipSelection() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.setItem('cw.assets.view', 'list');
  renderLibrary();
  await screen.findByRole('button', { name: 'Open “a.pdf”' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  const bar = screen.getByRole('group', { name: 'Selected assets' });
  fireEvent.click(within(bar).getByRole('button', { name: 'Download as zip' }));
  await waitFor(() =>
    expect(client.startAssetZip).toHaveBeenCalledWith({ assetIds: ['a1', 'a2'] }),
  );
  return screen.findByRole('region', { name: 'Zip download' });
}

describe('downloading assets as a zip', () => {
  it('follows the zip as it is built, then offers the download', async () => {
    const region = await zipSelection();
    expect(within(region).getByRole('status').textContent).toBe('Preparing “assets.zip”…');
    const progress = within(region).getByRole('progressbar', { name: 'Zip progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('0');
    expect(within(region).getByText(/keeps going if you close the tab/)).toBeTruthy();

    client.getAssetZip.mockResolvedValueOnce(
      zip({ status: 'running', fileCount: 2, partsDone: 1, partCount: 4 }),
    );
    await tick();
    await waitFor(() => expect(progress.getAttribute('aria-valuenow')).toBe('25'));
    expect(progress.getAttribute('aria-valuetext')).toBe('1 of 4 parts written');
    expect(within(region).getByRole('status').textContent).toBe(
      'Zipping 2 files into “assets.zip”…',
    );

    client.getAssetZip.mockResolvedValueOnce(
      zip({
        status: 'completed',
        fileCount: 2,
        totalBytes: 4096,
        partsDone: 4,
        partCount: 4,
        downloadUrl: 'https://r2.example/assets.zip?sig',
      }),
    );
    await tick();
    const link = await within(region).findByRole('link', { name: 'Download “assets.zip”' });
    expect(link.getAttribute('href')).toBe('https://r2.example/assets.zip?sig');
    expect(within(region).getByRole('status').textContent).toBe(
      '“assets.zip” is ready: 2 files, 4.0 KB',
    );
    expect(await screen.findByText('“assets.zip” is ready to download')).toBeTruthy();
    // Built: no more asking.
    const polls = client.getAssetZip.mock.calls.length;
    await tick();
    expect(client.getAssetZip.mock.calls.length).toBe(polls);

    // A fresh 15-minute link on request.
    client.getAssetZip.mockResolvedValueOnce(
      zip({ status: 'completed', downloadUrl: 'https://r2.example/assets.zip?fresh' }),
    );
    fireEvent.click(within(region).getByRole('button', { name: 'Get a new link' }));
    await waitFor(() =>
      expect(
        within(region).getByRole('link', { name: 'Download “assets.zip”' }).getAttribute('href'),
      ).toBe('https://r2.example/assets.zip?fresh'),
    );
  });

  it('announces a zip that failed, with its reason', async () => {
    const region = await zipSelection();
    client.getAssetZip.mockResolvedValueOnce(
      zip({ status: 'failed', error: 'The archive would pass 20 GiB' }),
    );
    await tick();
    const alert = await within(region).findByRole('alert');
    expect(within(alert).getByText('The zip wasn’t built')).toBeTruthy();
    expect(within(alert).getByText(/would pass 20 GiB/)).toBeTruthy();
    expect(within(region).queryByRole('progressbar')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Zip download' })).toBeNull();
  });

  it('keeps asking through a passing failure, and stops at a refusal', async () => {
    const region = await zipSelection();
    client.getAssetZip.mockRejectedValueOnce(new ApiError(503, 'GET → 503'));
    await tick();
    // Still there, still running.
    expect(within(region).getByRole('status').textContent).toBe('Preparing “assets.zip”…');
    client.getAssetZip.mockRejectedValueOnce(new ApiError(404, 'GET → 404'));
    await tick();
    expect(await screen.findByText(/Stopped following the zip/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Zip download' })).toBeNull());
  });

  it('says why a zip couldn’t start', async () => {
    client.startAssetZip.mockRejectedValueOnce(
      new ApiError(422, 'POST → 422', { error: { message: 'Name between 1 and 1000 assets' } }),
    );
    localStorage.setItem('cw.assets.view', 'list');
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “a.pdf”' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download as zip' }));
    expect(await screen.findByText('Name between 1 and 1000 assets')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Zip download' })).toBeNull();
  });

  it('zips a whole collection by its id, named for it', async () => {
    collections = [{ id: 'c1', name: 'Launch', itemCount: 1, createdAt: '', updatedAt: '' }];
    client.startAssetZip.mockResolvedValueOnce(
      zip({ fileName: 'Launch.zip', source: { kind: 'collection', collectionId: 'c1' } }),
    );
    renderLibrary();
    const nav = screen.getByRole('navigation', { name: 'Collections' });
    fireEvent.click(await within(nav).findByRole('button', { name: 'Launch, 1 asset' }));
    await screen.findByRole('list', { name: 'Assets in “Launch”, in order' });
    fireEvent.click(screen.getByRole('button', { name: 'Download as zip' }));
    await waitFor(() =>
      expect(client.startAssetZip).toHaveBeenCalledWith({ collectionId: 'c1', name: 'Launch' }),
    );
    const region = await screen.findByRole('region', { name: 'Zip download' });
    expect(within(region).getByRole('status').textContent).toBe('Preparing “Launch.zip”…');
  });

  it('keeps a collection’s zip in sight after leaving the collection, so it can be downloaded', async () => {
    collections = [{ id: 'c1', name: 'Launch', itemCount: 1, createdAt: '', updatedAt: '' }];
    client.startAssetZip.mockResolvedValueOnce(
      zip({
        status: 'completed',
        fileName: 'Launch.zip',
        source: { kind: 'collection', collectionId: 'c1' },
        downloadUrl: 'https://r2.example/Launch.zip?sig',
      }),
    );
    renderLibrary();
    const nav = screen.getByRole('navigation', { name: 'Collections' });
    fireEvent.click(await within(nav).findByRole('button', { name: 'Launch, 1 asset' }));
    await screen.findByRole('list', { name: 'Assets in “Launch”, in order' });
    fireEvent.click(screen.getByRole('button', { name: 'Download as zip' }));
    await screen.findByRole('link', { name: 'Download “Launch.zip”' });

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Folders' })).getByRole('button', {
        name: 'All assets',
      }),
    );
    await screen.findByRole('region', { name: 'Asset library' });
    const region = screen.getByRole('region', { name: 'Zip download' });
    expect(within(region).getByRole('link', { name: 'Download “Launch.zip”' })).toBeTruthy();
  });

  it('starts one zip however often Download as zip is pressed while it is asked for', async () => {
    let answer!: (z: AssetZip) => void;
    client.startAssetZip.mockImplementationOnce(
      () => new Promise<AssetZip>((resolve) => (answer = resolve)),
    );
    localStorage.setItem('cw.assets.view', 'list');
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “a.pdf”' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const button = screen.getByRole('button', { name: 'Download as zip' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', true));
    fireEvent.click(button);
    expect(client.startAssetZip).toHaveBeenCalledTimes(1);
    answer(zip());
    await screen.findByRole('region', { name: 'Zip download' });
    expect(client.startAssetZip).toHaveBeenCalledTimes(1);
  });
});

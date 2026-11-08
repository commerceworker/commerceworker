// @vitest-environment jsdom
import type { Asset, AssetFolder, Tag } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * On a CI runner the library's first render can take longer than testing-library's default
 * second (the Unpublish button missed it on PR #36), as the entries list's did: every find and
 * waitFor in this file waits up to five.
 */
configure({ asyncUtilTimeout: 5000 });

const asset = (
  over: Omit<Partial<Asset>, 'file'> & { file?: Partial<Asset['file']> } = {},
): Asset => ({
  id: over.id ?? 'a1',
  status: over.status ?? 'draft',
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
  ...over,
  file: {
    url: 'https://cdn.example/photo.jpg',
    fileName: 'photo.jpg',
    contentType: 'image/jpeg',
    ...over.file,
  },
});

const folder = (id: string, name: string): AssetFolder => ({
  id,
  name,
  path: `/${id}/`,
  createdAt: '',
  updatedAt: '',
});

let assets: Asset[] = [];
let folders: AssetFolder[] = [];
const tags: Tag[] = [{ id: 't1', name: 'Hero' } as Tag];
const client = {
  listAssets: vi.fn(
    async (_q?: unknown) => ({ items: assets }) as { items: Asset[]; nextCursor?: string },
  ),
  listAssetFolders: vi.fn(async () => folders),
  createAssetFolder: vi.fn(async (input: { name: string }) => folder('new', input.name)),
  updateAssetFolder: vi.fn(),
  deleteAssetFolder: vi.fn(),
  listTags: vi.fn(async () => tags),
  listContentTypes: vi.fn(async () => [
    { apiId: 'page', name: 'Page', displayField: 'title', fields: [] },
  ]),
  getEntry: vi.fn(async (id: string) => ({
    id,
    contentType: 'page',
    fields: { title: { 'en-US': 'Home page' } },
  })),
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
  restoreAsset: vi.fn(async () => ({})),
  deleteAsset: vi.fn(async () => undefined),
  moveAssets: vi.fn(async (ids: string[]) => ({ moved: ids.length })),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(async (..._args: unknown[]) => asset()),
  uploadVideo: vi.fn(),
  searchAssets: vi.fn(async (_q: unknown) => ({
    items: assets,
    total: assets.length,
    facets: { kind: {}, tag: {}, folder: {} } as {
      kind: Record<string, number>;
      tag: Record<string, number>;
      folder: Record<string, number>;
    },
  })),
  getAsset: vi.fn(async (id: string) => asset({ id, title: { 'en-US': 'The original' } })),
  reingestAsset: vi.fn(async (id: string) => asset({ id, ingestStatus: 'pending' })),
  setAssetMetadata: vi.fn(async (id: string, _patch: unknown) => asset({ id })),
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
  folders = [];
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

const lastQuery = () => client.listAssets.mock.calls.at(-1)?.[0];

describe('asset unpublish', () => {
  it('offers an Undo that republishes the asset', async () => {
    assets = [
      asset({
        status: 'published',
        title: { 'en-US': 'Hero image' },
        file: { fileName: 'hero.png', contentType: 'application/pdf', url: 'http://x/hero.png' },
      }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish “Hero image”' }));
    await waitFor(() => expect(client.unpublishAsset).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('Unpublished “Hero image”')).toBeTruthy();
    expect(client.publishAsset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.publishAsset).toHaveBeenCalledWith('a1'));
  });
});

describe('AssetLibrary', () => {
  it('is titled Assets', async () => {
    renderLibrary();
    expect(screen.getByRole('heading', { level: 1, name: 'Assets' })).toBeTruthy();
  });

  it('swaps a broken image for a file-type fallback tile with the file name', async () => {
    assets = [asset()];
    renderLibrary();
    const img = await screen.findByRole('img', { name: 'photo.jpg' });
    expect(screen.queryByTestId('asset-fallback')).toBeNull();
    fireEvent.error(img);
    const tile = screen.getByTestId('asset-fallback');
    expect(within(tile).getByText('photo.jpg')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'photo.jpg' })).toBeNull();
  });

  it('shows the fallback tile for non-visual files', async () => {
    assets = [
      asset({ file: { fileName: 'report.pdf', contentType: 'application/pdf', url: 'x' } }),
    ];
    renderLibrary();
    expect(
      within(await screen.findByTestId('asset-fallback')).getByText('report.pdf'),
    ).toBeTruthy();
  });

  it('makes each card a real, named button that opens the detail sheet', async () => {
    assets = [asset()];
    renderLibrary();
    const open = await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    // A native <button>: focusable, Enter/Space-activatable, announced as a button.
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('type')).toBe('button');
    // Publish is a sibling control, not nested inside the open button.
    expect(within(open).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish “photo.jpg”' })).toBeTruthy();
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('exposes tag toggles as pressed/unpressed buttons', async () => {
    assets = [asset({ metadata: { altText: {}, tags: ['t1'] } })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
    const tag = await screen.findByRole('button', { name: 'Hero' });
    expect(tag.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tag);
    expect(tag.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a hosted video with its poster and processing status', async () => {
    assets = [
      asset({
        file: {
          fileName: 'intro.mp4',
          contentType: 'video/mp4',
          url: '',
          video: {
            provider: 'stream',
            videoId: 'v1',
            status: 'processing',
            thumbnailUrl: 'https://cdn.example/poster.jpg',
          },
        },
      }),
    ];
    renderLibrary();
    expect((await screen.findByRole('img', { name: 'intro.mp4' })).getAttribute('src')).toBe(
      'https://cdn.example/poster.jpg',
    );
    expect(screen.getByText('Processing')).toBeTruthy();
  });

  it('uploads video files to the video host, falling back to a blob upload on 501', async () => {
    client.uploadVideo.mockRejectedValueOnce(new ApiError(501, 'not configured'));
    renderLibrary();
    const input = screen.getByLabelText('Upload asset files') as HTMLInputElement;
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.uploadAsset).toHaveBeenCalledWith(file, {}));
    expect(client.uploadVideo).toHaveBeenCalledWith(file);
  });
});

describe('finding assets', () => {
  it('asks the API for what the filter bar and the folder tree say', async () => {
    folders = [folder('f1', 'Campaigns')];
    renderLibrary();
    await waitFor(() => expect(lastQuery()).toEqual({ limit: 50 }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'image' },
    });
    await waitFor(() => expect(lastQuery()).toEqual({ limit: 50, kind: 'image' }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'archived' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'size-desc' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        limit: 50,
        folder: 'f1',
        kind: 'image',
        status: 'archived',
        sort: 'size',
        order: 'desc',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Not in a folder' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ folder: 'root' }));
    expect(
      screen.getByRole('button', { name: 'Not in a folder' }).getAttribute('aria-current'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Not in a folder' }).className).toContain(
      'current-item',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({ limit: 50, folder: 'root', sort: 'size', order: 'desc' }),
    );
  });

  it('loads the next page with the cursor the last one returned', async () => {
    client.listAssets.mockImplementation(async (q?: unknown) =>
      (q as { cursor?: string } | undefined)?.cursor === 'c2'
        ? { items: [asset({ id: 'a2', file: { fileName: 'second.jpg' } })] }
        : { items: [asset()], nextCursor: 'c2' },
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Open “second.jpg”' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open “photo.jpg”' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    client.listAssets.mockImplementation(async () => ({ items: assets }));
  });

  it('switches to a list and remembers it', async () => {
    assets = [asset({ file: { size: 2048 } })];
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(localStorage.getItem('cw.assets.view')).toBe('list');
  });
});

describe('acting on several assets', () => {
  it('moves the selected assets to a folder in one call', async () => {
    folders = [folder('f1', 'Campaigns')];
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    // Labelled as the entries list labels its selection, and a group, not a toolbar (no arrow keys).
    const bar = screen.getByRole('group', { name: 'Selected assets' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    await waitFor(() =>
      expect(within(bar).getByRole('option', { name: 'Campaigns' })).toBeTruthy(),
    );
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Move to folder' }), {
      target: { value: 'f1' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Move selected' }));
    await waitFor(() => expect(client.moveAssets).toHaveBeenCalledWith(['a1', 'a2'], 'f1'));
    expect(await screen.findByText('Moved 2 assets to “Campaigns”')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Selected assets' })).toBeNull();
  });

  it('names the assets a bulk action failed on, keeping just those selected', async () => {
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    client.publishAsset.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'a2') throw new Error('embargoed');
      return {};
    });
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Selected assets' })).getByRole('button', {
        name: 'Publish selected',
      }),
    );
    const alert = await screen.findByText('1 asset not published');
    const box = alert.closest('[data-slot="alert"]') as HTMLElement;
    expect(within(box).getByText('two.jpg')).toBeTruthy();
    expect(within(box).getByText(/embargoed/)).toBeTruthy();
    const bar = screen.getByRole('group', { name: 'Selected assets' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Select “two.jpg”' }) as HTMLElement).getAttribute(
        'data-state',
      ),
    ).toBe('checked');
    expect(
      screen.getByRole('checkbox', { name: 'Select “one.jpg”' }).getAttribute('data-state'),
    ).toBe('unchecked');
    client.publishAsset.mockImplementation(async () => ({}));
  });

  it('asks in place before archiving several, naming how many', async () => {
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    const bar = screen.getByRole('group', { name: 'Selected assets' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Archive selected' }));
    expect(client.archiveAsset).not.toHaveBeenCalled();
    const confirm = within(bar).getByRole('alertdialog', { name: /Archive 2 assets\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive 2 assets' }));
    await waitFor(() => expect(client.archiveAsset).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Archived 2 assets')).toBeTruthy();
  });

  it('publishes each selected asset and reports the tally, failures included', async () => {
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    client.publishAsset.mockRejectedValueOnce(new Error('nope'));
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Selected assets' })).getByRole('button', {
        name: 'Publish selected',
      }),
    );
    expect(await screen.findByText('Published 1 of 2 assets; 1 failed')).toBeTruthy();
    expect(client.publishAsset).toHaveBeenCalledTimes(2);
  });
});

describe('archiving and deleting', () => {
  it('archives with an Undo that restores', async () => {
    assets = [asset()];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive “photo.jpg”' }));
    await waitFor(() => expect(client.archiveAsset).toHaveBeenCalledWith('a1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.restoreAsset).toHaveBeenCalledWith('a1'));
  });

  it('offers Restore on an archived asset', async () => {
    assets = [asset({ status: 'archived' })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore “photo.jpg”' }));
    await waitFor(() => expect(client.restoreAsset).toHaveBeenCalledWith('a1'));
  });

  it('offers Delete only once an asset is archived', async () => {
    assets = [asset()];
    renderLibrary();
    await screen.findByRole('button', { name: 'Archive “photo.jpg”' });
    expect(screen.queryByRole('button', { name: 'Delete “photo.jpg”' })).toBeNull();
  });

  it('asks first, then deletes', async () => {
    assets = [asset({ status: 'archived' })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “photo.jpg”' }));
    const confirm = await screen.findByRole('alertdialog', { name: /Delete “photo.jpg”\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete asset' }));
    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('Deleted “photo.jpg”')).toBeTruthy();
  });

  it('shows the entries that use an asset when the delete is refused', async () => {
    assets = [asset({ status: 'archived' })];
    client.deleteAsset.mockRejectedValueOnce(
      new ApiError(409, 'in use', {
        error: {
          code: 'asset_in_use',
          message: 'used',
          usage: [
            {
              fromEntryId: 'e1',
              fromField: 'hero',
              toId: 'a1',
              toType: 'Asset',
              contentTypeApiId: 'page',
              entryTitle: 'Home page',
            },
          ],
          total: 1,
        },
      }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “photo.jpg”' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete asset' }),
    );
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('“photo.jpg” is used by 1 entry')).toBeTruthy();
    const link = within(notice).getByRole('link', { name: 'Home page' });
    expect(link.getAttribute('href')).toBe('/content/page/e1');
    // The refusal names each entry: nothing is fetched per link.
    expect(client.getEntry).not.toHaveBeenCalled();
    // The confirm that caused it was elsewhere: the notice takes focus, so it is read out.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });
});

describe('an asset in heavy use', () => {
  it('lists the first few links and counts the rest', async () => {
    assets = [asset({ status: 'archived' })];
    const usage = Array.from({ length: 50 }, (_, i) => ({
      fromEntryId: `e${i}`,
      fromField: 'hero',
      toId: 'a1',
      toType: 'Asset',
      contentTypeApiId: 'page',
      entryTitle: `Page ${i}`,
    }));
    client.deleteAsset.mockRejectedValueOnce(
      new ApiError(409, 'in use', {
        error: { code: 'asset_in_use', message: 'used', usage, total: 120 },
      }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “photo.jpg”' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete asset' }),
    );
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('“photo.jpg” is used by 120 entries')).toBeTruthy();
    expect(within(notice).getAllByRole('link')).toHaveLength(5);
    expect(within(notice).getByText('and 115 more')).toBeTruthy();
  });
});

describe('loading the library', () => {
  it('says a failed load failed, with Retry, rather than showing an empty library', async () => {
    client.listAssets.mockRejectedValueOnce(new Error('upstream timed out'));
    renderLibrary();
    expect(await screen.findByText('The assets didn’t load')).toBeTruthy();
    expect(screen.getByText('upstream timed out')).toBeTruthy();
    expect(screen.queryByText('No assets yet')).toBeNull();
    assets = [asset()];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Open “photo.jpg”' })).toBeTruthy();
  });

  it('shows placeholder cards while the first page loads', async () => {
    let finish: () => void = () => {};
    client.listAssets.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = () => r({ items: [] });
        }),
    );
    const { container } = renderLibrary();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading…')).toBeNull();
    finish();
    expect(await screen.findByText('No assets yet')).toBeTruthy();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});

describe('the list view on a phone', () => {
  it('lays rows out itself, names every cell, and gives Open a touch-sized target', async () => {
    localStorage.setItem('cw.assets.view', 'list');
    assets = [asset({ file: { size: 2048 } })];
    renderLibrary();
    const open = await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    expect(open.className).toContain('hit-area');
    const table = screen.getByRole('table');
    expect(table.getAttribute('data-stack')).toBe('rows');
    const cells = within(table).getAllByRole('cell');
    expect(cells.every((c) => c.getAttribute('data-label'))).toBe(true);
  });
});

describe('uploading many files', () => {
  it('uploads every dropped file into the open folder, listing each one’s progress', async () => {
    folders = [folder('f1', 'Campaigns')];
    let finishSecond: () => void = () => {};
    client.uploadAsset.mockImplementation(async (...args: unknown[]) => {
      const file = args[0] as File;
      if (file.name === 'b.png') await new Promise<void>((r) => (finishSecond = r));
      return asset();
    });
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    const region = screen.getByRole('region', { name: 'Asset library' });
    fireEvent.drop(region, { dataTransfer: { files: [a, b], types: ['Files'] } });

    const uploads = await screen.findByRole('region', { name: 'Uploads' });
    await waitFor(() => expect(within(uploads).getByText('Uploading 1 of 2')).toBeTruthy());
    expect(within(uploads).getByText('a.png')).toBeTruthy();
    expect(within(uploads).getByText('Uploaded')).toBeTruthy();
    expect(within(uploads).getByText('Uploading')).toBeTruthy();

    // The summary is a live region, so the batch's progress is read out.
    expect(within(uploads).getByRole('status').textContent).toBe('Uploading 1 of 2');
    finishSecond();
    await waitFor(() =>
      expect(within(uploads).getByRole('status').textContent).toBe('Uploaded 2 files'),
    );
    // And its end is a toast, once.
    const toasts = await screen.findAllByText('Uploaded 2 files');
    const toast = toasts.map((t) => t.closest('output')).find(Boolean) as HTMLElement;
    expect(toast.querySelector('.bg-ok')).not.toBeNull();
    expect(client.uploadAsset).toHaveBeenCalledWith(a, { folderId: 'f1' });
    expect(client.uploadAsset).toHaveBeenCalledWith(b, { folderId: 'f1' });
    client.uploadAsset.mockImplementation(async () => asset());
  });

  it('marks a failed file and keeps going', async () => {
    client.uploadAsset.mockRejectedValueOnce(new Error('too big'));
    renderLibrary();
    const input = screen.getByLabelText('Upload asset files') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png')],
      },
    });
    const uploads = await screen.findByRole('region', { name: 'Uploads' });
    await waitFor(() =>
      expect(within(uploads).getByRole('status').textContent).toBe('Uploaded 1 file; 1 failed'),
    );
    // The toast at the end of the batch is an error, since something failed.
    const toasts = await screen.findAllByText('Uploaded 1 file; 1 failed');
    const toast = toasts.map((t) => t.closest('output')).find(Boolean) as HTMLElement;
    expect(toast.querySelector('.bg-bad')).not.toBeNull();
    expect(within(uploads).getByText('Failed')).toBeTruthy();
    expect(within(uploads).getByText('too big')).toBeTruthy();
  });
});

describe('folders', () => {
  it('creates a folder and opens it', async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), {
      target: { value: 'Brand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(client.createAssetFolder).toHaveBeenCalledWith({ name: 'Brand' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ folder: 'new' }));
  });

  it('nests subfolders as lists inside their parent', async () => {
    folders = [
      folder('f1', 'Brand'),
      { ...folder('f2', 'Logos'), parentId: 'f1', path: '/f1/f2/' },
    ];
    renderLibrary();
    const logos = await screen.findByRole('button', { name: 'Logos' });
    const brandItem = screen.getByRole('button', { name: 'Brand' }).closest('li') as HTMLElement;
    // Logos is an item of a list inside Brand's item: the nesting is in the markup, not padding.
    expect(brandItem.querySelector('ul')?.contains(logos)).toBe(true);
    expect(logos.closest('li')?.parentElement?.closest('li')).toBe(brandItem);
  });

  it('returns focus to the button that opened the name form when it closes', async () => {
    folders = [folder('f1', 'Campaigns')];
    renderLibrary();
    const newFolder = screen.getByRole('button', { name: 'New folder' });
    fireEvent.click(newFolder);
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    fireEvent.keyDown(input, { key: 'Escape' });
    // The form replaced the button; the one drawn again in its place gets focus.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New folder' })),
    );
    expect(newFolder.isConnected).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    const rename = screen.getByRole('button', { name: 'Rename “Campaigns”' });
    fireEvent.click(rename);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Rename “Campaigns”' }),
      ),
    );
  });

  it('focuses a folder once it is created', async () => {
    client.createAssetFolder.mockImplementationOnce(async (input: { name: string }) => {
      folders = [folder('new', input.name)];
      return folder('new', input.name);
    });
    renderLibrary();
    await screen.findByText('No assets yet');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), {
      target: { value: 'Brand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Brand' })),
    );
  });

  it('offers the folders as a select of paths, with the actions in a sheet, for a phone', async () => {
    folders = [
      folder('f1', 'Brand'),
      { ...folder('f2', 'Logos'), parentId: 'f1', path: '/f1/f2/' },
    ];
    renderLibrary();
    const select = screen.getByRole('combobox', { name: 'Folder' });
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Brand / Logos' })).toBeTruthy(),
    );
    fireEvent.change(select, { target: { value: 'f2' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ folder: 'f2' }));

    fireEvent.click(screen.getByRole('button', { name: 'Folder actions' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Rename “Logos”' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'New subfolder' })).toBeTruthy();
  });

  it('says why a folder with something in it was not deleted', async () => {
    folders = [folder('f1', 'Campaigns')];
    client.deleteAssetFolder.mockRejectedValueOnce(new ApiError(409, 'not empty'));
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Campaigns”' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete folder' }),
    );
    expect(
      await screen.findByText('“Campaigns” isn’t empty: move or delete what is in it first'),
    ).toBeTruthy();
  });
});

describe('searching the library', () => {
  const lastSearch = () => client.searchAssets.mock.calls.at(-1)?.[0];

  it('searches once typing pauses, with facet chips that narrow it, and comes back on clear', async () => {
    folders = [folder('f1', 'Campaigns')];
    assets = [asset({ title: { 'en-US': 'Red mug' } })];
    client.searchAssets.mockImplementation(async () => ({
      items: assets,
      total: 1,
      facets: { kind: { image: 1, document: 2 }, tag: { t1: 1 }, folder: { f1: 1, root: 2 } },
    }));
    renderLibrary();
    await waitFor(() => expect(client.listAssets).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assets' }), {
      target: { value: 'mug' },
    });
    await waitFor(() => expect(lastSearch()).toEqual({ q: 'mug', limit: 100 }));
    expect(await screen.findByText('1 match for “mug”')).toBeTruthy();

    const kinds = screen.getByRole('group', { name: 'Kind' });
    const documents = within(kinds).getByRole('button', { name: 'Documents 2 matches' });
    expect(documents.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(documents);
    await waitFor(() => expect(lastSearch()).toEqual({ q: 'mug', limit: 100, kind: 'document' }));
    expect(
      within(screen.getByRole('group', { name: 'Kind' }))
        .getByRole('button', { name: 'Documents 2 matches' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // The filter bar says the same thing the chip did.
    expect(
      (screen.getByRole('combobox', { name: 'Kind' }) as unknown as HTMLSelectElement).value,
    ).toBe('document');

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Tag' })).getByRole('button', {
        name: 'Hero 1 match',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Folder' })).getByRole('button', {
        name: 'Campaigns 1 match',
      }),
    );
    await waitFor(() =>
      expect(lastSearch()).toEqual({
        q: 'mug',
        limit: 100,
        kind: 'document',
        tag: 't1',
        folder: 'f1',
      }),
    );

    const listCalls = client.listAssets.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(client.listAssets.mock.calls.length).toBeGreaterThan(listCalls));
    expect(screen.queryByRole('group', { name: 'Kind' })).toBeNull();
  });

  it('says when nothing matches', async () => {
    client.searchAssets.mockImplementation(async () => ({
      items: [],
      total: 0,
      facets: { kind: {}, tag: {}, folder: {} },
    }));
    renderLibrary();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assets' }), {
      target: { value: 'nothing' },
    });
    expect(await screen.findByText('No matches for “nothing”')).toBeTruthy();
    expect(screen.getByText('No matches')).toBeTruthy();
  });
});

describe('what ingest found', () => {
  it('marks a possible duplicate and opens the original from it', async () => {
    assets = [asset({ id: 'copy', duplicateOf: 'orig', file: { fileName: 'copy.jpg' } })];
    renderLibrary();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Possible duplicate: open the asset “copy.jpg” duplicates',
      }),
    );
    await waitFor(() => expect(client.getAsset).toHaveBeenCalledWith('orig'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows processing, and a failure with its reason and a Retry that re-runs it', async () => {
    assets = [
      asset({ id: 'p', ingestStatus: 'processing', file: { fileName: 'busy.jpg' } }),
      asset({
        id: 'e',
        ingestStatus: 'error',
        ingestError: 'The file is not in storage',
        file: { fileName: 'broken.pdf' },
      }),
    ];
    renderLibrary();
    expect(await screen.findByText('Processing')).toBeTruthy();
    expect(screen.getByText('Processing failed')).toBeTruthy();
    expect(screen.getByText(/The file is not in storage/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing “broken.pdf”' }));
    await waitFor(() => expect(client.reingestAsset).toHaveBeenCalledWith('e'));
    expect(await screen.findByText('Processing “broken.pdf” again')).toBeTruthy();
  });

  it('marks alt text and tags a model filled as AI suggestions until they are changed', async () => {
    assets = [
      asset({
        metadata: { altText: { 'en-US': 'A red mug' }, tags: ['t1'] },
        aiSuggestions: { altText: ['en-US'], tags: ['t1'] },
      }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: /Hero/ });
    expect(within(dialog).getAllByText('AI suggestion')).toHaveLength(2);
    fireEvent.change(within(dialog).getByLabelText('Alt text (en-US)'), {
      target: { value: 'A red mug on a shelf' },
    });
    expect(within(dialog).getAllByText('AI suggestion')).toHaveLength(1);
  });

  it('marks nothing an editor wrote', async () => {
    assets = [asset({ metadata: { altText: { 'en-US': 'Mine' }, tags: ['t1'] } })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Hero' });
    expect(within(dialog).queryByText('AI suggestion')).toBeNull();
  });
});

describe('unsaved edits in the detail sheet', () => {
  const openSheet = async (name: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `Open “${name}”` }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: /Hero/ });
    return dialog;
  };
  const altBox = (dialog: HTMLElement) =>
    within(dialog).getByLabelText('Alt text (en-US)') as HTMLTextAreaElement;

  it('keeps what was typed when Retry brings the same asset back, and the list with it', async () => {
    assets = [
      asset({
        id: 'e',
        ingestStatus: 'error',
        ingestError: 'Timed out',
        file: { fileName: 'b.jpg' },
      }),
    ];
    renderLibrary();
    const dialog = await openSheet('b.jpg');
    fireEvent.change(altBox(dialog), { target: { value: 'Typed, not saved' } });
    // The server's copy changes meanwhile; the refetch that follows Retry must not overwrite.
    assets = [
      asset({
        id: 'e',
        ingestStatus: 'pending',
        metadata: { altText: { 'en-US': 'Server' }, tags: [] },
        file: { fileName: 'b.jpg' },
      }),
    ];
    const listCalls = client.listAssets.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry processing “b.jpg”' }));
    await waitFor(() => expect(client.reingestAsset).toHaveBeenCalledWith('e'));
    await waitFor(() => expect(client.listAssets.mock.calls.length).toBeGreaterThan(listCalls));
    await waitFor(() => expect(within(dialog).getByText('Processing')).toBeTruthy());
    expect(altBox(dialog).value).toBe('Typed, not saved');
  });

  it('keeps what was typed when a poll finds ingest finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = [asset({ id: 'p', ingestStatus: 'processing', file: { fileName: 'busy.jpg' } })];
    renderLibrary();
    const dialog = await openSheet('busy.jpg');
    fireEvent.change(altBox(dialog), { target: { value: 'Mine' } });
    assets = [
      asset({
        id: 'p',
        ingestStatus: 'ready',
        metadata: { altText: { 'en-US': 'From the model' }, tags: [] },
        file: { fileName: 'busy.jpg' },
      }),
    ];
    const listCalls = client.listAssets.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(4500));
    await waitFor(() => expect(client.listAssets.mock.calls.length).toBeGreaterThan(listCalls));
    await waitFor(() => expect(within(dialog).queryByText('Processing')).toBeNull());
    expect(altBox(dialog).value).toBe('Mine');
  });

  it('stops polling once nothing shown is processing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    assets = [asset({ id: 'r', ingestStatus: 'ready' })];
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    const listCalls = client.listAssets.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(client.listAssets.mock.calls.length).toBe(listCalls);
  });

  it('asks before the duplicate badge replaces unsaved edits, and opens the original on yes', async () => {
    assets = [asset({ id: 'copy', duplicateOf: 'orig', file: { fileName: 'copy.jpg' } })];
    renderLibrary();
    const dialog = await openSheet('copy.jpg');
    fireEvent.change(altBox(dialog), { target: { value: 'Half written' } });
    const badge = () =>
      within(dialog).getByRole('button', {
        name: 'Possible duplicate: open the asset “copy.jpg” duplicates',
      });
    fireEvent.click(badge());
    const ask = within(dialog).getByRole('alertdialog', {
      name: 'Open the original and discard your changes?',
    });
    expect(client.getAsset).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).queryByRole('alertdialog')).toBeNull();
    expect(altBox(dialog).value).toBe('Half written');

    fireEvent.click(badge());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and open' }));
    await waitFor(() => expect(client.getAsset).toHaveBeenCalledWith('orig'));
    await waitFor(() => expect(altBox(screen.getByRole('dialog')).value).toBe(''));
  });

  it('opens the original at once from the badge when nothing was edited', async () => {
    assets = [asset({ id: 'copy', duplicateOf: 'orig', file: { fileName: 'copy.jpg' } })];
    renderLibrary();
    const dialog = await openSheet('copy.jpg');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Possible duplicate: open the asset “copy.jpg” duplicates',
      }),
    );
    await waitFor(() => expect(client.getAsset).toHaveBeenCalledWith('orig'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('saves without accepting AI suggestions it did not touch', async () => {
    assets = [
      asset({
        metadata: { altText: { 'en-US': 'A red mug' }, tags: ['t1'] },
        aiSuggestions: { altText: ['en-US'], tags: ['t1'] },
      }),
    ];
    renderLibrary();
    const dialog = await openSheet('photo.jpg');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save metadata' }));
    await waitFor(() => expect(client.setAssetMetadata).toHaveBeenCalled());
    const patch = client.setAssetMetadata.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('altText' in patch).toBe(false);
    expect('tags' in patch).toBe(false);
  });

  it('sends only the field that changed', async () => {
    assets = [
      asset({
        metadata: { altText: { 'en-US': 'A red mug' }, tags: ['t1'] },
        aiSuggestions: { altText: ['en-US'], tags: ['t1'] },
      }),
    ];
    renderLibrary();
    const dialog = await openSheet('photo.jpg');
    fireEvent.change(altBox(dialog), { target: { value: 'A red mug on a shelf' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save metadata' }));
    await waitFor(() => expect(client.setAssetMetadata).toHaveBeenCalled());
    const patch = client.setAssetMetadata.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.altText).toEqual({ 'en-US': 'A red mug on a shelf' });
    expect('tags' in patch).toBe(false);
  });

  it('marks an AI-suggested tag in sight, not only to a screen reader', async () => {
    assets = [asset({ metadata: { altText: {}, tags: ['t1'] }, aiSuggestions: { tags: ['t1'] } })];
    renderLibrary();
    const dialog = await openSheet('photo.jpg');
    const tag = within(dialog).getByRole('button', { name: /Hero/ });
    expect(within(tag).getByText('AI').getAttribute('aria-hidden')).toBe('true');
    expect(within(tag).getByText('(AI suggestion)')).toBeTruthy();
  });

  it('reads a failure reason once, in the sheet as in the grid', async () => {
    assets = [
      asset({
        id: 'e',
        ingestStatus: 'error',
        ingestError: 'Timed out',
        file: { fileName: 'b.jpg' },
      }),
    ];
    renderLibrary();
    expect(await screen.findAllByText('Timed out')).toHaveLength(1);
    const dialog = await openSheet('b.jpg');
    expect(within(dialog).getAllByText(/Timed out/)).toHaveLength(1);
  });
});

describe('searching with a selection', () => {
  it('clears the selection and its failures when the search changes', async () => {
    assets = [asset({ id: 'a1', file: { fileName: 'one.jpg' } })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    expect(screen.getByRole('group', { name: 'Selected assets' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assets' }), {
      target: { value: 'two' },
    });
    expect(screen.queryByRole('group', { name: 'Selected assets' })).toBeNull();
  });

  it('says Searching… and is busy while the next results load, in an always-present live line', async () => {
    let resolve: (v: unknown) => void = () => {};
    client.searchAssets.mockImplementationOnce(
      () => new Promise((r) => (resolve = r as (v: unknown) => void)) as never,
    );
    renderLibrary();
    await waitFor(() => expect(client.listAssets).toHaveBeenCalled());
    const live = document.querySelector('p[aria-live="polite"].text-ui');
    expect(live).toBeTruthy();
    expect(live?.textContent).toBe('');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assets' }), {
      target: { value: 'mug' },
    });
    await waitFor(() => expect(live?.textContent).toBe('Searching…'));
    expect(live?.getAttribute('aria-busy')).toBe('true');
    // "Searching…" renders as the search turns on, but the query calls searchAssets from an
    // effect after it: settle the search only once that call holds the promise's resolver.
    await waitFor(() => expect(client.searchAssets).toHaveBeenCalledTimes(1));
    resolve({ items: [], total: 0, facets: { kind: {}, tag: {}, folder: {} } });
    // A busy CI runner can take over the default second to render the settled search.
    await waitFor(() => expect(live?.textContent).toBe('No matches for “mug”'), {
      timeout: 5000,
    });
    expect(live?.getAttribute('aria-busy')).toBeNull();
  });
});

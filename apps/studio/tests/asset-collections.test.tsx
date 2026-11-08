// @vitest-environment jsdom
import type { Asset, AssetCollection } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** As in asset-library.test.tsx: a CI runner's first render can outlast the default second. */
configure({ asyncUtilTimeout: 5000 });

const asset = (id: string, fileName: string, status: Asset['status'] = 'published'): Asset => ({
  id,
  status,
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
  file: { url: '', fileName, contentType: 'application/pdf' },
});

const collection = (over: Partial<AssetCollection> = {}): AssetCollection => ({
  id: 'c1',
  name: 'Launch',
  description: 'Spring campaign',
  itemCount: 3,
  createdAt: '',
  updatedAt: '',
  ...over,
});

let library: Asset[] = [];
let collections: AssetCollection[] = [];
let members: Asset[] = [];
let folders: { id: string; name: string; path: string; createdAt: string; updatedAt: string }[] =
  [];
const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({ items: library })),
  listAssetFolders: vi.fn(async () => folders),
  listTags: vi.fn(async () => []),
  listAssetCollections: vi.fn(async (_q?: unknown) => ({ items: collections })),
  listAssetCollectionAssets: vi.fn(async (_id: string, _q?: unknown) => ({ items: members })),
  createAssetCollection: vi.fn(async (input: { name: string; description?: string }) => {
    const made = collection({ id: 'c2', itemCount: 0, ...input });
    collections = [...collections, made];
    return made;
  }),
  updateAssetCollection: vi.fn(async (_id: string, patch: object) => ({
    ...collection(),
    ...patch,
  })),
  deleteAssetCollection: vi.fn(async () => {
    collections = [];
  }),
  addToAssetCollection: vi.fn(async (_id: string, ids: readonly string[]) => ({
    added: ids.length,
    skipped: [] as string[],
  })),
  removeFromAssetCollection: vi.fn(async (_id: string, ids: readonly string[]) => {
    members = members.filter((a) => !ids.includes(a.id));
    return { removed: ids.length };
  }),
  reorderAssetCollection: vi.fn(async (_id: string, _ids: readonly string[]) => {}),
  startAssetZip: vi.fn(),
  getAssetZip: vi.fn(),
  listShareLinks: vi.fn(async () => []),
  assetUsage: vi.fn(async () => []),
  listAssetVersions: vi.fn(async () => []),
  getTeam: vi.fn(async () => ({ people: [], keys: [], adminCount: 1, settings: {} })),
  searchAssets: vi.fn(),
  uploadAsset: vi.fn(async (_file: File, _opts?: { folderId?: string }) => asset('n1', 'new.pdf')),
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
  vi.clearAllMocks();
  library = [];
  collections = [];
  members = [];
  folders = [];
  client.reorderAssetCollection.mockReset();
  client.reorderAssetCollection.mockImplementation(async () => {});
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

/** Opens "Launch" (holding a.pdf, b.pdf, c.pdf) from the sidebar; returns its ordered list. */
async function openLaunch() {
  collections = [collection()];
  members = [asset('a1', 'a.pdf'), asset('a2', 'b.pdf'), asset('a3', 'c.pdf', 'draft')];
  renderLibrary();
  const nav = screen.getByRole('navigation', { name: 'Collections' });
  fireEvent.click(await within(nav).findByRole('button', { name: 'Launch, 3 assets' }));
  return screen.findByRole('list', { name: 'Assets in “Launch”, in order' });
}

const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole('button', { name: /^Open/ })
    .map((b) => b.textContent);

describe('asset collections', () => {
  it('lists the collections beside the folders and makes one, which opens with focus', async () => {
    renderLibrary();
    const nav = screen.getByRole('navigation', { name: 'Collections' });
    expect(await within(nav).findByText(/Gather assets from any folder/)).toBeTruthy();
    // Two at once in jsdom (a phone's icon button, and the list's): the list's has words.
    const create = within(nav)
      .getAllByRole('button', { name: 'New collection' })
      .find((b) => b.textContent?.includes('New collection')) as HTMLElement;
    fireEvent.click(create);
    const form = within(nav).getByRole('form', { name: 'New collection' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Launch' } });
    fireEvent.change(within(form).getByLabelText(/Description/), {
      target: { value: 'Spring' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create collection' }));

    await waitFor(() =>
      expect(client.createAssetCollection).toHaveBeenCalledWith({
        name: 'Launch',
        description: 'Spring',
      }),
    );
    const heading = await screen.findByRole('heading', { name: 'Launch' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(await screen.findByText('Nothing in this collection yet')).toBeTruthy();
    // The library gave way to it: no folder is current while a collection is open.
    expect(screen.queryByRole('region', { name: 'Asset library' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Launch, 0 assets' })).toHaveProperty(
      'ariaCurrent',
      'true',
    );
  });

  it('shows the assets in its order, every status included', async () => {
    const list = await openLaunch();
    expect(names(list)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(client.listAssetCollectionAssets).toHaveBeenCalledWith('c1', {
      status: 'all',
      limit: 100,
    });
    expect(screen.getByText('Spring campaign')).toBeTruthy();
  });

  it('reorders with the move buttons: sends the whole order, keeps focus, and says where it went', async () => {
    const list = await openLaunch();
    const down = within(list).getByRole('button', { name: 'Move “a.pdf” down' });
    down.focus();
    fireEvent.click(down);
    expect(names(list)).toEqual(['b.pdf', 'a.pdf', 'c.pdf']);
    await waitFor(() =>
      expect(client.reorderAssetCollection).toHaveBeenCalledWith('c1', ['a2', 'a1', 'a3']),
    );
    expect(screen.getByText('“a.pdf” moved to position 2 of 3')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(list).getByRole('button', { name: 'Move “a.pdf” down' }),
      ),
    );

    // Moved to the bottom, its Move down is disabled: focus stays on the row, on Move up.
    fireEvent.click(within(list).getByRole('button', { name: 'Move “a.pdf” down' }));
    expect(names(list)).toEqual(['b.pdf', 'c.pdf', 'a.pdf']);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(list).getByRole('button', { name: 'Move “a.pdf” up' }),
      ),
    );
    await waitFor(() =>
      expect(client.reorderAssetCollection).toHaveBeenLastCalledWith('c1', ['a2', 'a3', 'a1']),
    );
    expect(within(list).getByRole('button', { name: 'Move “b.pdf” up' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('reorders by dragging a row onto another', async () => {
    const list = await openLaunch();
    const rows = within(list).getAllByRole('listitem');
    fireEvent.dragStart(rows[2] as HTMLElement);
    fireEvent.dragOver(rows[0] as HTMLElement);
    fireEvent.drop(rows[0] as HTMLElement);
    expect(names(list)).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
    await waitFor(() =>
      expect(client.reorderAssetCollection).toHaveBeenCalledWith('c1', ['a3', 'a1', 'a2']),
    );
  });

  it('puts the server’s order back when a reorder is refused', async () => {
    const list = await openLaunch();
    client.reorderAssetCollection.mockRejectedValueOnce(new ApiError(403, 'PUT → 403'));
    fireEvent.click(within(list).getByRole('button', { name: 'Move “c.pdf” up' }));
    expect(names(list)).toEqual(['a.pdf', 'c.pdf', 'b.pdf']);
    expect(await screen.findByText(/The new order wasn’t saved/)).toBeTruthy();
    await waitFor(() => expect(names(list)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']));
  });

  it('removes an asset from the collection only, and focus goes to the next row', async () => {
    const list = await openLaunch();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “a.pdf” from “Launch”' }));
    await waitFor(() =>
      expect(client.removeFromAssetCollection).toHaveBeenCalledWith('c1', ['a1']),
    );
    await waitFor(() => expect(names(list)).toEqual(['b.pdf', 'c.pdf']));
    expect(await screen.findByText('Removed “a.pdf” from “Launch”')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(list).getByRole('button', { name: 'Open “b.pdf”' }),
      ),
    );
  });

  it('renames it and clears its description', async () => {
    await openLaunch();
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Launch”' }));
    const form = screen.getByRole('form', { name: 'Edit “Launch”' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Launch 2' } });
    fireEvent.change(within(form).getByLabelText(/Description/), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(client.updateAssetCollection).toHaveBeenCalledWith('c1', {
        name: 'Launch 2',
        description: '',
      }),
    );
  });

  it('deletes it after asking in a modal, and goes back to the library', async () => {
    await openLaunch();
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Launch”' }));
    const confirm = await screen.findByRole('alertdialog', { name: /Delete “Launch”\?/ });
    expect(within(confirm).getByText(/assets stay in the library/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete collection' }));
    await waitFor(() => expect(client.deleteAssetCollection).toHaveBeenCalledWith('c1'));
    expect(await screen.findByRole('region', { name: 'Asset library' })).toBeTruthy();
  });

  it('adds the library’s selection to a collection from the bulk bar', async () => {
    collections = [collection()];
    library = [asset('a1', 'a.pdf'), asset('a2', 'b.pdf'), asset('a9', 'z.pdf')];
    client.addToAssetCollection.mockResolvedValueOnce({ added: 1, skipped: ['a9'] });
    localStorage.setItem('cw.assets.view', 'list');
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “a.pdf”' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const bar = screen.getByRole('group', { name: 'Selected assets' });
    await waitFor(() => expect(within(bar).getByRole('option', { name: 'Launch' })).toBeTruthy());
    const add = within(bar).getByRole('button', { name: 'Add to collection' });
    // Nothing chosen yet: nothing to add to.
    expect(add).toHaveProperty('disabled', true);
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Collection to add to' }), {
      target: { value: 'c1' },
    });
    fireEvent.click(add);
    await waitFor(() =>
      expect(client.addToAssetCollection).toHaveBeenCalledWith('c1', ['a1', 'a2', 'a9']),
    );
    expect(
      await screen.findByText(
        'Added 1 asset to “Launch”; 1 already in it, 1 no longer in the library',
      ),
    ).toBeTruthy();
    // Done: the selection is cleared.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Selected assets' })).toBeNull(),
    );
  });

  it('says why an add was refused, and keeps the selection', async () => {
    collections = [collection()];
    library = [asset('a1', 'a.pdf')];
    client.addToAssetCollection.mockRejectedValueOnce(
      new ApiError(409, 'POST → 409', {
        error: { code: 'conflict', message: 'A collection holds at most 1000 assets' },
      }),
    );
    localStorage.setItem('cw.assets.view', 'list');
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “a.pdf”' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “a.pdf”' }));
    const bar = screen.getByRole('group', { name: 'Selected assets' });
    await waitFor(() => expect(within(bar).getByRole('option', { name: 'Launch' })).toBeTruthy());
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Collection to add to' }), {
      target: { value: 'c1' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Add to collection' }));
    expect(await screen.findByText('A collection holds at most 1000 assets')).toBeTruthy();
    expect(within(bar).getByText('1 selected')).toBeTruthy();
  });

  // Rendering 600 rows in jsdom takes most of a second here and far longer on a loaded CI runner.
  it('sends the whole loaded order in one reorder, past the 500 an add takes', {
    timeout: 30_000,
  }, async () => {
    collections = [collection({ itemCount: 600 })];
    members = Array.from({ length: 600 }, (_, i) => asset(`m${i}`, `m-${i}.pdf`));
    renderLibrary();
    const nav = screen.getByRole('navigation', { name: 'Collections' });
    fireEvent.click(await within(nav).findByRole('button', { name: 'Launch, 600 assets' }));
    const list = await screen.findByRole('list', { name: 'Assets in “Launch”, in order' });
    // Look in the first row only: a role-and-name query over 600 rows computes every button's
    // accessible name, and that alone outlasted the 15 s timeout on CI.
    const [first] = within(list).getAllByRole('listitem');
    if (!first) throw new Error('the collection rendered no rows');
    fireEvent.click(within(first).getByRole('button', { name: 'Move “m-0.pdf” down' }));
    await waitFor(() => expect(client.reorderAssetCollection).toHaveBeenCalledTimes(1));
    const sent = client.reorderAssetCollection.mock.calls[0]?.[1] as string[];
    expect(sent).toHaveLength(600);
    expect(sent.slice(0, 3)).toEqual(['m1', 'm0', 'm2']);
  });

  it('reads the order back from the server when a reorder is refused', async () => {
    const list = await openLaunch();
    client.reorderAssetCollection.mockImplementationOnce(async () => {
      // Someone else reordered it meanwhile: the server's order is neither the old nor the new.
      members = [members[2], members[1], members[0]] as Asset[];
      throw new ApiError(409, 'PUT → 409');
    });
    fireEvent.click(within(list).getByRole('button', { name: 'Move “a.pdf” down' }));
    expect(await screen.findByText(/The new order wasn’t saved/)).toBeTruthy();
    await waitFor(() => expect(names(list)).toEqual(['c.pdf', 'b.pdf', 'a.pdf']));
  });

  it('never brings a removed asset back when a later reorder is refused', async () => {
    const list = await openLaunch();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “a.pdf” from “Launch”' }));
    await waitFor(() => expect(names(list)).toEqual(['b.pdf', 'c.pdf']));
    client.reorderAssetCollection.mockRejectedValueOnce(new ApiError(503, 'PUT → 503'));
    fireEvent.click(within(list).getByRole('button', { name: 'Move “c.pdf” up' }));
    expect(await screen.findByText(/The new order wasn’t saved/)).toBeTruthy();
    await waitFor(() => expect(names(list)).toEqual(['b.pdf', 'c.pdf']));
  });

  it('sends a remove only after the reorder before it has been answered', async () => {
    const list = await openLaunch();
    let answer!: () => void;
    client.reorderAssetCollection.mockImplementationOnce(
      () => new Promise<void>((resolve) => (answer = resolve)),
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Move “a.pdf” down' }));
    await waitFor(() => expect(client.reorderAssetCollection).toHaveBeenCalledTimes(1));
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “c.pdf” from “Launch”' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(client.removeFromAssetCollection).not.toHaveBeenCalled();
    answer();
    await waitFor(() =>
      expect(client.removeFromAssetCollection).toHaveBeenCalledWith('c1', ['a3']),
    );
    await waitFor(() => expect(names(list)).toEqual(['b.pdf', 'a.pdf']));
  });

  it('uploads into the open collection: filed at the root, then added to it', async () => {
    folders = [{ id: 'f1', name: 'Campaigns', path: '/f1/', createdAt: '', updatedAt: '' }];
    collections = [collection()];
    members = [asset('a1', 'a.pdf')];
    renderLibrary();
    // A folder was open before the collection: the upload must not land in it, out of sight.
    const tree = screen.getByRole('navigation', { name: 'Folders' });
    fireEvent.click(await within(tree).findByRole('button', { name: 'Campaigns' }));
    const nav = screen.getByRole('navigation', { name: 'Collections' });
    fireEvent.click(await within(nav).findByRole('button', { name: 'Launch, 3 assets' }));
    await screen.findByRole('list', { name: 'Assets in “Launch”, in order' });
    expect(screen.getByRole('button', { name: 'Upload to “Launch”' })).toBeTruthy();

    const file = new File(['x'], 'new.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Upload asset files'), { target: { files: [file] } });
    const region = await screen.findByRole('region', { name: 'Uploads' });
    expect(within(region).getByText(/Into the collection “Launch”/)).toBeTruthy();
    await waitFor(() => expect(client.addToAssetCollection).toHaveBeenCalledWith('c1', ['n1']));
    expect(client.uploadAsset).toHaveBeenCalledWith(file, {});
    expect(await screen.findByText('Added 1 asset to “Launch”')).toBeTruthy();
  });
});

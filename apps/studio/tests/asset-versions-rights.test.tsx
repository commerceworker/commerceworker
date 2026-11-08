// @vitest-environment jsdom
import type { Asset, AssetVersion } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** As in asset-library.test.tsx: a CI runner's first render can outlast the default second. */
configure({ asyncUtilTimeout: 5000 });

const DAY = 24 * 60 * 60 * 1000;

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

const version = (n: number, over: Partial<AssetVersion> = {}): AssetVersion => ({
  version: n,
  file: {
    url: `https://cdn.example/v${n}.jpg`,
    fileName: `photo-v${n}.jpg`,
    contentType: 'image/jpeg',
    size: 2048 * n,
  },
  createdAt: new Date(Date.now() - n * 60_000).toISOString(),
  // As the api records a person: their id, which the team turns into a name.
  createdBy: 'u-ada',
  current: false,
  published: false,
  ...over,
});

let assets: Asset[] = [];
let versions: AssetVersion[] = [];
const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({ items: assets })),
  listAssetFolders: vi.fn(async () => []),
  listTags: vi.fn(async () => []),
  assetUsage: vi.fn(async () => []),
  publishAsset: vi.fn(async (id: string) => asset({ id, status: 'published' })),
  unpublishAsset: vi.fn(async () => ({})),
  archiveAsset: vi.fn(async () => ({})),
  restoreAsset: vi.fn(async () => ({})),
  deleteAsset: vi.fn(),
  moveAssets: vi.fn(),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(),
  uploadVideo: vi.fn(),
  searchAssets: vi.fn(),
  getAsset: vi.fn(),
  reingestAsset: vi.fn(),
  setAssetMetadata: vi.fn(),
  listAssetVersions: vi.fn(async (_id: string) => versions),
  getTeam: vi.fn(async () => ({
    people: [{ id: 'u-ada', email: 'ada@example.com', name: 'Ada' }],
    keys: [],
    adminCount: 1,
    settings: { ssoOnly: false },
  })),
  replaceAssetFile: vi.fn(async (id: string, _file: File) => asset({ id, version: 3 })),
  // A replacement in parts: two parts of 150 MiB.
  startAssetFileUpload: vi.fn(async (id: string, _input: unknown) => ({
    asset: asset({ id }),
    version: 3,
    upload: { uploadId: 'r1', partSize: 150 * 1024 * 1024, partCount: 2 },
  })),
  signAssetUploadParts: vi.fn(async (_id: string, _u: string, numbers: readonly number[]) => ({
    parts: numbers.map((n) => ({
      partNumber: n,
      url: `https://r2.example/p${n}`,
      length: n === 1 ? 150 * 1024 * 1024 : 50 * 1024 * 1024,
      expiresAt: 'x',
    })),
  })),
  putUploadPart: vi.fn(async (url: string, _bytes: Blob, _signal?: AbortSignal) => `"${url}"`),
  completeAssetUpload: vi.fn(async (id: string) => asset({ id, version: 3 })),
  abortAssetUpload: vi.fn(async () => undefined),
  restoreAssetVersion: vi.fn(async (id: string, _v: number) => asset({ id, version: 4 })),
  setAssetRights: vi.fn(async (id: string, rights: Record<string, string | null>) =>
    asset({
      id,
      rights: Object.fromEntries(Object.entries(rights).filter(([, v]) => v !== null)),
    }),
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
const { ApiError, RequestTimeoutError } = await import('~/cms/lib/management');

afterEach(() => {
  vi.clearAllMocks();
  assets = [];
  versions = [];
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

/** Opens the sheet on `name` and switches it to `tab` (Radix tabs activate on mouse down). */
async function openTab(name: string, tab: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Open “${name}”` }));
  const sheet = await screen.findByRole('dialog');
  const trigger = within(sheet).getByRole('tab', { name: tab });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  await waitFor(() => expect(trigger.getAttribute('aria-selected')).toBe('true'));
  return sheet;
}

describe('the asset sheet’s tabs', () => {
  it('opens on Details, with Save metadata there and only there', async () => {
    assets = [asset()];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
    const sheet = await screen.findByRole('dialog');
    const tabs = within(sheet)
      .getAllByRole('tab')
      .map((t) => t.textContent);
    expect(tabs).toEqual(['Details', 'Versions', 'Usage', 'Renditions', 'Rights']);
    expect(within(sheet).getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(sheet).getByLabelText('Alt text (en-US)')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Save metadata' })).toBeTruthy();
    const usage = within(sheet).getByRole('tab', { name: 'Usage' });
    fireEvent.mouseDown(usage);
    expect(await within(sheet).findByText('Not referenced by any entry.')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Save metadata' })).toBeNull();
  });
});

describe('the Versions tab', () => {
  it('lists every file newest first, marking current, published and restored', async () => {
    assets = [asset({ status: 'published', version: 3 })];
    versions = [
      version(3, { current: true, published: true, restoredFrom: 1 }),
      version(2),
      version(1, { createdBy: 'cma' }),
    ];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    const list = await within(sheet).findByRole('list', { name: 'File versions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/^v\d$/).textContent)).toEqual(['v3', 'v2', 'v1']);
    const top = rows[0] as HTMLElement;
    expect(within(top).getByText('photo-v3.jpg')).toBeTruthy();
    expect(within(top).getByText('Current')).toBeTruthy();
    expect(within(top).getByText('Published')).toBeTruthy();
    expect(within(top).getByText('Restored from v1')).toBeTruthy();
    expect(within(top).getByText(/6\.0 KB/)).toBeTruthy();
    // A person by name, never their id; a key by kind.
    await waitFor(() => expect(within(top).getByText(/by Ada$/)).toBeTruthy());
    expect(within(rows[2] as HTMLElement).getByText(/by an API key/)).toBeTruthy();
    // The current file can't be restored over itself; the others can.
    expect(within(top).queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Restore version 2' }));
    // Delivery serves the current file: nothing to republish.
    expect(within(sheet).queryByText(/Delivery serves version/)).toBeNull();
  });

  it('replaces the file, saying so while it uploads, and lists the new version', async () => {
    assets = [asset({ version: 2 })];
    versions = [version(2, { current: true }), version(1)];
    let finish: (a: Asset) => void = () => {};
    client.replaceAssetFile.mockImplementationOnce(
      () => new Promise<Asset>((resolve) => (finish = resolve)),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    await within(sheet).findByRole('list', { name: 'File versions' });
    const file = new File(['new bytes'], 'photo-new.jpg', { type: 'image/jpeg' });
    fireEvent.change(within(sheet).getByLabelText('Replacement file'), {
      target: { files: [file] },
    });
    expect(await within(sheet).findByText('Uploading “photo-new.jpg”…')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Replace file' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(client.replaceAssetFile).toHaveBeenCalledWith('a1', file);

    versions = [version(3, { current: true }), version(2), version(1)];
    finish(asset({ version: 3 }));
    expect(
      await screen.findByText('Replaced the file with “photo-new.jpg” (version 3)'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(within(sheet).getAllByRole('listitem')[0]?.textContent).toContain('v3'),
    );
    expect(within(sheet).queryByText(/Uploading/)).toBeNull();
    expect(client.listAssetVersions).toHaveBeenCalledTimes(2);
  });

  /** A file past one signed PUT, without holding its bytes: jsdom's File reports what it's told. */
  const bigFile = (name: string) => {
    const file = new File(['x'], name, { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });
    return file;
  };

  it('replaces a file past 100 MiB in parts, showing the bytes stored, then the new version', async () => {
    assets = [asset({ version: 2 })];
    versions = [version(2, { current: true }), version(1)];
    let release: () => void = () => {};
    client.putUploadPart.mockImplementation(async (url: string) => {
      if (url.endsWith('p2')) await new Promise<void>((r) => (release = r));
      return `"${url}"`;
    });
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    await within(sheet).findByRole('list', { name: 'File versions' });
    fireEvent.change(within(sheet).getByLabelText('Replacement file'), {
      target: { files: [bigFile('cut.mp4')] },
    });
    expect(
      await within(sheet).findByText('150 MB of 200 MB · 1 of 2 parts', { exact: false }),
    ).toBeTruthy();
    expect(within(sheet).getByRole('progressbar', { name: 'Uploading “cut.mp4”' })).toBeTruthy();
    expect(client.replaceAssetFile).not.toHaveBeenCalled();
    expect(client.startAssetFileUpload).toHaveBeenCalledWith('a1', {
      fileName: 'cut.mp4',
      contentType: 'video/mp4',
      size: 200 * 1024 * 1024,
    });
    versions = [version(3, { current: true }), version(2), version(1)];
    release();
    expect(await screen.findByText('Replaced the file with “cut.mp4” (version 3)')).toBeTruthy();
    expect(client.completeAssetUpload).toHaveBeenCalledWith('a1', 'r1', [
      { partNumber: 1, etag: '"https://r2.example/p1"' },
      { partNumber: 2, etag: '"https://r2.example/p2"' },
    ]);
    expect(within(sheet).queryByRole('progressbar', { name: /Uploading/ })).toBeNull();
  });

  it('cancels a replacement in parts: the upload is aborted and the current file stays', async () => {
    assets = [asset({ version: 2 })];
    versions = [version(2, { current: true }), version(1)];
    client.putUploadPart.mockImplementation(
      (_url: string, _bytes: Blob, signal?: AbortSignal) =>
        new Promise<string>((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    await within(sheet).findByRole('list', { name: 'File versions' });
    fireEvent.change(within(sheet).getByLabelText('Replacement file'), {
      target: { files: [bigFile('cut.mp4')] },
    });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Cancel upload' }));
    await waitFor(() => expect(client.abortAssetUpload).toHaveBeenCalledWith('a1', 'r1'));
    await waitFor(() => expect(within(sheet).queryByText(/Uploading/)).toBeNull());
    expect(within(sheet).queryByRole('alert')).toBeNull();
    expect(client.completeAssetUpload).not.toHaveBeenCalled();
  });

  it('says another change won the race, and shows the version that did', async () => {
    assets = [asset({ version: 2 })];
    versions = [version(2, { current: true }), version(1)];
    client.replaceAssetFile.mockImplementationOnce(async () => {
      versions = [version(3, { current: true }), version(2), version(1)];
      throw new ApiError(409, 'POST → 409', { error: { code: 'conflict', message: 'conflict' } });
    });
    // What the asset is now, read back after the lost race.
    client.getAsset.mockResolvedValueOnce(asset({ version: 3 }));
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    await within(sheet).findByRole('list', { name: 'File versions' });
    fireEvent.change(within(sheet).getByLabelText('Replacement file'), {
      target: { files: [new File(['x'], 'late.jpg', { type: 'image/jpeg' })] },
    });
    const alert = await within(sheet).findByRole('alert');
    expect(within(alert).getByText('“late.jpg” didn’t replace the file')).toBeTruthy();
    expect(within(alert).getByText(/Another replace or restore finished first/)).toBeTruthy();
    await waitFor(() =>
      expect(within(sheet).getAllByRole('listitem')[0]?.textContent).toContain('v3'),
    );
    // The sheet itself caught up too, not only the list.
    expect(client.getAsset).toHaveBeenCalledWith('a1');
  });

  it('asks in place before restoring, and restores on yes', async () => {
    assets = [asset({ status: 'published', version: 3 })];
    versions = [version(3, { current: true, published: true }), version(2), version(1)];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Restore version 1' }));
    const ask = within(sheet).getByRole('alertdialog', { name: /Restore version 1\?/ });
    expect(within(ask).getByText(/Delivery keeps v3 until you publish again/)).toBeTruthy();
    expect(client.restoreAssetVersion).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(within(sheet).queryByRole('alertdialog')).toBeNull();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore version 1' }));
    versions = [
      version(4, { current: true, restoredFrom: 1 }),
      version(3, { published: true }),
      version(2),
      version(1),
    ];
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore v1' }));
    await waitFor(() => expect(client.restoreAssetVersion).toHaveBeenCalledWith('a1', 1));
    expect(await screen.findByText('Restored version 1 as version 4')).toBeTruthy();
    expect(await within(sheet).findByText('Restored from v1')).toBeTruthy();
  });

  it('says when Delivery still serves an older version, and a refused publish says why', async () => {
    assets = [asset({ status: 'published', version: 3 })];
    versions = [version(3, { current: true }), version(2, { published: true }), version(1)];
    client.publishAsset.mockRejectedValueOnce(
      new ApiError(409, 'POST → 409', {
        error: {
          code: 'asset_embargoed',
          message: 'Asset "a1" is under embargo until 2030-01-01T00:00:00.000Z',
          embargoUntil: '2030-01-01T00:00:00.000Z',
        },
      }),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Versions');
    expect(await within(sheet).findByText('Delivery serves version 2')).toBeTruthy();
    expect(
      within(sheet).getByText('The published version is v2. Publish again to deliver v3.'),
    ).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish v3' }));
    expect(
      await screen.findByText('Asset "a1" is under embargo until 2030-01-01T00:00:00.000Z'),
    ).toBeTruthy();
  });

  it('does not offer to replace a hosted video, and says why', async () => {
    assets = [
      asset({
        file: {
          fileName: 'intro.mp4',
          contentType: 'video/mp4',
          url: '',
          video: { provider: 'stream', videoId: 'v1', status: 'ready' },
        },
      }),
    ];
    versions = [version(1, { current: true })];
    renderLibrary();
    const sheet = await openTab('intro.mp4', 'Versions');
    const replace = within(sheet).getByRole('button', { name: 'Replace file' });
    expect(replace).toHaveProperty('disabled', true);
    expect(
      document.getElementById(replace.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/A hosted video can’t be replaced/);
  });
});

describe('the Rights tab', () => {
  it('asks before the sheet closes on rights not yet saved', async () => {
    assets = [asset()];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(await screen.findByRole('alertdialog', { name: /Discard your changes/ })).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('never says the rights aren’t saved once their save didn’t confirm', async () => {
    assets = [asset()];
    client.setAssetRights.mockRejectedValueOnce(new RequestTimeoutError(true));
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    await within(sheet).findByText(/didn’t confirm/);

    // The form tells the sheet its save is over in an effect: until then leaving only waits.
    const ask = await waitFor(() => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
      return screen.getByRole('alertdialog', { name: /Discard your changes/ });
    });
    expect(ask.textContent).not.toContain('The rights here are not saved.');
    expect(ask.textContent).toContain('may have gone through');
  });

  it('a refused retry doesn’t say the rights weren’t saved', async () => {
    assets = [asset()];
    client.setAssetRights
      .mockRejectedValueOnce(new RequestTimeoutError(true))
      .mockRejectedValueOnce(new ApiError(409, 'POST → 409'));
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    await within(sheet).findByText(/didn’t confirm/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    await within(sheet).findByText('This try was refused');
    expect(within(sheet).queryByText('The rights weren’t saved')).toBeNull();
  });

  it('says only what the form holds is unsaved, once the rights beside it went', async () => {
    assets = [asset()];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Details');
    fireEvent.change(within(sheet).getByLabelText(/^Alt text/), { target: { value: 'A pier' } });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const ask = await screen.findByRole('alertdialog', { name: /Discard your changes/ });
    expect(ask.textContent).toContain('Alt text, tags and the focal point here are not saved.');
    expect(ask.textContent).not.toContain('Nothing has been saved');
  });

  it('Save metadata saves, then asks rather than closing over unsaved rights', async () => {
    assets = [asset()];
    client.setAssetMetadata.mockResolvedValueOnce(undefined);
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });
    const details = within(sheet).getByRole('tab', { name: 'Details' });
    fireEvent.mouseDown(details);
    fireEvent.click(details);
    await waitFor(() => expect(details.getAttribute('aria-selected')).toBe('true'));

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save metadata' }));

    await waitFor(() => expect(client.setAssetMetadata).toHaveBeenCalled());
    const ask = await screen.findByRole('alertdialog', { name: /Discard your changes/ });
    // The metadata went: only the rights are at stake, and the question says so.
    expect(ask.textContent).toContain('The rights here are not saved.');
    expect(ask.textContent).not.toContain('Nothing has been saved');
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    const rights = within(sheet).getByRole('tab', { name: 'Rights' });
    fireEvent.mouseDown(rights);
    fireEvent.click(rights);
    await waitFor(() => expect(rights.getAttribute('aria-selected')).toBe('true'));
    expect((within(sheet).getByLabelText('License') as HTMLInputElement).value).toBe('CC0');
  });

  it('Save metadata closes when no rights are waiting', async () => {
    assets = [asset()];
    client.setAssetMetadata.mockResolvedValueOnce(undefined);
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Details');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save metadata' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('holds the sheet while rights save', async () => {
    assets = [asset()];
    client.setAssetRights.mockReturnValueOnce(new Promise(() => {}));
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    await within(sheet).findByRole('button', { name: 'Saving…' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('asks before the duplicate badge replaces unsaved rights', async () => {
    assets = [asset({ duplicateOf: 'orig' })];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });

    fireEvent.click(within(sheet).getByRole('button', { name: /^Possible duplicate/ }));

    const ask = await screen.findByRole('alertdialog', {
      name: 'Open the original and discard your changes?',
    });
    expect(ask.textContent).toContain('rights');
  });

  it('reads the saved rights as a status', async () => {
    assets = [
      asset({
        id: 'soon',
        file: { fileName: 'soon.jpg' },
        rights: { license: 'CC BY 4.0', expiresAt: new Date(Date.now() + 3 * DAY).toISOString() },
      }),
      asset({
        id: 'gone',
        file: { fileName: 'gone.jpg' },
        rights: { expiresAt: new Date(Date.now() - DAY).toISOString() },
      }),
      asset({
        id: 'held',
        file: { fileName: 'held.jpg' },
        rights: { embargoUntil: new Date(Date.now() + 2 * DAY).toISOString() },
      }),
    ];
    renderLibrary();
    let sheet = await openTab('soon.jpg', 'Rights');
    const status = within(sheet).getByTestId('rights-status');
    expect(within(status).getByText('Expires soon')).toBeTruthy();
    expect(within(status).getByText(/Expires in 3 days/)).toBeTruthy();
    expect((within(sheet).getByLabelText('License') as HTMLInputElement).value).toBe('CC BY 4.0');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    sheet = await openTab('gone.jpg', 'Rights');
    const expired = within(sheet).getByTestId('rights-status');
    expect(within(expired).getByText('Expired')).toBeTruthy();
    expect(
      within(expired).getByText(/It isn’t delivered; extend or clear the expiry/),
    ).toBeTruthy();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    sheet = await openTab('held.jpg', 'Rights');
    expect(
      within(within(sheet).getByTestId('rights-status')).getByText(/Under embargo until/),
    ).toBeTruthy();
  });

  it('saves the rights with the dates as instants with a zone, and blanks as none', async () => {
    assets = [asset({ rights: { credit: 'Old credit' } })];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: ' CC BY ' } });
    fireEvent.change(within(sheet).getByLabelText('Credit'), { target: { value: '' } });
    fireEvent.change(within(sheet).getByLabelText('Expires at'), {
      target: { value: '2030-06-01T09:00' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    await waitFor(() => expect(client.setAssetRights).toHaveBeenCalled());
    expect(client.setAssetRights.mock.calls[0]).toEqual([
      'a1',
      {
        license: 'CC BY',
        credit: null,
        expiresAt: new Date('2030-06-01T09:00').toISOString(),
        embargoUntil: null,
      },
    ]);
    expect(client.setAssetRights.mock.calls[0]?.[1].expiresAt).toMatch(/Z$/);
    expect(await screen.findByText('Rights saved')).toBeTruthy();
  });

  it('keeps rights typed but not saved across a look at another tab', async () => {
    assets = [asset()];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'CC0' } });
    const details = within(sheet).getByRole('tab', { name: 'Details' });
    fireEvent.mouseDown(details);
    fireEvent.click(details);
    await waitFor(() => expect(details.getAttribute('aria-selected')).toBe('true'));
    const rights = within(sheet).getByRole('tab', { name: 'Rights' });
    fireEvent.mouseDown(rights);
    fireEvent.click(rights);
    await waitFor(() => expect(rights.getAttribute('aria-selected')).toBe('true'));
    expect((within(sheet).getByLabelText('License') as HTMLInputElement).value).toBe('CC0');
  });

  it('asks before an expiry already past takes a published asset out of Delivery', async () => {
    assets = [asset({ status: 'published' })];
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    // Published: the embargo's rule is said before saving, not only after a refusal.
    expect(within(sheet).getByText(/an embargo can’t be set now/)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Expires at'), {
      target: { value: '2001-01-01T09:00' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    const ask = within(sheet).getByRole('alertdialog', { name: /Expire it now\?/ });
    expect(client.setAssetRights).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Expire now' }));
    await waitFor(() => expect(client.setAssetRights).toHaveBeenCalled());
  });

  it('shows what the API refused beside each field', async () => {
    assets = [asset()];
    client.setAssetRights.mockRejectedValueOnce(
      new ApiError(422, 'PUT → 422', {
        error: {
          code: 'validation',
          message: 'Invalid',
          issues: [
            {
              field: 'rights.expiresAt',
              message:
                'expiresAt must be after embargoUntil, or the asset could never be delivered',
            },
          ],
        },
      }),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('Embargo until'), {
      target: { value: '2030-06-02T09:00' },
    });
    fireEvent.change(within(sheet).getByLabelText('Expires at'), {
      target: { value: '2030-06-01T09:00' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    const field = within(sheet).getByLabelText('Expires at');
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    const described = (field.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain(
      'expiresAt must be after embargoUntil',
    );
    expect(within(sheet).getByLabelText('Embargo until').getAttribute('aria-invalid')).toBeNull();
    // Editing the field clears what was said about it.
    fireEvent.change(field, { target: { value: '2030-06-03T09:00' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('says in place that a role without content:publish can’t set rights', async () => {
    assets = [asset()];
    client.setAssetRights.mockRejectedValueOnce(
      new ApiError(403, 'PUT → 403', { error: { code: 'forbidden', message: 'Forbidden' } }),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('License'), { target: { value: 'Mine' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    const alert = await within(sheet).findByRole('alert');
    expect(within(alert).getByText('Your role can’t set rights')).toBeTruthy();
    expect(within(alert).getByText(/content:publish/)).toBeTruthy();
    // What was typed stays, to hand to someone who can.
    expect((within(sheet).getByLabelText('License') as HTMLInputElement).value).toBe('Mine');
  });

  it('says why an asset-wide refusal was refused', async () => {
    assets = [asset({ status: 'published' })];
    client.setAssetRights.mockRejectedValueOnce(
      new ApiError(422, 'PUT → 422', {
        error: { code: 'validation', message: 'Unpublish it first to set an embargo' },
      }),
    );
    renderLibrary();
    const sheet = await openTab('photo.jpg', 'Rights');
    fireEvent.change(within(sheet).getByLabelText('Embargo until'), {
      target: { value: '2030-06-02T09:00' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save rights' }));
    const alert = await within(sheet).findByRole('alert');
    expect(within(alert).getByText('Unpublish it first to set an embargo')).toBeTruthy();
  });
});

describe('rights in the library', () => {
  const rightsAssets = () => [
    asset({
      id: 'soon',
      file: { fileName: 'soon.jpg' },
      rights: { expiresAt: new Date(Date.now() + 2 * DAY).toISOString() },
    }),
    asset({
      id: 'gone',
      file: { fileName: 'gone.jpg' },
      rights: { expiresAt: new Date(Date.now() - DAY).toISOString() },
    }),
    asset({
      id: 'later',
      file: { fileName: 'later.jpg' },
      rights: { expiresAt: new Date(Date.now() + 30 * DAY).toISOString() },
    }),
  ];
  const cardOf = (name: string) =>
    screen.getByRole('button', { name: `Open “${name}”` }).closest('li') as HTMLElement;

  it('marks cards that expire within a week, and those that expired', async () => {
    assets = rightsAssets();
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “soon.jpg”' });
    expect(within(cardOf('soon.jpg')).getByText('Expires soon')).toBeTruthy();
    expect(within(cardOf('gone.jpg')).getByText('Expired')).toBeTruthy();
    expect(within(cardOf('later.jpg')).queryByText(/Expire/)).toBeNull();
  });

  it('marks the list’s rows the same way', async () => {
    localStorage.setItem('cw.assets.view', 'list');
    assets = rightsAssets();
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “soon.jpg”' });
    const table = screen.getByRole('table', { name: 'Assets' });
    const row = (name: string) =>
      within(table)
        .getByRole('button', { name: `Open “${name}”` })
        .closest('tr') as HTMLElement;
    expect(within(row('soon.jpg')).getByText('Expires soon')).toBeTruthy();
    expect(within(row('gone.jpg')).getByText('Expired')).toBeTruthy();
    expect(within(row('later.jpg')).queryByText(/Expire/)).toBeNull();
  });

  it('shows the server’s reason when a row’s publish is refused', async () => {
    assets = [asset({ file: { fileName: 'gone.jpg' } })];
    client.publishAsset.mockRejectedValueOnce(
      new ApiError(409, 'POST /x → 409 {…}', {
        error: {
          code: 'asset_expired',
          message: 'Asset "a1" can\'t be delivered: its rights expired at 2026-01-01T00:00:00.000Z',
        },
      }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish “gone.jpg”' }));
    expect(
      await screen.findByText(
        'Asset "a1" can\'t be delivered: its rights expired at 2026-01-01T00:00:00.000Z',
      ),
    ).toBeTruthy();
  });
});

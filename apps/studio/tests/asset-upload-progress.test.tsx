// @vitest-environment jsdom
import type { Asset } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

configure({ asyncUtilTimeout: 5000 });

const MiB = 1024 * 1024;
const PART = 64 * MiB;
/** 150 MiB: past one signed PUT, so three parts (64, 64 and 22 MiB). */
const SIZE = 150 * MiB;

/** A file that says it is 150 MiB without holding it (the fake storage never reads the bytes). */
function bigFile(name = 'film.bin'): File {
  const f = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: SIZE });
  return f;
}

const lengthOf = (n: number) => (n < 3 ? PART : SIZE - 2 * PART);

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({ items: [] as Asset[] })),
  listAssetFolders: vi.fn(async () => []),
  listTags: vi.fn(async () => []),
  listAssetCollections: vi.fn(async () => ({ items: [] })),
  startAssetUpload: vi.fn(async (_input: unknown) => ({
    asset: { id: 'big1' } as Asset,
    upload: { uploadId: 'u1', partSize: PART, partCount: 3 },
  })),
  signAssetUploadParts: vi.fn(async (_a: string, _u: string, numbers: readonly number[]) => ({
    parts: numbers.map((n) => ({
      partNumber: n,
      url: `https://r2.example/${n}`,
      length: lengthOf(n),
      expiresAt: '',
    })),
  })),
  putUploadPart: vi.fn(async (url: string, _bytes: Blob, _signal?: AbortSignal) => {
    return `"e${new URL(url).pathname.slice(1)}"`;
  }),
  completeAssetUpload: vi.fn(async () => ({ id: 'big1' }) as Asset),
  abortAssetUpload: vi.fn(async () => {}),
  publishAsset: vi.fn(async () => ({}) as Asset),
  uploadAsset: vi.fn(),
  uploadVideo: vi.fn(),
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
const { UploadPartError } = await import('~/cms/lib/management');
const { AssetUploadList } = await import('~/cms/components/assets/AssetUploadList');

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function uploadBig(file = bigFile()) {
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
  await screen.findByText('No assets yet');
  fireEvent.change(screen.getByLabelText('Upload asset files'), { target: { files: [file] } });
  return screen.findByRole('region', { name: 'Uploads' });
}

describe('uploading a file past one signed PUT', () => {
  it('shows the bytes stored and parts done, a part retrying, then publishes it', async () => {
    const part3 = deferred<string>();
    const resign = deferred<void>();
    let part2Attempts = 0;
    client.putUploadPart.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).pathname.slice(1));
      if (n === 2 && ++part2Attempts === 1) throw new UploadPartError(403, 'expired');
      if (n === 3) return part3.promise;
      return `"e${n}"`;
    });
    // Part 2's second signature waits, so its retrying state can be seen.
    const sign = client.signAssetUploadParts.getMockImplementation();
    let part2Signs = 0;
    client.signAssetUploadParts.mockImplementation(async (a, u, numbers) => {
      if (numbers[0] === 2 && ++part2Signs === 2) await resign.promise;
      return sign!(a, u, numbers);
    });

    const region = await uploadBig();
    await waitFor(() =>
      expect(client.startAssetUpload).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'film.bin', size: SIZE }),
      ),
    );
    // Not a single PUT: the file goes in parts.
    expect(client.uploadAsset).not.toHaveBeenCalled();

    const progress = await within(region).findByRole('progressbar', {
      name: 'Uploading “film.bin”',
    });
    expect(await within(region).findByText('Retrying')).toBeTruthy();
    expect(within(region).getByText(/retrying part 2/)).toBeTruthy();
    // Part 1 stored: 64 of 150 MiB.
    expect(progress.getAttribute('aria-valuenow')).toBe('43');
    expect(progress.getAttribute('aria-valuetext')).toBe(
      '64 MB of 150 MB · 1 of 3 parts · retrying part 2',
    );

    resign.resolve();
    await waitFor(() =>
      expect(within(region).getByText('128 MB of 150 MB · 2 of 3 parts')).toBeTruthy(),
    );
    expect(within(region).getByText('Uploading')).toBeTruthy();

    part3.resolve('"e3"');
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe('Uploaded 1 file'),
    );
    expect(client.completeAssetUpload).toHaveBeenCalledWith('big1', 'u1', [
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e2"' },
      { partNumber: 3, etag: '"e3"' },
    ]);
    expect(client.publishAsset).toHaveBeenCalledWith('big1');
    expect(client.abortAssetUpload).not.toHaveBeenCalled();
  });

  it('fails the file once a part is out of attempts, and aborts the upload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client.putUploadPart.mockImplementation(async (url: string) => {
      if (url.endsWith('/2')) throw new UploadPartError(500, 'part upload failed: 500');
      return '"ok"';
    });
    const region = await uploadBig();
    await within(region).findByText('Retrying');
    // Backoff of 500 ms, 1 s and 2 s between the four attempts.
    await act(() => vi.advanceTimersByTimeAsync(4000));
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe('Uploaded 0 files; 1 failed'),
    );
    expect(within(region).getByText('Failed')).toBeTruthy();
    expect(within(region).getByText(/part upload failed: 500/)).toBeTruthy();
    expect(client.abortAssetUpload).toHaveBeenCalledWith('big1', 'u1');
    expect(client.completeAssetUpload).not.toHaveBeenCalled();
    expect(client.publishAsset).not.toHaveBeenCalled();
  });

  it('cancels: the parts in flight stop, and the upload is aborted on the server', async () => {
    client.putUploadPart.mockImplementation(
      (_url: string, _bytes: Blob, signal?: AbortSignal) =>
        new Promise<string>((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    const region = await uploadBig();
    await within(region).findByRole('progressbar', { name: 'Uploading “film.bin”' });
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel uploading “film.bin”' }));
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe('Uploaded 0 files; 1 cancelled'),
    );
    expect(within(region).getByText('Cancelled')).toBeTruthy();
    expect(client.abortAssetUpload).toHaveBeenCalledWith('big1', 'u1');
    expect(client.completeAssetUpload).not.toHaveBeenCalled();
    expect(client.publishAsset).not.toHaveBeenCalled();
    // Nothing left to cancel.
    expect(within(region).queryByRole('button', { name: /Cancel uploading/ })).toBeNull();
  });
});

describe('the upload queue', () => {
  it('offers Cancel to a file still waiting, and to no finished one', () => {
    const onCancel = vi.fn();
    render(
      <AssetUploadList
        onDismiss={() => {}}
        onCancel={onCancel}
        items={[
          { id: '1', name: 'a.png', state: 'done', cancellable: true },
          { id: '2', name: 'b.png', state: 'queued', cancellable: true },
          { id: '3', name: 'c.png', state: 'uploading', cancellable: false },
        ]}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Uploading 1 of 3');
    expect(screen.getAllByRole('button', { name: /Cancel uploading/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel uploading “b.png”' }));
    expect(onCancel).toHaveBeenCalledWith('2');
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom ships neither; radix's Select reaches for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

const navigate = vi.fn();
const params: { typeId?: string } = {};
vi.mock('react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => params,
}));

const client = {
  analyzeImport: vi.fn(),
  analyzeSpaceExport: vi.fn(),
  startSpaceExportImport: vi.fn(),
  getBulkJob: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ client }) }));
const product = {
  apiId: 'product',
  name: 'Product',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [
    { apiId: 'name', name: 'Name', type: 'Symbol', localized: false, required: true, position: 0 },
  ],
};
vi.mock('~/cms/routes/content-context', () => ({
  useContentOutlet: () => ({ types: [product], defaultLocale: 'en-US', locales: ['en-US'] }),
}));

const { ImportEntries } = await import('~/cms/routes/ImportEntries');
const { ToastProvider } = await import('~/cms/lib/toast');

const EXPORT = JSON.stringify({ contentTypes: [], entries: [], locales: [] });

const report = (over: Record<string, unknown> = {}) => ({
  dryRun: true,
  executable: true,
  problems: [],
  locales: {
    default: 'en-US',
    declared: [
      { code: 'en-US', fallback: null },
      { code: 'de-DE', fallback: 'en-US' },
    ],
    toAdd: [],
  },
  contentTypes: 4,
  tags: 2,
  entries: { read: 11, imported: 8, published: 5, invalid: 3 },
  assets: { read: 4, imported: 3, published: 2 },
  unmappedFields: ['blogPost.sponsor (ResourceLink): no equivalent field type here'],
  unmappedValidations: ['author.avatar: assetFileSize'],
  warnings: ['archived entries are imported as drafts'],
  missingLinks: [
    { entry: 'post-second', field: 'author', linkType: 'Entry', target: 'author-missing' },
  ],
  missingLinkCount: 1,
  invalidEntries: [{ entry: 'post-untitled', messages: ['title (en-US): Field is required'] }],
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  action: 'import',
  status: 'running',
  totalItems: 11,
  totalChunks: 1,
  completedChunks: 0,
  succeeded: 0,
  failed: 0,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

/** jsdom's File has no usable text(); stub what the component calls. */
function fileOf(name: string, contents: string): File {
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => contents });
  return file;
}

const renderScreen = () =>
  render(
    <ToastProvider>
      <ImportEntries />
    </ToastProvider>,
  );

async function chooseExport() {
  fireEvent.change(screen.getByLabelText('File'), {
    target: { files: [fileOf('space.json', EXPORT)] },
  });
  await screen.findByRole('button', { name: 'Check this import' });
}

beforeEach(() => {
  delete params.typeId;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('importing a space export in the admin', () => {
  it('reports what the server would do, with nothing parsed in the browser', async () => {
    client.analyzeSpaceExport.mockResolvedValueOnce(report());
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Import a space export' })).toBeTruthy();
    await chooseExport();
    fireEvent.click(screen.getByRole('button', { name: 'Check this import' }));

    await screen.findByText('3. What this would do');
    expect(client.analyzeSpaceExport).toHaveBeenCalledWith({ payload: EXPORT, publish: true });
    expect(client.analyzeImport).not.toHaveBeenCalled();
    expect(
      screen.getByText('blogPost.sponsor (ResourceLink): no equivalent field type here'),
    ).toBeTruthy();
    expect(screen.getByText('post-untitled')).toBeTruthy();
    expect(screen.getByText('entry author-missing')).toBeTruthy();
    expect(screen.getByText(/de-DE \(falls back to en-US\)/)).toBeTruthy();
  });

  it('asks for added locales only when ticked, and blocks an import the server says cannot run', async () => {
    client.analyzeSpaceExport.mockResolvedValueOnce(
      report({
        executable: false,
        problems: ['This space has no de-DE locale(s).'],
        locales: { default: 'en-US', declared: [], toAdd: ['de-DE'] },
      }),
    );
    renderScreen();
    await chooseExport();
    fireEvent.click(
      screen.getByRole('checkbox', { name: "Add the export's locales this space lacks" }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check this import' }));

    await screen.findByText('This import can’t run yet');
    expect(client.analyzeSpaceExport).toHaveBeenCalledWith({
      payload: EXPORT,
      publish: true,
      addLocales: true,
    });
    expect(
      (screen.getByRole('button', { name: 'Import this space' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('starts the import and follows its job', async () => {
    client.analyzeSpaceExport.mockResolvedValueOnce(report());
    client.startSpaceExportImport.mockResolvedValueOnce({
      report: report({ dryRun: false }),
      job: job(),
      publishJobId: 'job-2',
    });
    renderScreen();
    await chooseExport();
    fireEvent.click(screen.getByRole('button', { name: 'Check this import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import this space' }));

    await screen.findByText('Importing…');
    expect(client.startSpaceExportImport).toHaveBeenCalledWith({ payload: EXPORT, publish: true });
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toBeTruthy();
  });

  it('is a format on a content type’s import screen too, with no columns to map', async () => {
    params.typeId = 'product';
    client.analyzeSpaceExport.mockResolvedValueOnce(report());
    renderScreen();
    fireEvent.click(screen.getByLabelText('Format'));
    fireEvent.click(await screen.findByRole('option', { name: 'Space export' }));
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [fileOf('space.json', EXPORT)] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Check this import' }));

    await screen.findByText('3. What this would do');
    expect(client.analyzeSpaceExport).toHaveBeenCalledWith({ payload: EXPORT, publish: true });
    // The flat-file reader is never asked for columns.
    expect(client.analyzeImport).not.toHaveBeenCalled();
    expect(screen.queryByText('2. Match the columns')).toBeNull();
  });

  it('shows the server’s refusal', async () => {
    client.analyzeSpaceExport.mockRejectedValueOnce(new Error('Not a space export'));
    renderScreen();
    await chooseExport();
    fireEvent.click(screen.getByRole('button', { name: 'Check this import' }));
    await waitFor(() => expect(screen.getByText('Not a space export')).toBeTruthy());
  });
});

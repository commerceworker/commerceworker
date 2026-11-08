// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships neither; radix's Select reaches for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
// Radix Select measures with these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

const navigate = vi.fn();
vi.mock('react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ typeId: 'product' }),
}));

const client = {
  analyzeImport: vi.fn(),
  runImport: vi.fn(),
  startImportJob: vi.fn(),
  getBulkJob: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ client }) }));

const outlet = {
  types: [] as ContentType[],
  defaultLocale: 'en-US',
  locales: ['en-US'],
};
vi.mock('~/cms/routes/content-context', () => ({ useContentOutlet: () => outlet }));

const { ImportEntries } = await import('~/cms/routes/ImportEntries');
const { ToastProvider } = await import('~/cms/lib/toast');

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

outlet.types = [
  {
    apiId: 'product',
    name: 'Product',
    displayField: 'name',
    version: 1,
    status: 'published',
    fields: [
      field({ apiId: 'name', name: 'Name', required: true }),
      field({ apiId: 'sku', name: 'SKU', position: 1 }),
      field({ apiId: 'body', name: 'Body', type: 'RichText', position: 2 }),
      field({ apiId: 'related', name: 'Related', type: 'Link', position: 3 }),
    ],
  },
];

const analysis = (over: Record<string, unknown> = {}) => ({
  contentTypeApiId: 'product',
  locale: 'en-US',
  records: 2,
  willCreate: 2,
  willUpdate: 0,
  willSkip: 0,
  invalid: 0,
  unmappedSourceFields: [],
  missingRequiredFields: [],
  unknownTargetFields: [],
  warnings: [],
  issues: [],
  executable: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** jsdom's File has no usable text(); stub what the component calls. */
function fileOf(name: string, contents: string): File {
  const file = new File([contents], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => contents });
  return file;
}

const CSV = 'sku,title,colour\nA-1,Widget,red\n';

const renderScreen = () =>
  render(
    <ToastProvider>
      <ImportEntries />
    </ToastProvider>,
  );

/** Picks a file and waits for the server-reported column list. */
const chooseFile = async (columns = ['sku', 'title', 'colour']) => {
  client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: columns }));
  fireEvent.change(screen.getByLabelText('File'), {
    target: { files: [fileOf('products.csv', CSV)] },
  });
  await screen.findByText(/3 columns/);
};

const mapField = async (fieldName: string, column: string) => {
  fireEvent.click(screen.getByLabelText(new RegExp(`^${fieldName}`)));
  fireEvent.click(await screen.findByRole('option', { name: column }));
};

describe('reading the file', () => {
  it('asks the server what is in it rather than parsing it here', async () => {
    renderScreen();
    await chooseFile();
    // Two readers that can disagree about a file's contents is the failure
    // mode; the column names offered must be the ones the import will see.
    expect(client.analyzeImport).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'csv', payload: CSV }),
    );
    expect(client.analyzeImport.mock.calls[0]?.[0].mapping.fields).toEqual({});
  });

  it('picks the format from the file name', async () => {
    renderScreen();
    client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: ['a'] }));
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [fileOf('export.json', '[]')] },
    });
    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalled());
    expect(client.analyzeImport.mock.calls[0]?.[0].source).toBe('json');
  });

  it('reads an .xml file as a WordPress export, asking for posts by default', async () => {
    renderScreen();
    client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: ['title'] }));
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [fileOf('site.WordPress.xml', '<rss/>')] },
    });
    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalled());
    expect(client.analyzeImport.mock.calls[0]?.[0]).toMatchObject({
      source: 'wxr',
      sourceOptions: { postType: 'post' },
    });
  });

  it('re-reads the export when the post type changes', async () => {
    renderScreen();
    client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: ['title'] }));
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [fileOf('site.xml', '<rss/>')] },
    });
    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalledTimes(1));

    client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: ['title'] }));
    const postType = await screen.findByLabelText('Post type');
    fireEvent.change(postType, { target: { value: 'page' } });
    fireEvent.blur(postType);
    // A different post type can carry different custom fields, so the column
    // list is asked for again rather than kept from the posts.
    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalledTimes(2));
    expect(client.analyzeImport.mock.calls[1]?.[0].sourceOptions).toEqual({ postType: 'page' });
  });

  it('re-reads the file when the format is changed by hand', async () => {
    // A WordPress export saved under another extension is first read as CSV;
    // keeping the CSV columns after switching would map against the wrong reading.
    renderScreen();
    await chooseFile();
    client.analyzeImport.mockResolvedValueOnce(analysis({ unmappedSourceFields: ['title'] }));
    fireEvent.click(screen.getByLabelText('Format'));
    fireEvent.click(await screen.findByRole('option', { name: 'WordPress' }));
    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalledTimes(2));
    expect(client.analyzeImport.mock.calls[1]?.[0]).toMatchObject({
      source: 'wxr',
      sourceOptions: { postType: 'post' },
    });
    expect(await screen.findByText(/1 column\b/)).toBeTruthy();
  });

  it('shows no mapping table before a file has been read', () => {
    renderScreen();
    expect(screen.queryByText(/match the columns/i)).toBeNull();
  });

  it('surfaces a file the server could not read', async () => {
    renderScreen();
    client.analyzeImport.mockRejectedValueOnce(new Error('CSV has no header row'));
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [fileOf('broken.csv', '')] },
    });
    expect(await screen.findByText(/no header row/i)).toBeTruthy();
  });
});

describe('mapping', () => {
  it('offers only fields a flat file can fill', async () => {
    renderScreen();
    await chooseFile();
    // A link needs structure a CSV cell does not have; offering it would
    // produce a mapping that only fails at validation.
    expect(screen.getByLabelText(/^Name/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Related/)).toBeNull();
  });

  it('offers rich text, which the server reads from HTML', async () => {
    renderScreen();
    await chooseFile();
    expect(screen.getByLabelText(/^Body/)).toBeTruthy();
  });

  it('cannot be checked until something is mapped', async () => {
    renderScreen();
    await chooseFile();
    expect(screen.getByRole('button', { name: /check this import/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('sends the mapping it was given', async () => {
    renderScreen();
    await chooseFile();
    await mapField('Name', 'title');
    client.analyzeImport.mockResolvedValueOnce(analysis());
    fireEvent.click(screen.getByRole('button', { name: /check this import/i }));

    await waitFor(() => expect(client.analyzeImport).toHaveBeenCalledTimes(2));
    expect(client.analyzeImport.mock.calls[1]?.[0].mapping.fields).toEqual({ name: 'title' });
  });

  it('warns that a run without an identity duplicates everything', async () => {
    renderScreen();
    await chooseFile();
    expect(screen.getByText(/running this twice creates everything twice/i)).toBeTruthy();
  });
});

describe('the report', () => {
  const analyzeWith = async (over: Record<string, unknown>) => {
    renderScreen();
    await chooseFile();
    await mapField('Name', 'title');
    client.analyzeImport.mockResolvedValueOnce(analysis(over));
    fireEvent.click(screen.getByRole('button', { name: /check this import/i }));
    return screen.findByText(/what this would do/i);
  };

  it('shows the counts', async () => {
    await analyzeWith({ willCreate: 7, willUpdate: 2, willSkip: 1 });
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('names the columns that would be thrown away', async () => {
    await analyzeWith({ unmappedSourceFields: ['colour', 'weight'] });
    // Only findable before the run; afterwards there is nothing to compare to.
    expect(screen.getByText(/2 columns would be discarded/i)).toBeTruthy();
    expect(screen.getByText(/colour, weight/)).toBeTruthy();
  });

  it('refuses to run a mapping that cannot work', async () => {
    await analyzeWith({ missingRequiredFields: ['name'], executable: false });
    expect(screen.getByText(/required fields with no column/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^import /i })).toHaveProperty('disabled', true);
  });

  it('lists the records that would be skipped, by their source id', async () => {
    await analyzeWith({
      invalid: 1,
      willSkip: 1,
      issues: [{ externalId: 'A-2', messages: ['name: Field is required'] }],
    });
    const row = screen.getByText('A-2').closest('tr') as HTMLElement;
    expect(within(row).getByText(/field is required/i)).toBeTruthy();
  });

  it('says when it is showing only part of the problems', async () => {
    await analyzeWith({
      invalid: 150,
      issues: [{ externalId: 'A-2', messages: ['nope'] }],
    });
    expect(screen.getByText(/showing 1 of 150/i)).toBeTruthy();
  });

  it('passes on what the file itself could not read', async () => {
    await analyzeWith({ warnings: ['Row 4 has 2 value(s) for 3 column(s)'] });
    expect(screen.getByText(/2 value\(s\) for 3 column\(s\)/)).toBeTruthy();
  });

  it('says the entries arrive as drafts', async () => {
    await analyzeWith({});
    expect(screen.getByText(/arrive as drafts/i)).toBeTruthy();
  });
});

describe('running it', () => {
  it('sends the same request it analyzed, and leaves for the entry list', async () => {
    renderScreen();
    await chooseFile();
    await mapField('Name', 'title');
    client.analyzeImport.mockResolvedValueOnce(analysis());
    fireEvent.click(screen.getByRole('button', { name: /check this import/i }));
    await screen.findByText(/what this would do/i);

    client.runImport.mockResolvedValueOnce({
      analysis: analysis(),
      created: 2,
      updated: 0,
      skipped: 0,
      failed: [],
    });
    fireEvent.click(screen.getByRole('button', { name: /^import 2 records/i }));

    await waitFor(() => expect(client.runImport).toHaveBeenCalled());
    // The same body the report was computed from — anything else and the
    // report described a different run.
    expect(client.runImport.mock.calls[0]?.[0]).toEqual(client.analyzeImport.mock.calls[1]?.[0]);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/content/product'));
  });

  it('drops a stale report when the mapping changes', async () => {
    renderScreen();
    await chooseFile();
    await mapField('Name', 'title');
    client.analyzeImport.mockResolvedValueOnce(analysis());
    fireEvent.click(screen.getByRole('button', { name: /check this import/i }));
    await screen.findByText(/what this would do/i);

    await mapField('SKU', 'sku');
    // Leaving it up would let someone run an import against a report of a
    // different mapping.
    expect(screen.queryByText(/what this would do/i)).toBeNull();
  });
});

describe('a file too big for one request', () => {
  const BIG = 10_001;

  const analyzeBig = async (records = BIG) => {
    renderScreen();
    await chooseFile();
    await mapField('Name', 'title');
    client.analyzeImport.mockResolvedValueOnce(analysis({ records, willCreate: records }));
    fireEvent.click(screen.getByRole('button', { name: /check this import/i }));
    await screen.findByText(/what this would do/i);
  };

  it('is still described rather than refused', async () => {
    // Analysis writes nothing; refusing to describe a file the durable path
    // would import leaves an operator unable to see how big their problem is.
    await analyzeBig();
    expect(screen.getByText(/10,001 records read/)).toBeTruthy();
  });

  it('starts a job instead of a synchronous run', async () => {
    await analyzeBig();
    client.startImportJob.mockResolvedValueOnce({
      job: {
        id: 'j1',
        action: 'import',
        status: 'running',
        totalItems: BIG,
        totalChunks: 51,
        completedChunks: 0,
        succeeded: 0,
        failed: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import /i }));

    await waitFor(() => expect(client.startImportJob).toHaveBeenCalled());
    // A request that writes ten thousand entries is a request that times out.
    expect(client.runImport).not.toHaveBeenCalled();
    expect(await screen.findByText(/importing…/i)).toBeTruthy();
  });

  it('reports progress by batch, and says the work outlives the tab', async () => {
    await analyzeBig();
    client.startImportJob.mockResolvedValueOnce({
      job: {
        id: 'j1',
        action: 'import',
        status: 'running',
        totalItems: BIG,
        totalChunks: 51,
        completedChunks: 12,
        succeeded: 2400,
        failed: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import /i }));

    expect(await screen.findByText(/12 of 51 batches/)).toBeTruthy();
    expect(screen.getByText(/keeps running if you close the tab/i)).toBeTruthy();
    // Chunks, not records: a record count that moves 200 at a time reads as
    // stuck between jumps.
    const bar = screen.getByRole('progressbar') as HTMLProgressElement;
    expect(bar.value).toBe(12);
    expect(bar.max).toBe(51);
  });

  it('shows failures as they accumulate, not only at the end', async () => {
    await analyzeBig();
    client.startImportJob.mockResolvedValueOnce({
      job: {
        id: 'j1',
        action: 'import',
        status: 'running',
        totalItems: BIG,
        totalChunks: 51,
        completedChunks: 3,
        succeeded: 500,
        failed: 100,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import /i }));
    // An import failing every record should be stoppable before it finishes.
    expect(await screen.findByText(/100 records failed/i)).toBeTruthy();
  });

  it('replaces the report rather than showing both', async () => {
    await analyzeBig();
    client.startImportJob.mockResolvedValueOnce({
      job: {
        id: 'j1',
        action: 'import',
        status: 'completed',
        totalItems: BIG,
        totalChunks: 51,
        completedChunks: 51,
        succeeded: BIG,
        failed: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import /i }));

    expect(await screen.findByText(/import finished/i)).toBeTruthy();
    expect(screen.queryByText(/what this would do/i)).toBeNull();
  });

  it('leaves for the entry list when the job is done', async () => {
    await analyzeBig();
    client.startImportJob.mockResolvedValueOnce({
      job: {
        id: 'j1',
        action: 'import',
        status: 'completed',
        totalItems: BIG,
        totalChunks: 51,
        completedChunks: 51,
        succeeded: BIG,
        failed: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import /i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(navigate).toHaveBeenCalledWith('/content/product');
  });
});

describe('a content type that has not arrived yet', () => {
  it('renders without crashing', async () => {
    // Types load asynchronously, so this state is the first render, not an
    // edge case. A smoke check only: the failure it guards against — the hook
    // count changing once the type arrives — needs the *second* render to
    // show up, which this cannot drive through a module-level mock. The
    // browser sweep in e2e/accessibility.spec.ts is what actually caught it.
    const original = outlet.types;
    outlet.types = [];
    try {
      renderScreen();
      expect(screen.getByText(/unknown content type/i)).toBeTruthy();
    } finally {
      outlet.types = original;
    }
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const tag = {
  id: 't-1',
  name: 'Travel',
  slug: 'travel',
  description: 'Trips and places',
  labels: { de: 'Reisen' },
  usage: { count: 3, byContentType: { article: 2, page: 1 } },
};

const client = {
  listSchemes: vi.fn(async () => [{ id: 'sc-1', name: 'Topics' }]),
  listConcepts: vi.fn(async () => [
    {
      id: 'c-1',
      schemeId: 'sc-1',
      prefLabel: 'Cats',
      slug: 'cats',
      description: null,
      labels: {},
      broaderId: null,
      usage: { count: 1, byContentType: { article: 1 } },
    },
  ]),
  listTags: vi.fn(async () => [tag]),
  getSpaceConfig: vi.fn(async () => ({
    spaceId: 's',
    name: 'S',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de', 'fr'],
  })),
  updateTag: vi.fn(async () => tag),
  updateConcept: vi.fn(async () => ({})),
  createTag: vi.fn(async () => tag),
  deleteTag: vi.fn(async () => {}),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
  useLocalRun: () => ({ busy: false, run: (fn: () => Promise<void>) => fn() }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { Taxonomy } = await import('~/cms/routes/Taxonomy');
const { termChanges, usageLine } = await import('~/cms/components/TermEditor');

function renderTaxonomy() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Taxonomy />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('taxonomy screen', () => {
  it('shows each concept’s slug and published count, and edits it', async () => {
    renderTaxonomy();
    expect(await screen.findByText('cats')).toBeTruthy();
    expect(screen.getByText('1 published')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Cats”' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Description'), {
      target: { value: 'Felines' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save concept' }));
    await waitFor(() =>
      expect(client.updateConcept).toHaveBeenCalledWith('c-1', { description: 'Felines' }),
    );
  });

  it('filters tags by name, slug and description, and a miss offers the way out', async () => {
    client.listTags.mockResolvedValueOnce([
      tag,
      { ...tag, id: 't-2', name: 'Food', slug: 'eats', description: 'Recipes' },
    ]);
    renderTaxonomy();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tags' }));
    const list = await screen.findByRole('list', { name: 'Tags' });
    await within(list).findByText('Food');
    // Sorted by name, as the table was.
    const names = () =>
      within(screen.getByRole('list', { name: 'Tags' }))
        .getAllByRole('listitem')
        .map((li) => li.querySelector('[data-slot="item-title"]')?.textContent);
    expect(names()).toEqual(['Food', 'Travel']);

    const search = screen.getByRole('searchbox', { name: 'Search tags' });
    fireEvent.change(search, { target: { value: 'EATS' } });
    expect(names()).toEqual(['Food']);
    fireEvent.change(search, { target: { value: 'trips' } });
    expect(names()).toEqual(['Travel']);

    fireEvent.change(search, { target: { value: 'zebra' } });
    expect(screen.getByText(/No tags match “zebra”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toEqual(['Food', 'Travel']);
  });

  it('offers no filter before there are any tags', async () => {
    client.listTags.mockResolvedValueOnce([]);
    renderTaxonomy();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tags' }));
    expect(await screen.findByText('No tags yet')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('lists tags with slug and count, and saves only what changed', async () => {
    renderTaxonomy();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tags' }));
    const list = await screen.findByRole('list', { name: 'Tags' });
    expect(await within(list).findByText('travel')).toBeTruthy();
    expect(within(list).getByText('3')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Edit “Travel”' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/Carried by 3 published entries/)).toBeTruthy();
    // One field per other locale; the default's label is the name.
    await waitFor(() => expect(within(sheet).getByLabelText('fr')).toBeTruthy());
    expect((within(sheet).getByLabelText('de') as HTMLInputElement).value).toBe('Reisen');
    const save = within(sheet).getByRole('button', { name: 'Save tag' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(sheet).getByLabelText('fr'), { target: { value: 'Voyage' } });
    fireEvent.change(within(sheet).getByLabelText(/Name/), { target: { value: 'Journeys' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(client.updateTag).toHaveBeenCalledWith('t-1', {
        name: 'Journeys',
        labels: { de: 'Reisen', fr: 'Voyage' },
      }),
    );
  });
});

describe('term changes', () => {
  const term = {
    label: 'Travel',
    slug: 'travel',
    description: 'Trips',
    labels: { de: 'Reisen' },
    usage: { count: 0, byContentType: {} },
  };

  it('is empty when nothing changed, and clears a description emptied', () => {
    expect(
      termChanges(term, {
        label: 'Travel ',
        slug: 'travel',
        description: 'Trips',
        labels: { de: 'Reisen' },
      }),
    ).toEqual({});
    expect(
      termChanges(term, { label: 'Travel', slug: 'trips', description: ' ', labels: { de: '' } }),
    ).toEqual({ slug: 'trips', description: null, labels: {} });
  });

  it('says how many published entries carry a term', () => {
    expect(usageLine({ count: 0, byContentType: {} })).toBe('No published entry carries it yet.');
    expect(usageLine({ count: 1, byContentType: { article: 1 } })).toBe(
      'Carried by 1 published entry: 1 article.',
    );
  });
});

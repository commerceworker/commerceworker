// @vitest-environment jsdom
import type { ContentType } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewEntry } from '~/cms/lib/management';

const client = {
  getSingletonEntry: vi.fn<(apiId: string) => Promise<PreviewEntry | null>>(),
  listContentTypes: vi.fn<() => Promise<ContentType[]>>(),
  getSpaceConfig: vi.fn(async () => ({ defaultLocale: 'en-US', locales: ['en-US'] })),
  contentTypeEntryCounts: vi.fn(async () => []),
  saveContentType: vi.fn(),
  publishContentType: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { SingletonEntry } = await import('~/cms/routes/SingletonEntry');
const { ContentLayout } = await import('~/cms/routes/ContentLayout');
const { ContentTypeDialog } = await import('~/cms/components/ContentTypeDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const type = (apiId: string, name: string, singleton = false): ContentType =>
  ({
    apiId,
    name,
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
    ...(singleton ? { singleton: true } : {}),
  }) as ContentType;

/** Where the router ended up. */
function Here() {
  return <p data-testid="here">{useLocation().pathname}</p>;
}

function wrap(children: React.ReactNode, at: string, types: ContentType[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = {
    types,
    typesPending: false,
    locales: ['en-US'],
    defaultLocale: 'en-US',
    reload() {},
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route path=":typeId/entry" element={children} />
              <Route path="*" element={<Here />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const here = async () => (await screen.findByTestId('here')).textContent;

describe('opening a singleton type', () => {
  it('goes straight to its one entry’s editor', async () => {
    client.getSingletonEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'settings',
      status: 'draft',
      version: 1,
      fields: {},
    });
    wrap(<SingletonEntry />, '/content/settings/entry', [type('settings', 'Settings', true)]);
    expect(await here()).toBe('/content/settings/e1');
    expect(client.getSingletonEntry).toHaveBeenCalledWith('settings');
  });

  it('goes to a new entry when it has none', async () => {
    client.getSingletonEntry.mockResolvedValue(null);
    wrap(<SingletonEntry />, '/content/settings/entry', [type('settings', 'Settings', true)]);
    expect(await here()).toBe('/content/settings/new');
  });

  it('goes to the list of a type that is not a singleton, without asking for an entry', async () => {
    wrap(<SingletonEntry />, '/content/page/entry', [type('page', 'Page')]);
    expect(await here()).toBe('/content/page');
    expect(client.getSingletonEntry).not.toHaveBeenCalled();
  });

  it('offers to try again when the entry can’t be read', async () => {
    client.getSingletonEntry.mockRejectedValueOnce(new Error('down'));
    wrap(<SingletonEntry />, '/content/settings/entry', [type('settings', 'Settings', true)]);
    expect(await screen.findByText('Settings couldn’t be opened')).toBeTruthy();
    client.getSingletonEntry.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await here()).toBe('/content/settings/new');
  });
});

describe('the content sidebar', () => {
  it('links a singleton to its entry, and marks it current on that entry’s page', async () => {
    client.listContentTypes.mockResolvedValue([
      type('page', 'Page'),
      type('settings', 'Settings', true),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/content/settings/e1']}>
            <Routes>
              <Route path="/content" element={<ContentLayout />}>
                <Route path="*" element={<p>editor</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings.getAttribute('href')).toBe('/content/settings/entry');
    expect(settings.getAttribute('aria-current')).toBe('page');
    const page = screen.getByRole('link', { name: 'Page' });
    expect(page.getAttribute('href')).toBe('/content/page');
    expect(page.getAttribute('aria-current')).toBeNull();
  });
});

/**
 * The dialog's singleton checkbox, found by role within the dialog and told from the fields'
 * checkboxes by the label it points at (jsdom computes no name through `aria-labelledby` reliably).
 */
const singletonBox = () => {
  const box = within(screen.getByRole('dialog'))
    .getAllByRole('checkbox')
    .find((b) => b.getAttribute('aria-labelledby') === 'ct-singleton-label');
  if (!box) throw new Error('no singleton checkbox');
  expect(document.getElementById('ct-singleton-label')?.textContent).toMatch(/one entry only/i);
  return box;
};

describe('the content type dialog', () => {
  it('saves the singleton choice, and shows a saved one ticked', async () => {
    const onSave = vi.fn(async (_draft: unknown) => {});
    render(
      <ContentTypeDialog
        open
        onOpenChange={() => {}}
        initial={type('page', 'Page')}
        onSave={onSave}
      />,
    );
    const box = singletonBox();
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ apiId: 'page', singleton: true });
    cleanup();

    render(
      <ContentTypeDialog
        open
        onOpenChange={() => {}}
        initial={type('settings', 'Settings', true)}
        onSave={onSave}
      />,
    );
    expect(singletonBox().getAttribute('aria-checked')).toBe('true');
  });
});

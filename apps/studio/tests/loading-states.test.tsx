// How CMS screens say they're loading: the shape of what's coming, drawn where it will land under
// the parts already known, and one status line for assistive technology. Never "Loading…" on
// screen.
import type { ContentType } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntriesTable } from '~/cms/components/entries/EntriesTable';
import { PageSkeleton, Refreshing, rememberCount, rememberedCount } from '~/cms/components/loading';
import { ClientProvider } from '~/cms/lib/client-context';
import { ToastProvider } from '~/cms/lib/toast';
import { CmsPage } from '~/cms/providers';

vi.mock('~/lib/use-me', () => ({
  useMe: () => ({ kind: 'user', id: 'usr_1', name: 'Pat', role: 'admin' }),
  useCan: () => true,
}));

afterEach(cleanup);

/** Text a sighted reader sees: everything outside sr-only and aria-hidden subtrees. */
function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('.sr-only, [aria-hidden="true"]')) el.remove();
  return clone.textContent ?? '';
}

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Headline',
      type: 'Symbol',
      localized: true,
      required: false,
      position: 0,
    },
  ],
};

describe('a CMS page before its scope is known', () => {
  it('draws the real title over a skeleton and announces the load once', () => {
    // GET /spaces never answers: the page stays in its loading state.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const { container } = render(
      <MemoryRouter>
        <ToastProvider>
          <QueryClientProvider client={new QueryClient()}>
            <ClientProvider fetchImpl={fetchImpl}>
              <CmsPage title="Releases">
                <p>The releases</p>
              </CmsPage>
            </ClientProvider>
          </QueryClientProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Releases' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Loading Releases…');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(visibleText(container)).not.toMatch(/Loading/);
    expect(screen.queryByText('The releases')).toBeNull();
  });

  it('names what is loading when even the title is not known yet', () => {
    render(<PageSkeleton label="entries" title={<span className="sr-only">Entries</span>} />);
    expect(screen.getByRole('status').textContent).toBe('Loading entries…');
    expect(screen.getByRole('heading', { level: 1, name: 'Entries' })).toBeTruthy();
  });
});

describe('the entries table while its first page loads', () => {
  it('keeps the real column headers and draws hidden skeleton rows', () => {
    const { container } = render(
      <MemoryRouter>
        <EntriesTable
          type={ARTICLE}
          entries={[]}
          locale="en-US"
          picked={new Set()}
          busy
          viewingTrash={false}
          hrefFor={() => '/'}
          onPick={vi.fn()}
          onPickAll={vi.fn()}
          actions={{
            publish: vi.fn(),
            diff: vi.fn(),
            duplicate: vi.fn(),
            unpublish: vi.fn(),
            trash: vi.fn(),
            restore: vi.fn(),
            purge: vi.fn(),
          }}
          pending={4}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('columnheader', { name: 'Headline' })).toBeTruthy();
    // Selecting all of nothing does nothing: the box waits for the rows.
    expect(
      (screen.getByRole('checkbox', { name: 'Select all entries' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const placeholders = container.querySelectorAll('tbody tr[aria-hidden="true"]');
    expect(placeholders.length).toBe(4);
    // Nothing in a placeholder row is focusable or named.
    expect(container.querySelector('tbody a, tbody button')).toBeNull();
  });
});

describe('rows refreshing in place', () => {
  it('stays readable and marks the region busy only while a query runs', () => {
    const { container, rerender } = render(
      <Refreshing busy>
        <p>Spring launch</p>
      </Refreshing>,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getByText('Spring launch')).toBeTruthy();
    rerender(
      <Refreshing busy={false}>
        <p>Spring launch</p>
      </Refreshing>,
    );
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('.cw-refreshing-bar')).toBeNull();
  });
});

describe('the remembered skeleton length', () => {
  it('comes back as long as the list was, within bounds, else the default', () => {
    expect(rememberedCount('test:fresh')).toBe(6);
    rememberCount('test:short', 2);
    expect(rememberedCount('test:short')).toBe(2);
    rememberCount('test:long', 400);
    expect(rememberedCount('test:long')).toBe(12);
    rememberCount('test:empty', 0);
    expect(rememberedCount('test:empty')).toBe(1);
  });
});

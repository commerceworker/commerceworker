// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const types = [
  // An inherited key as a stored name: drawn as no icon, never looked up on the prototype.
  { apiId: 'post', name: 'Post', status: 'published', icon: 'constructor' },
  { apiId: 'faq', name: 'FAQ', status: 'published', group: 'A B', icon: 'calendar' },
  { apiId: 'page', name: 'Page', status: 'published', group: 'A-B', icon: 'calendar' },
];

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn: { space: 'demo', environment: 'main', locale: 'en-US' } }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useQueryKeys: () => ({ contentTypes: ['types'], spaceConfig: ['config'] }),
  useContentTypesQuery: () => ({ data: types, isPending: false }),
  useSpaceConfigQuery: () => ({ data: null }),
  useInvalidate: () => async () => {},
}));

vi.mock('~/cms/components/ContentTypeDeleteJob', () => ({
  useContentTypeDeleteJob: () => null,
}));

const { ContentLayout } = await import('~/cms/routes/ContentLayout');

afterEach(cleanup);

const renderNav = (at = '/content') =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <ContentLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('the content nav', () => {
  it('names each group’s list by its own heading, for names that differ only in punctuation', () => {
    renderNav();
    const ids = screen.getAllByRole('heading', { level: 3 }).map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByRole('list', { name: 'A B' }).textContent).toBe('FAQ');
    expect(screen.getByRole('list', { name: 'A-B' }).textContent).toBe('Page');
  });

  it('marks the open type’s icon in the brand accent, and keeps an empty slot for no icon', () => {
    renderNav('/content/faq');
    const icon = (name: string) =>
      screen.getByRole('link', { name }).querySelector('[aria-hidden="true"]');
    expect(icon('FAQ')?.getAttribute('class')).toContain('text-brand');
    expect(icon('Page')?.getAttribute('class')).not.toContain('text-brand');
    // `constructor` names no icon the admin knows: a reserved slot, not a crash.
    expect(icon('Post')?.tagName).toBe('SPAN');
  });
});

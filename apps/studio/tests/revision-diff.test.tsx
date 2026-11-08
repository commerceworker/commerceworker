// @vitest-environment jsdom
import {
  type ContentType,
  diffEntryFields,
  type EntryFields,
  type FieldDefinition,
} from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VersionDiff, VersionRef } from '~/cms/lib/management';

configure({ asyncUtilTimeout: 5000 });

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const article: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Headline', type: 'Symbol', localized: true }),
    field({ apiId: 'body', name: 'Body copy', type: 'RichText', position: 1 }),
    field({ apiId: 'hero', name: 'Hero image', type: 'Link', linkType: 'Asset', position: 2 }),
    field({
      apiId: 'sections',
      name: 'Sections',
      type: 'Array',
      position: 3,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'cta',
            name: 'Call to action',
            fields: [field({ apiId: 'label', type: 'Symbol' })],
          },
          {
            apiId: 'quote',
            name: 'Pull quote',
            fields: [field({ apiId: 'text', type: 'Symbol' })],
          },
        ],
      },
    }),
    field({ apiId: 'slug', name: 'Slug', type: 'Slug', position: 4 }),
  ],
};

const doc = (...blocks: [string, string][]) => ({
  nodeType: 'document',
  content: blocks.map(([nodeType, value]) => ({
    nodeType,
    content: [{ nodeType: 'text', value, marks: [] }],
  })),
});

const v1: EntryFields = {
  title: { 'en-US': 'Spring launch', 'de-DE': 'Frühlingsstart' },
  body: {
    'en-US': doc(
      ['heading-2', 'Plans'],
      ['paragraph', 'We ship in May.'],
      ['paragraph', 'Thanks.'],
    ),
  },
  hero: { 'en-US': { id: 'asset-1', linkType: 'Asset' } },
  sections: {
    'en-US': [
      { _type: 'cta', _key: 'k1', label: 'Buy now' },
      { _type: 'quote', _key: 'k2', text: 'Fast' },
    ],
  },
  slug: { 'en-US': 'spring' },
};
const v3: EntryFields = {
  title: { 'en-US': 'Summer launch', 'de-DE': 'Frühlingsstart' },
  body: {
    'en-US': doc(
      ['heading-2', 'Plans'],
      ['paragraph', 'We ship in June.'],
      ['paragraph', 'Thanks.'],
    ),
  },
  hero: { 'en-US': { id: 'asset-2', linkType: 'Asset' } },
  sections: {
    'en-US': [
      { _type: 'quote', _key: 'k2', text: 'Fast' },
      { _type: 'cta', _key: 'k1', label: 'Buy now' },
    ],
  },
  slug: { 'en-US': 'spring' },
};

const diffOf = (
  from: number,
  to: number,
  before: EntryFields,
  after: EntryFields,
): VersionDiff => ({
  entryId: 'e1',
  contentType: 'article',
  from,
  to,
  changes: diffEntryFields(before, after, article),
  hiddenChanges: 0,
});

const client = {
  listVersions: vi.fn(async (_id: string) => [
    { entryId: 'e1', version: 3, fields: v3, createdAt: new Date().toISOString() },
    { entryId: 'e1', version: 2, fields: v3, createdAt: new Date().toISOString() },
    { entryId: 'e1', version: 1, fields: v1, createdAt: new Date().toISOString() },
  ]),
  diffVersions: vi.fn(async (_id: string, from: VersionRef, to: VersionRef) =>
    to === 'published' ? diffOf(Number(from), 2, v1, v3) : diffOf(Number(from), 3, v1, v3),
  ),
  restoreVersion: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
  // As the real one does, it catches what the action throws (and toasts it).
  useLocalRun: () => ({
    busy: false,
    run: (fn: () => Promise<void>) => fn().catch(() => {}),
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { RevisionDiff } = await import('~/cms/components/RevisionDiff');
const { VersionHistory } = await import('~/cms/components/VersionHistory');

afterEach(() => vi.clearAllMocks());

describe('RevisionDiff', () => {
  const renderDiff = () =>
    render(
      <RevisionDiff
        diff={diffOf(1, 3, v1, v3)}
        contentType={article}
        fromLabel="v1"
        toLabel="v3 (current draft)"
      />,
    );

  it('never says no field changed while one the person can’t read did', () => {
    const none = { ...diffOf(1, 3, v1, v1), hiddenChanges: 1 };
    const view = render(<RevisionDiff diff={none} fromLabel="v1" toLabel="v3" />);
    expect(screen.getByText(/1 field you can’t read changed/)).toBeTruthy();
    expect(screen.queryByText(/No field changes/)).toBeNull();
    view.unmount();
    render(
      <RevisionDiff
        diff={{ ...diffOf(1, 3, v1, v3), hiddenChanges: 2 }}
        fromLabel="v1"
        toLabel="v3"
      />,
    );
    expect(screen.getByText(/4 fields changed · 2 fields you can’t read changed/)).toBeTruthy();
  });

  it('names each changed field as the content type does and counts the rest', () => {
    renderDiff();
    const region = screen.getByRole('region', { name: 'Changes from v1 to v3 (current draft)' });
    expect(within(region).getByText(/4 fields changed/)).toBeTruthy();
    const headings = within(region)
      .getAllByRole('heading', { level: 4 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Headline', 'Body copy', 'Hero image', 'Sections']);
    fireEvent.click(within(region).getByRole('button', { name: 'Show 1 unchanged field' }));
    expect(within(region).getByText('Slug')).toBeTruthy();
  });

  it('says added and removed words in words, not colour alone', () => {
    const { container } = renderDiff();
    const removed = [...container.querySelectorAll('del')].map((d) => d.textContent);
    const added = [...container.querySelectorAll('ins')].map((d) => d.textContent);
    expect(removed).toEqual(expect.arrayContaining(['Removed: Spring', 'Removed: May']));
    expect(added).toEqual(expect.arrayContaining(['Added: Summer', 'Added: June']));
  });

  it('shows only the locale that changed when there are several', () => {
    renderDiff();
    expect(screen.getAllByText('en-US').length).toBeGreaterThan(0);
    expect(screen.queryByText('de-DE')).toBeNull();
  });

  it('reads rich text by block, folding the unchanged ones', () => {
    renderDiff();
    expect(screen.getByText('Paragraph')).toBeTruthy();
    expect(screen.getByText('2 unchanged blocks not shown')).toBeTruthy();
  });

  it('names a swapped asset by id, and a moved block by its variant name', () => {
    renderDiff();
    expect(screen.getByText('asset-1')).toBeTruthy();
    expect(screen.getByText('asset-2')).toBeTruthy();
    expect(screen.getByText('Pull quote')).toBeTruthy();
    expect(screen.getAllByText('Moved').length).toBeGreaterThan(0);
  });

  it('says so when nothing changed', () => {
    render(<RevisionDiff diff={diffOf(3, 3, v3, v3)} fromLabel="v3" toLabel="v3" />);
    expect(screen.getByText(/No field changes/)).toBeTruthy();
  });
});

describe('VersionHistory compare', () => {
  const renderHistory = (isLive: boolean) =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ToastProvider>
          <VersionHistory
            entryId="e1"
            currentVersion={3}
            publishedVersion={isLive ? 2 : null}
            isLive={isLive}
            contentType={article}
            onRestored={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
  /** The panel starts folded, as it does beside the editor. */
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Version history' }));

  it('compares a version with the current draft, then with the live version', async () => {
    renderHistory(true);
    open();
    const compare = await screen.findByRole('button', { name: 'Compare version 1' });
    fireEvent.click(compare);
    await waitFor(() => expect(client.diffVersions).toHaveBeenCalledWith('e1', 1, 'draft'));
    expect(
      await screen.findByRole('region', { name: 'Changes from v1 to v3 (current draft)' }),
    ).toBeTruthy();
    const live = screen.getByRole('button', { name: 'Live version' });
    expect(live.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(live);
    await waitFor(() => expect(client.diffVersions).toHaveBeenCalledWith('e1', 1, 'published'));
    expect(
      await screen.findByRole('region', { name: 'Changes from v1 to v2 (live)' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Live version' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // The same button hides it again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide changes since version 1' }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('offers no live comparison for an entry that is not live', async () => {
    renderHistory(false);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Compare version 2' }));
    await screen.findByRole('region');
    expect(screen.queryByRole('button', { name: 'Live version' })).toBeNull();
  });

  it('asks in place before a restore, since the version it replaces stays in the list', async () => {
    client.restoreVersion.mockClear();
    renderHistory(false);
    open();
    const [restore] = await screen.findAllByRole('button', { name: 'Restore' });
    fireEvent.click(restore as HTMLElement);

    const ask = await screen.findByRole('alertdialog', { name: /Restore version 2\?/ });
    // In the list, not over the page, and the safe choice has focus.
    expect(ask.closest('li')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(ask).getByRole('button', { name: 'Keep current draft' }),
      ),
    );

    fireEvent.click(within(ask).getByRole('button', { name: 'Keep current draft' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.restoreVersion).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(restore);

    fireEvent.click(restore as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(client.restoreVersion).toHaveBeenCalledWith('e1', 2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('keeps the question up when the restore is refused', async () => {
    client.restoreVersion.mockReset();
    client.restoreVersion.mockRejectedValueOnce(new Error('Refused'));
    renderHistory(false);
    open();
    const [restore] = await screen.findAllByRole('button', { name: 'Restore' });
    fireEvent.click(restore as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(client.restoreVersion).toHaveBeenCalled());
    expect(await screen.findByRole('alertdialog', { name: /Restore version 2\?/ })).toBeTruthy();
  });
});

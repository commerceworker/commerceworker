// @vitest-environment jsdom
// What publishing would change, as the confirm card, the page's confirmation and the entries list's
// diff all read it: field names and link titles rather than API ids and JSON, each changed locale,
// unchanged fields behind a disclosure, and honest words when the diff can't be read.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EntryDiff,
  FIRST_PUBLISH,
  NO_CHANGES,
  reviewFields,
} from '~/cms/components/entries/EntryReview';
import { PublishConfirm } from '~/cms/components/entries/PublishConfirm';
import { ApiError, type ManagementClient, type PreviewEntry } from '~/cms/lib/management';

const entry = { id: 'e1', contentType: 'article', status: 'changed', fields: {} } as PreviewEntry;
const field = (
  apiId: string,
  name: string | undefined,
  fieldType: string,
  before: unknown,
  after: unknown,
  locale = 'en-US',
) => ({
  field: apiId,
  ...(name ? { name } : {}),
  fieldType,
  kind: JSON.stringify(before) === JSON.stringify(after) ? 'unchanged' : 'changed',
  locales: [
    {
      locale,
      kind: JSON.stringify(before) === JSON.stringify(after) ? 'unchanged' : 'changed',
      before,
      after,
    },
  ],
});

const author = (id: string) => ({ id, linkType: 'Entry' });
const changes = [
  field('author', 'Written by', 'Link', author('a1'), author('a2')),
  field('hero', 'Hero image', 'Link', null, { id: 'as1', linkType: 'Asset' }),
  field('reviewers', 'Reviewers', 'Array', [author('a1')], [author('a1'), author('a3')]),
  field('seo', 'Search', 'Seo', { metaTitle: 'Old' }, { metaTitle: 'New', _key: 'x' }),
  field('data', 'Raw data', 'JSON', { a: 1 }, { a: 2 }),
  field('summary', 'Summary', 'Text', 'Same', 'Same'),
];

const client = {
  diffVersions: vi.fn(),
  getEntry: vi.fn(),
  listEntries: vi.fn(),
  listContentTypes: vi.fn(),
  getAsset: vi.fn(),
};
const asClient = client as unknown as ManagementClient;

beforeEach(() => {
  client.diffVersions.mockReset().mockResolvedValue({ changes });
  client.getEntry.mockReset();
  client.listContentTypes
    .mockReset()
    .mockResolvedValue([{ apiId: 'person', name: 'Person', displayField: 'name', fields: [] }]);
  client.listEntries.mockReset().mockResolvedValue([
    { id: 'a1', contentType: 'person', status: 'published', fields: { name: { 'en-US': 'Ada' } } },
    {
      id: 'a2',
      contentType: 'person',
      status: 'published',
      fields: { name: { 'en-US': 'Grace' } },
    },
  ]);
  client.getAsset.mockReset().mockResolvedValue({
    id: 'as1',
    title: { 'en-US': 'Harbour at dawn' },
    file: { fileName: 'harbour.jpg' },
  });
});

const diffOf = () => render(<EntryDiff client={asClient} entry={entry} locale="en-US" />);

describe('the diff', () => {
  it('counts only what changed, by the field’s name, with its links by title', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    const list = screen.getByRole('list', { name: 'Changes' });
    expect(within(list).getByText('Written by')).toBeTruthy();
    expect(within(list).queryByText('author')).toBeNull();
    expect(within(list).getAllByText('Ada').length).toBe(2);
    expect(within(list).getByText('Grace')).toBeTruthy();
    expect(within(list).getByText('Harbour at dawn')).toBeTruthy();
    expect(within(list).getByText('Ada, Linked entry')).toBeTruthy();
    expect(list.textContent).not.toContain('linkType');
    expect(list.textContent).not.toContain('a2');
    // One request for every linked entry, however many fields link them.
    expect(client.listEntries).toHaveBeenCalledOnce();
  });

  it('reads a group of fields line by line, and leaves a JSON field its JSON', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.getByText('Meta title: Old')).toBeTruthy();
    expect(screen.queryByText(/_key/)).toBeNull();
    expect(screen.getByText(/"a": 2/)).toBeTruthy();
  });

  it('labels every value, so stacked they still say which is which', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText('Published').nextSibling?.textContent).toBe('Ada');
    expect(within(row).getByText('Draft').nextSibling?.textContent).toBe('Grace');
  });

  it('keeps unchanged fields behind a disclosure', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.queryByText('Same')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show 1 unchanged field' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Unchanged fields' }).textContent).toContain('Same');
    expect(more.textContent).toBe('Hide unchanged fields');
  });

  it('says a link it couldn’t resolve is a link, never its id', async () => {
    client.listEntries.mockRejectedValue(new Error('down'));
    client.getAsset.mockRejectedValue(new Error('down'));
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.getAllByText('Linked entry').length).toBe(3);
    expect(screen.getByText('Linked entry, Linked entry')).toBeTruthy();
    expect(screen.getByText('Linked asset')).toBeTruthy();
  });

  it('says an entry never published has nothing to compare', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(404, 'EntryVersion not found'));
    client.getEntry.mockResolvedValue({ ...entry, status: 'draft' });
    diffOf();
    await screen.findByText('No published version');
  });

  it('says nothing changed in words, not as a zero', async () => {
    client.diffVersions.mockResolvedValue({ changes: [changes[5]], hiddenChanges: 0 });
    diffOf();
    await screen.findByText('No field changes');
    expect(screen.queryByText(/0 fields changed/)).toBeNull();
  });

  it('says a read that failed failed, not that nothing was published', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(500, 'boom'));
    diffOf();
    await screen.findByText('Couldn’t load what changed');
    expect(screen.queryByText('No published version')).toBeNull();
  });
});

describe('changes this person can’t read', () => {
  const hidden = (n: number, list: unknown[]) =>
    client.diffVersions.mockResolvedValue({ changes: list, hiddenChanges: n });

  it('are counted beside what they can read, never named', async () => {
    hidden(2, changes);
    diffOf();
    await screen.findByText('2 fields you can’t read also go live.');
    expect(screen.getByText('5 fields changed · 2 fields you can’t read changed')).toBeTruthy();
  });

  it('say so alone when nothing readable changed', async () => {
    hidden(1, [changes[5]]);
    diffOf();
    await screen.findByText('1 field you can’t read goes live.');
  });

  it('are the count when nothing readable changed, never “0 fields changed”', async () => {
    hidden(1, [changes[5]]);
    diffOf();
    await screen.findByText('1 field you can’t read changed');
    expect(screen.queryByText(/0 fields changed/)).toBeNull();
    expect(screen.queryByText('No field changes')).toBeNull();
  });

  it('are carried from the editor’s own diff, in place of “nothing changed”', () => {
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        changes={[]}
        hiddenChanges={1}
        compare={{ client: asClient, entry, locale: 'en-US' }}
        busy={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('1 field you can’t read goes live.')).toBeTruthy();
    expect(screen.queryByText(NO_CHANGES)).toBeNull();
  });

  describe('alone in the editor’s own diff, right after a save', () => {
    const confirm = (props: Partial<Parameters<typeof PublishConfirm>[0]> = {}) =>
      render(
        <PublishConfirm
          open
          onOpenChange={vi.fn()}
          title="Pricing"
          status="changed"
          changes={[]}
          hiddenChanges={1}
          compare={{ client: asClient, entry, locale: 'en-US' }}
          busy={false}
          onConfirm={vi.fn()}
          {...props}
        />,
      );
    const warning = () =>
      screen.getByText('1 field you can’t read goes live.').closest('[data-slot="alert"]');

    it('are a warning Alert, not the dialog’s description', () => {
      confirm();
      expect(warning()?.className).toContain('bg-wait/10');
      const dialog = screen.getByRole('alertdialog');
      const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
      // Inside the description, so a screen reader hears it with the question.
      expect(description?.textContent).toBe(
        'The draft replaces what’s live now.1 field you can’t read goes live.',
      );
    });

    it('still confirm at once, reading nothing, and with nothing to compare too', () => {
      const onConfirm = vi.fn();
      const view = confirm({ onConfirm });
      const publish = screen.getByRole('button', { name: 'Publish entry' }) as HTMLButtonElement;
      expect(publish.disabled).toBe(false);
      fireEvent.click(publish);
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(client.diffVersions).not.toHaveBeenCalled();
      view.unmount();

      confirm({ compare: undefined as never });
      expect(warning()).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Publish entry' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });
});

describe('what the confirmation says above the list', () => {
  const lead = () => {
    const dialog = screen.getByRole('alertdialog');
    return document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent;
  };
  const dialog = (props: Partial<Parameters<typeof PublishConfirm>[0]> = {}) =>
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        compare={{ client: asClient, entry, locale: 'en-US' }}
        busy={false}
        onConfirm={vi.fn()}
        {...props}
      />,
    );

  it('says the draft matches only once a read has shown it, and counts nothing twice', async () => {
    client.diffVersions.mockResolvedValue({ changes: [changes[5]], hiddenChanges: 0 });
    dialog();
    expect(lead()).toBe('The draft replaces what’s live now.');
    await waitFor(() => expect(lead()).toBe(NO_CHANGES));
    expect(screen.queryByText('No field changes')).toBeNull();
  });

  it('never says the draft matches while a field the person can’t read changed', async () => {
    client.diffVersions.mockResolvedValue({ changes: [changes[5]], hiddenChanges: 1 });
    dialog();
    await screen.findByText('1 field you can’t read goes live.');
    expect(lead()).toBe('The draft replaces what’s live now.');
    expect(screen.getByText('1 field you can’t read changed')).toBeTruthy();
  });

  it('promises no list it can’t show when the read fails', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(500, 'boom'));
    dialog();
    await screen.findByText('Couldn’t load what changed');
    expect(lead()).toBe('The draft replaces what’s live now.');
  });

  it('says a whole entry goes live when the read finds nothing was published', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(404, 'EntryVersion not found'));
    client.getEntry.mockResolvedValue({ ...entry, status: 'draft' });
    dialog();
    await screen.findByText('No published version');
    expect(lead()).toBe(FIRST_PUBLISH);
    expect(screen.getByRole('button', { name: 'Keep as draft' })).toBeTruthy();
  });

  it('counts the editor’s diff as the review does: a field added empty isn’t a change', () => {
    const empty = {
      field: 'note',
      kind: 'added',
      locales: [{ locale: 'en-US', kind: 'unchanged', after: null }],
    };
    const view = dialog({ changes: [empty] as never });
    expect(lead()).toBe(NO_CHANGES);
    expect(screen.queryByRole('region', { name: 'What changes' })).toBeNull();
    view.unmount();

    dialog({ changes: [empty, changes[0]] as never });
    expect(lead()).toBe('1 field goes live:');
  });
});

describe('Publish entry, until the dialog can show what goes live', () => {
  const reason = 'You can’t publish until this can show what goes live.';
  const onConfirm = vi.fn();
  const dialog = (props: Partial<Parameters<typeof PublishConfirm>[0]> = {}) =>
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        compare={{ client: asClient, entry, locale: 'en-US' }}
        busy={false}
        onConfirm={onConfirm}
        {...props}
      />,
    );
  const publish = () => screen.getByRole('button', { name: 'Publish entry' }) as HTMLButtonElement;
  const cancel = () =>
    screen.getByRole('button', { name: 'Keep live version' }) as HTMLButtonElement;
  const describedBy = () =>
    document.getElementById(publish().getAttribute('aria-describedby') ?? '')?.textContent;

  beforeEach(() => onConfirm.mockReset());

  it('is off while the read is pending, saying so, and Cancel still answers', async () => {
    let arrive = (_: unknown) => {};
    client.diffVersions.mockReturnValue(new Promise((r) => (arrive = r)));
    const onOpenChange = vi.fn();
    dialog({ onOpenChange });
    expect(publish().disabled).toBe(true);
    expect(describedBy()).toMatch(/still comparing/);
    fireEvent.click(publish());
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => arrive({ changes, hiddenChanges: 0 }));
    await screen.findByText('5 fields changed');
    expect(publish().disabled).toBe(false);
    expect(publish().getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(cancel());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('is off after a failed read, in words, with Cancel free', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(500, 'boom'));
    dialog();
    await screen.findByText('Couldn’t load what changed');
    expect(publish().disabled).toBe(true);
    expect(describedBy()).toBe(reason);
    expect(screen.getByText(reason).getAttribute('role')).toBe('status');
    expect(cancel().disabled).toBe(false);
  });

  it('reads again on Try again, keeps focus on Cancel, and comes on once it can show', async () => {
    client.diffVersions.mockRejectedValueOnce(new ApiError(500, 'boom'));
    dialog();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(document.activeElement).toBe(cancel()));
    await screen.findByText('5 fields changed');
    expect(client.diffVersions).toHaveBeenCalledTimes(2);
    expect(publish().disabled).toBe(false);
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('hands focus to Cancel if it turns off while focused', async () => {
    const view = dialog({ changes: [changes[0]] as never });
    await screen.findByText('Grace');
    publish().focus();
    view.rerender(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    expect(publish().disabled).toBe(true);
    expect(document.activeElement).toBe(cancel());
  });

  it('confirms a first publish, reading nothing', () => {
    dialog({ status: 'draft' });
    expect(publish().disabled).toBe(false);
    expect(client.diffVersions).not.toHaveBeenCalled();
  });

  it('confirms a publish that changes nothing, and one that changes only hidden fields', async () => {
    const none = dialog({ changes: [] });
    expect(publish().disabled).toBe(false);
    none.unmount();
    const hiddenOnly = dialog({ changes: [], hiddenChanges: 1 });
    expect(publish().disabled).toBe(false);
    hiddenOnly.unmount();
    client.diffVersions.mockResolvedValue({ changes: [changes[5]], hiddenChanges: 1 });
    dialog();
    await screen.findByText('1 field you can’t read goes live.');
    expect(publish().disabled).toBe(false);
  });

  it('stays on with the editor’s own diff and no entry to compare: nothing can fail', () => {
    dialog({ compare: undefined as never, changes: [changes[0]] as never });
    expect(publish().disabled).toBe(false);
    expect(client.diffVersions).not.toHaveBeenCalled();
  });

  it('is off with nothing to compare and no diff: it can show nothing', () => {
    dialog({ compare: undefined as never });
    expect(publish().disabled).toBe(true);
    expect(describedBy()).toBe(reason);
  });
});

describe('the page’s confirmation with no entry to compare', () => {
  it('still says what the person can’t read goes live', () => {
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        changes={[changes[0]] as never}
        hiddenChanges={2}
        busy={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('list', { name: 'Changed fields' }).textContent).toContain(
      'Written by',
    );
    expect(screen.getByText('2 fields you can’t read also go live.')).toBeTruthy();
  });
});

describe('reviewFields', () => {
  it('shows each locale that changed, and names it only when there are several', () => {
    const two = {
      field: 'title',
      name: 'Title',
      fieldType: 'Symbol',
      kind: 'changed',
      locales: [
        { locale: 'de-DE', kind: 'unchanged', before: 'Alt', after: 'Alt' },
        { locale: 'en-US', kind: 'changed', before: 'Old', after: 'New' },
      ],
    } as never;
    expect(reviewFields([two], 'en-US')[0]?.rows).toEqual([
      { locale: 'en-US', before: 'Old', after: 'New' },
    ]);
  });

  it('names a field the content type no longer declares by its humanized id', () => {
    const gone = field('old_note', undefined, 'Text', 'a', 'b') as never;
    expect(reviewFields([gone], 'en-US')[0]?.name).toBe('Old note');
  });

  it('treats a field added with nothing in it as unchanged', () => {
    const empty = {
      field: 'note',
      kind: 'added',
      locales: [{ locale: 'en-US', kind: 'unchanged', after: null }],
    } as never;
    expect(reviewFields([empty], 'en-US')[0]?.kind).toBe('unchanged');
  });
});

describe('the page’s confirmation', () => {
  const dialog = (props: Partial<Parameters<typeof PublishConfirm>[0]> = {}) =>
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        compare={{ client: asClient, entry, locale: 'en-US' }}
        busy={false}
        onConfirm={vi.fn()}
        {...props}
      />,
    );

  it('makes its scroller reachable by keyboard, with a name', async () => {
    dialog();
    await screen.findByText('5 fields changed');
    const region = screen.getByRole('region', { name: 'What changes' });
    expect(region.tabIndex).toBe(0);
    expect(within(region).getByText('Grace')).toBeTruthy();
  });

  it('reviews the editor’s own diff without reading it again', async () => {
    const known = [changes[0]] as never;
    dialog({ changes: known });
    await screen.findByText('Grace');
    expect(screen.getByText('1 field goes live:')).toBeTruthy();
    expect(screen.queryByText('1 field changed')).toBeNull();
    expect(client.diffVersions).not.toHaveBeenCalled();
  });

  it('shows no comparison for a first publish, or when nothing changed', () => {
    const first = dialog({ status: 'draft' });
    expect(screen.queryByRole('region', { name: 'What changes' })).toBeNull();
    expect(client.diffVersions).not.toHaveBeenCalled();
    first.unmount();
    dialog({ changes: [] });
    expect(screen.queryByRole('region', { name: 'What changes' })).toBeNull();
  });
});

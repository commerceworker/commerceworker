// @vitest-environment jsdom
import type { ContentType, ContentTypeDraft, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { EntryForm } from '~/cms/components/EntryForm';
import { ContentTypeIcon } from '~/cms/lib/content-type-icons';
import { groupContentTypes } from '~/cms/routes/ContentLayout';

// jsdom ships neither; radix's Select and Tabs reach for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const EVENT: ContentType = {
  apiId: 'event',
  name: 'Event',
  displayField: 'title',
  version: 1,
  status: 'published',
  group: 'Programme',
  description: 'Something on the calendar.',
  icon: 'calendar',
  layout: {
    tabs: [
      { apiId: 'main', name: 'Main', groups: [{ fields: ['title', 'day'] }] },
      {
        apiId: 'more',
        name: 'More',
        groups: [
          { name: 'Contact', fields: ['email'], collapsed: true },
          { name: 'Timing', fields: ['at', 'opens'] },
        ],
      },
    ],
  },
  fields: [
    field({ apiId: 'title', name: 'Title' }),
    field({ apiId: 'day', name: 'Day', type: 'Date', format: 'date', position: 1 }),
    field({ apiId: 'email', name: 'Email', position: 2, required: true }),
    field({ apiId: 'at', name: 'Starts', type: 'Date', format: 'datetime', position: 3 }),
    field({ apiId: 'opens', name: 'Doors', type: 'Date', format: 'time', position: 4 }),
    field({
      apiId: 'sizes',
      name: 'Sizes',
      type: 'Array',
      position: 5,
      items: { type: 'Integer' },
    }),
  ],
};

function renderForm(contentType = EVENT, initial = {}, onSave = vi.fn()) {
  render(
    <EntryForm
      contentType={contentType}
      initial={initial}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [] }}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

describe('the content nav', () => {
  it('lists ungrouped types first, then each group by name', () => {
    const sections = groupContentTypes([
      { apiId: 'b', group: 'Shop' },
      { apiId: 'a' },
      { apiId: 'c', group: 'Docs' },
      { apiId: 'd', group: 'Shop' },
    ]);
    expect(sections.map((s) => [s.group, s.types.map((t) => t.apiId)])).toEqual([
      [undefined, ['a']],
      ['Docs', ['c']],
      ['Shop', ['b', 'd']],
    ]);
  });

  it('draws a known icon, hidden from assistive tech, and nothing for an unknown one', () => {
    const { container } = render(
      <>
        <ContentTypeIcon name="calendar" />
        <ContentTypeIcon name="no-such-icon" />
        <ContentTypeIcon name="constructor" />
        <ContentTypeIcon name="to-string" />
      </>,
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the entry form with a layout', () => {
  it('draws the tabs, a named group, and a collapsed group closed', () => {
    renderForm();
    expect(screen.getByRole('tab', { name: 'Main' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('Day').getAttribute('type')).toBe('date');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect(screen.getByRole('region', { name: 'Timing' })).toBeTruthy();
    const contact = screen.getByRole('button', { name: 'Contact' });
    expect(contact.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    fireEvent.click(contact);
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
  });

  it('a field the layout does not place follows on the first tab', () => {
    renderForm();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('button', { name: 'Add item' })).toBeTruthy();
  });

  it('goes to the tab with an error on a rejected save, and opens its group', async () => {
    const onSave = renderForm();
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /More/ }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('names a collapsed group by a heading, and offers to open it from the error summary', async () => {
    renderForm();
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByLabelText(/Email/)).toBeTruthy());
    const heading = screen.getByRole('heading', { level: 3, name: 'Contact' });
    // Closed again by hand: the summary's line becomes a button that reopens it.
    fireEvent.click(within(heading).getByRole('button', { name: 'Contact' }));
    await waitFor(() => expect(screen.queryByLabelText(/Email/)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Email \(en-US\): Field is required/ }));
    await waitFor(() => expect(screen.getByLabelText(/Email/)).toBeTruthy());
  });

  it('moves focus with the list: to an added row, then the next row or Add after a remove', () => {
    renderForm(EVENT, { sizes: { 'en-US': [1, 2] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Sizes item 3'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sizes item 1' }));
    // The row that took its place, now item 1, holding 2.
    expect(document.activeElement).toBe(screen.getByLabelText('Sizes item 1'));
    expect((document.activeElement as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sizes item 2' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add item' }));
  });

  it('marks the row a rejected save names, and links it to its message', () => {
    renderForm(EVENT, { email: { 'en-US': 'a@b.co' }, sizes: { 'en-US': [1, 1.5] } });
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    const second = screen.getByLabelText('Sizes item 2');
    expect(second.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(
      second.getAttribute('aria-describedby')?.split(' ')[0] ?? '',
    );
    expect(message?.textContent).toBe('Expected an integer');
    expect(screen.getByLabelText('Sizes item 1').getAttribute('aria-invalid')).toBeNull();
  });

  it('finds a row’s error by its place in the value, which leaves out an emptied row', () => {
    renderForm(EVENT, { email: { 'en-US': 'a@b.co' }, sizes: { 'en-US': [1, 1.5] } });
    // Item 1 emptied: the value is [1.5], so the error at sizes[0] belongs to the second row.
    fireEvent.change(screen.getByLabelText('Sizes item 1'), { target: { value: '' } });
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    expect(screen.getByLabelText('Sizes item 2').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Sizes item 1').getAttribute('aria-invalid')).toBeNull();
  });

  it('takes a date and time, a time of day and a list of numbers, saved as numbers', () => {
    const onSave = renderForm(EVENT, { email: { 'en-US': 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Sizes item 1'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Sizes item 2'), { target: { value: '14' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect(screen.getByLabelText('Starts').getAttribute('type')).toBe('datetime-local');
    expect(screen.getByLabelText('Doors').getAttribute('type')).toBe('time');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-03T14:30' } });
    fireEvent.change(screen.getByLabelText('Doors'), { target: { value: '19:00' } });
    fireEvent.submit(screen.getByLabelText('Starts').closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        day: { 'en-US': '2026-11-03' },
        at: { 'en-US': '2026-11-03T14:30' },
        opens: { 'en-US': '19:00' },
        sizes: { 'en-US': [12, 14] },
      }),
    );
  });

  it('shows a stored date and time with an offset to the minute, and keeps it unless changed', () => {
    const onSave = renderForm(EVENT, {
      email: { 'en-US': 'a@b.co' },
      at: { 'en-US': '2026-11-03T14:30:00Z' },
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect((screen.getByLabelText('Starts') as HTMLInputElement).value).toBe('2026-11-03T14:30');
    fireEvent.submit(screen.getByLabelText('Starts').closest('form') as HTMLFormElement);
    expect(onSave.mock.calls[0]?.[0].at).toEqual({ 'en-US': '2026-11-03T14:30:00Z' });
  });
});

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({
      apiId: 'title',
      name: 'Title',
      validations: { regexp: { pattern: '^x' }, messages: { regexp: 'Start with x' } },
    }),
    field({ apiId: 'day', name: 'Day', type: 'Date', position: 1 }),
    field({
      apiId: 'poster',
      name: 'Poster',
      type: 'Link',
      linkType: 'Asset',
      position: 2,
      validations: { assetMimeTypes: ['image/*'], messages: { assetMimeTypes: 'Images only' } },
    }),
    field({
      apiId: 'sizes',
      name: 'Sizes',
      type: 'Array',
      position: 3,
      items: { type: 'Integer' },
    }),
    field({ apiId: 'opens', name: 'Opens', type: 'Date', format: 'time', position: 4 }),
  ],
};

async function saveDialog(initial: ContentType | undefined, act: () => void) {
  const onSave = vi.fn<(d: ContentTypeDraft) => Promise<void>>(async () => {});
  render(<ContentTypeDialog open onOpenChange={() => {}} initial={initial} onSave={onSave} />);
  act();
  fireEvent.click(screen.getByRole('button', { name: /Save changes|Create content type/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0]?.[0] as ContentTypeDraft;
}

const byId = (draft: ContentTypeDraft, apiId: string) =>
  draft.fields.find((f) => f.apiId === apiId) as FieldDefinition;

describe('the content type dialog', () => {
  it('round-trips a type untouched: no layout sent, list and time fields as stored', async () => {
    const draft = await saveDialog(ARTICLE, () => {});
    expect(draft).not.toHaveProperty('layout');
    expect(draft).toMatchObject({
      group: null,
      description: null,
      icon: null,
      agentInstructions: null,
    });
    expect(byId(draft, 'sizes').items).toEqual({ type: 'Integer' });
    expect(byId(draft, 'opens').format).toBe('time');
    expect(byId(draft, 'title').validations).toEqual(ARTICLE.fields[0]?.validations);
  });

  it('keeps an icon name it cannot draw, an inherited key included', async () => {
    const draft = await saveDialog({ ...ARTICLE, icon: 'constructor' }, () => {
      expect(screen.getByRole('option', { name: 'constructor (not drawn here)' })).toBeTruthy();
    });
    expect(draft.icon).toBe('constructor');
  });

  it('keeps the agent instructions it was opened with', async () => {
    const draft = await saveDialog({ ...ARTICLE, agentInstructions: 'Stay factual.' }, () => {});
    expect(draft.agentInstructions).toBe('Stay factual.');
  });

  it('clears agent instructions left blank', async () => {
    const draft = await saveDialog({ ...ARTICLE, agentInstructions: 'Stay factual.' }, () => {
      fireEvent.change(screen.getByLabelText('Agent instructions'), { target: { value: ' ' } });
    });
    expect(draft.agentInstructions).toBeNull();
  });

  it('keeps the preview URL it was opened with, and clears one left blank', async () => {
    const urlTemplate = 'https://site.example/__preview?entry={id}&token={token}';
    const kept = await saveDialog({ ...ARTICLE, preview: { urlTemplate } }, () => {});
    expect(kept.preview).toEqual({ urlTemplate });
    cleanup();
    const cleared = await saveDialog({ ...ARTICLE, preview: { urlTemplate } }, () => {
      fireEvent.change(screen.getByLabelText('Preview URL'), { target: { value: ' ' } });
    });
    expect(cleared.preview).toBeNull();
  });

  it('says on the field why a preview URL can’t be saved, and saves nothing', async () => {
    const onSave = vi.fn<(d: ContentTypeDraft) => Promise<void>>(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={ARTICLE} onSave={onSave} />);
    const input = screen.getByLabelText('Preview URL');
    fireEvent.change(input, { target: { value: 'http://site.example/p/{id}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    // The field is usually below the fold: it takes focus, so it and its error come into view.
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-describedby')).toContain('ct-preview-error');
    expect(document.getElementById('ct-preview-error')?.textContent).toMatch(/https/);
    expect(onSave).not.toHaveBeenCalled();
    // Typing withdraws the error.
    fireEvent.change(input, { target: { value: 'https://site.example/p/{id}?t={token}' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0].preview).toEqual({
      urlTemplate: 'https://site.example/p/{id}?t={token}',
    });
  });

  it('withdraws a preview URL error once the template passes, even when the save then fails', async () => {
    const onSave = vi.fn<(d: ContentTypeDraft) => Promise<void>>(async () => {
      throw new Error('offline');
    });
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={ARTICLE} onSave={onSave} />);
    const input = screen.getByLabelText('Preview URL');
    // Names a field the type doesn't have, then one it does (the field list is ARTICLE's).
    fireEvent.change(input, { target: { value: 'https://site.example/{field:nope}?t={token}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(input, { target: { value: 'https://site.example/p?t={token}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById('ct-preview-error')).toBeNull();
  });

  it('saves a group, description and icon', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Editorial' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Long reads' } });
      fireEvent.change(screen.getByLabelText('Icon'), { target: { value: 'newspaper' } });
      fireEvent.change(screen.getByLabelText('Agent instructions'), {
        target: { value: 'Stay factual.' },
      });
    });
    expect(draft).toMatchObject({
      group: 'Editorial',
      description: 'Long reads',
      icon: 'newspaper',
      agentInstructions: 'Stay factual.',
    });
  });

  it('builds a layout from tabs and each field’s tab and group', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
      fireEvent.change(screen.getByLabelText('Name of tab 2'), { target: { value: 'Media' } });
      fireEvent.change(screen.getByLabelText('Tab for Title'), { target: { value: 'content' } });
      fireEvent.change(screen.getByLabelText('Tab for Day'), { target: { value: 'content' } });
      fireEvent.change(screen.getByLabelText('Tab for Poster'), { target: { value: 'tab2' } });
      fireEvent.change(screen.getByLabelText('Group for Poster'), { target: { value: 'Art' } });
    });
    expect(draft.layout).toEqual({
      tabs: [
        { apiId: 'content', name: 'Content', groups: [{ fields: ['title', 'day'] }] },
        { apiId: 'tab2', name: 'Media', groups: [{ name: 'Art', fields: ['poster'] }] },
      ],
    });
  });

  it('clears the layout when its last tab goes', async () => {
    const draft = await saveDialog({ ...ARTICLE, layout: EVENT.layout }, () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove tab Main' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove tab More' }));
    });
    expect(draft.layout).toBeNull();
  });

  it('sets a Date format and range, a pattern preset and asset file types', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Day/ }));
      fireEvent.change(screen.getByLabelText('Format for Day'), { target: { value: 'date' } });
      fireEvent.change(screen.getByLabelText('Earliest value for Day'), {
        target: { value: '2026-01-01' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Title/ }));
      fireEvent.change(screen.getByLabelText('Pattern for Title'), { target: { value: 'email' } });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Poster/ }));
      fireEvent.change(screen.getByLabelText('Allowed file types for Poster'), {
        target: { value: 'image/*, application/pdf' },
      });
    });
    expect(byId(draft, 'day')).toMatchObject({
      format: 'date',
      validations: { dateRange: { min: '2026-01-01' } },
    });
    // The preset replaces the custom pattern; its message stays, since the rule does.
    expect(byId(draft, 'title').validations).toEqual({
      regexp: { preset: 'email' },
      messages: { regexp: 'Start with x' },
    });
    expect(byId(draft, 'poster').validations).toEqual({
      assetMimeTypes: ['image/*', 'application/pdf'],
      messages: { assetMimeTypes: 'Images only' },
    });
  });

  it('drops the message of a rule it clears', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Title/ }));
      fireEvent.change(screen.getByLabelText('Pattern for Title'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Poster/ }));
      fireEvent.change(screen.getByLabelText('Allowed file types for Poster'), {
        target: { value: '' },
      });
    });
    expect(byId(draft, 'title').validations).toBeUndefined();
    expect(byId(draft, 'poster').validations).toBeUndefined();
  });

  it('offers a time of day on any Date', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Day/ }));
      fireEvent.change(screen.getByLabelText('Format for Day'), { target: { value: 'time' } });
    });
    expect(byId(draft, 'day').format).toBe('time');
  });

  it('chooses what a list of values holds, and leaves a list of links as it was', async () => {
    const related = field({
      apiId: 'related',
      name: 'Related',
      type: 'Array',
      position: 5,
      items: { type: 'Link', linkType: 'Entry' },
    });
    const draft = await saveDialog({ ...ARTICLE, fields: [...ARTICLE.fields, related] }, () => {
      expect(screen.queryByLabelText('Items for Related')).toBeNull();
      const items = screen.getByLabelText('Items for Sizes');
      expect(
        within(items)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Symbol', 'Text', 'Integer', 'Number', 'Date']);
      fireEvent.change(items, { target: { value: 'Number' } });
    });
    expect(byId(draft, 'sizes').items).toEqual({ type: 'Number' });
    expect(byId(draft, 'related').items).toEqual({ type: 'Link', linkType: 'Entry' });
  });
});

// @vitest-environment jsdom
// The entry editor's side pane: the draft read as a document (live from the form, in the form's
// locale, references by name, links never followed) and the divider that sizes it.
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';
import { EntryPreview } from '~/cms/components/EntryPreview';
import { PaneDivider } from '~/cms/components/pane/PaneDivider';

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

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', localized: true }),
    field({ apiId: 'author', name: 'Author', type: 'Link', linkType: 'Entry', position: 1 }),
    field({ apiId: 'body', name: 'Body', type: 'RichText', position: 2 }),
    field({ apiId: 'featured', name: 'Featured', type: 'Boolean', position: 3 }),
    field({ apiId: 'summary', name: 'Summary', type: 'Text', position: 4 }),
  ],
};

const PICKERS = { entries: [{ id: 'e-ada', label: 'Ada Lovelace' }], assets: [] };
const LOCALES = { defaultLocale: 'en-US', locales: ['en-US', 'de-DE'], fallbacks: {} };

const doc = (...content: unknown[]) => ({ nodeType: 'document', content });
const text = (value: string, marks: string[] = []) => ({
  nodeType: 'text',
  value,
  marks: marks.map((type) => ({ type })),
});

describe('EntryPreview', () => {
  it('reads the draft as a document: the display field as its title, every other field by name', () => {
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{
          title: { 'en-US': 'Hello' },
          author: { 'en-US': { id: 'e-ada', linkType: 'Entry' } },
          body: {
            'en-US': doc({
              nodeType: 'paragraph',
              content: [text('Bold', ['bold']), text(' move')],
            }),
          },
          featured: { 'en-US': false },
        }}
        locale="en-US"
        localeConfig={LOCALES}
        pickers={PICKERS}
      />,
    );
    const preview = screen.getByRole('article', { name: 'Preview' });
    expect(within(preview).getByRole('heading', { name: 'Hello' })).toBeTruthy();
    expect(within(preview).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(preview).getByText('Bold').tagName).toBe('STRONG');
    expect(within(preview).getByText('No')).toBeTruthy();
    // An empty field says so rather than vanishing.
    expect(within(preview).getByText('Summary').nextElementSibling?.textContent).toBe('Empty');
  });

  it('falls back to the default locale where the form’s locale has no value', () => {
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{ title: { 'en-US': 'Hello' } }}
        locale="de-DE"
        localeConfig={{ ...LOCALES, fallbacks: { 'de-DE': 'en-US' } }}
        pickers={PICKERS}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy();
    expect(screen.getByText(/Article · de-DE/)).toBeTruthy();
  });

  it('shows a link’s target but never makes it a link, so a draft can’t carry a script URL', () => {
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{
          body: {
            'en-US': doc({
              nodeType: 'paragraph',
              content: [
                {
                  nodeType: 'hyperlink',
                  data: { uri: 'javascript:alert(1)' },
                  content: [text('click')],
                },
              ],
            }),
          },
        }}
        locale="en-US"
        localeConfig={LOCALES}
        pickers={PICKERS}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('click').getAttribute('title')).toBe('javascript:alert(1)');
  });

  it('draws a table as a grid, header cells and spans included', () => {
    const cell = (nodeType: string, value: string, data = {}) => ({
      nodeType,
      data,
      content: [{ nodeType: 'paragraph', content: [text(value)] }],
    });
    const row = (...content: unknown[]) => ({ nodeType: 'table-row', data: {}, content });
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{
          body: {
            'en-US': doc({
              nodeType: 'table',
              data: {},
              content: [
                row(cell('table-header-cell', 'Plan'), cell('table-header-cell', 'Price')),
                row(cell('table-cell', 'Contact us', { colspan: 2 })),
              ],
            }),
          },
        }}
        locale="en-US"
        localeConfig={LOCALES}
        pickers={PICKERS}
      />,
    );
    const grid = screen.getByRole('table');
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Plan', 'Price']);
    expect(within(grid).getByRole('cell', { name: 'Contact us' }).getAttribute('colspan')).toBe(
      '2',
    );
  });

  it('reads a malformed table as its text rather than drawing broken markup', () => {
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{
          body: {
            'en-US': doc(
              { nodeType: 'table', content: [text('loose text')] },
              // A row of a table missing its cells, and a row with no table at all.
              { nodeType: 'table', content: [{ nodeType: 'table-row', content: [] }] },
              { nodeType: 'table-row', content: [text('stray row')] },
            ),
          },
        }}
        locale="en-US"
        localeConfig={LOCALES}
        pickers={PICKERS}
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('row')).toBeNull();
    expect(screen.getByText('loose text')).toBeTruthy();
    expect(screen.getByText('stray row')).toBeTruthy();
  });

  it('follows the form as it is typed in', () => {
    const onValuesChange = vi.fn();
    render(
      <EntryForm
        contentType={ARTICLE}
        initial={{ title: { 'en-US': 'Draft' } }}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={PICKERS}
        onValuesChange={onValuesChange}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(onValuesChange).toHaveBeenLastCalledWith({ title: { 'en-US': 'Draft' } }, 'en-US');
    fireEvent.change(screen.getByDisplayValue('Draft'), { target: { value: 'Final' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({ title: { 'en-US': 'Final' } }, 'en-US');
  });
});

describe('PaneDivider', () => {
  const divider = (share = 0.4) => {
    const onCommit = vi.fn();
    const onReset = vi.fn();
    render(
      <PaneDivider
        share={share}
        min={0.3}
        max={0.6}
        onChange={() => {}}
        onCommit={onCommit}
        onReset={onReset}
        controls="entry-pane"
      />,
    );
    return {
      sep: screen.getByRole('separator', { name: 'Resize the side pane' }),
      onCommit,
      onReset,
    };
  };

  it('is an ARIA splitter whose value is the pane’s share', () => {
    const { sep } = divider();
    expect(sep.getAttribute('aria-valuenow')).toBe('40');
    expect(sep.getAttribute('aria-valuemin')).toBe('30');
    expect(sep.getAttribute('aria-valuemax')).toBe('60');
    expect(sep.getAttribute('aria-controls')).toBe('entry-pane');
    expect(sep.tabIndex).toBe(0);
  });

  it('moves with the arrow keys, within its limits, and Enter puts it back', () => {
    const { sep, onCommit, onReset } = divider(0.58);
    act(() => void fireEvent.keyDown(sep, { key: 'ArrowLeft' }));
    expect(onCommit).toHaveBeenLastCalledWith(0.6);
    act(() => void fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true }));
    expect(onCommit.mock.lastCall?.[0]).toBeCloseTo(0.48);
    act(() => void fireEvent.keyDown(sep, { key: 'End' }));
    expect(onCommit).toHaveBeenLastCalledWith(0.3);
    act(() => void fireEvent.keyDown(sep, { key: 'Enter' }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
import type { ContentType, FieldDefinition, FieldRule } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { EntryForm } from '~/cms/components/EntryForm';

// jsdom ships neither; radix's Select (the dialog's type menu) reaches for both.
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

const hideUnlessSold: FieldRule = {
  action: 'hide',
  when: { field: 'status', operator: 'ne', value: 'sold' },
};

const LISTING: ContentType = {
  apiId: 'listing',
  name: 'Listing',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', required: true }),
    field({ apiId: 'status', name: 'Status', position: 1 }),
    field({
      apiId: 'soldTo',
      name: 'Sold to',
      position: 2,
      required: true,
      rules: [hideUnlessSold],
    }),
    field({
      apiId: 'reference',
      name: 'Reference',
      position: 3,
      rules: [{ action: 'disable', when: { field: 'status', operator: 'eq', value: 'sold' } }],
    }),
    field({
      apiId: 'cta',
      name: 'Call to action',
      type: 'Component',
      position: 4,
      fields: [
        field({ apiId: 'kind', name: 'Kind' }),
        field({
          apiId: 'url',
          name: 'URL',
          position: 1,
          rules: [{ action: 'hide', when: { field: 'kind', operator: 'ne', value: 'link' } }],
        }),
      ],
    }),
  ],
};

function renderForm(initial = {}, onSave = vi.fn()) {
  render(
    <EntryForm
      contentType={LISTING}
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

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('conditional field rules on the entry form', () => {
  it('hides a field while its sibling does not match, and shows it live when it does', () => {
    renderForm();
    expect(screen.queryByLabelText(/^Sold to/)).toBeNull();
    type('Status', 'sold');
    expect(screen.getByLabelText(/^Sold to/)).toBeTruthy();
    type('Status', 'open');
    expect(screen.queryByLabelText(/^Sold to/)).toBeNull();
  });

  it('a hidden required field does not block a save', () => {
    const onSave = renderForm();
    type(/^Title/, 'Flat');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledWith({ title: { 'en-US': 'Flat' } });
  });

  it('a disabled field shows and sends its stored value, and says why', () => {
    const stored = {
      title: { 'en-US': 'Flat' },
      status: { 'en-US': 'open' },
      reference: { 'en-US': 'REF-1' },
    };
    const onSave = renderForm(stored);
    type('Reference', 'REF-2');
    type('Status', 'sold');
    type(/^Sold to/, 'Ada');
    const reference = screen.getByLabelText('Reference') as HTMLInputElement;
    // Read-only, not disabled: it stays in the tab order and reads its reason on focus.
    expect(reference.matches(':disabled')).toBe(false);
    expect(reference.readOnly).toBe(true);
    expect(reference.getAttribute('aria-readonly')).toBe('true');
    expect(reference.value).toBe('REF-1');
    // Typing into it changes nothing.
    type('Reference', 'REF-3');
    expect(reference.value).toBe('REF-1');
    const why = screen.getByText('Read-only while Status is "sold"');
    expect(reference.getAttribute('aria-describedby')).toContain(why.id);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ reference: { 'en-US': 'REF-1' }, status: { 'en-US': 'sold' } }),
    );
  });

  it('tells a screen reader which fields an edit showed, hid or locked', () => {
    renderForm({ title: { 'en-US': 'Flat' }, status: { 'en-US': 'open' } });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    type('Status', 'sold');
    expect(status.textContent).toBe('Sold to shown. Reference read-only.');
    type('Status', 'open');
    expect(status.textContent).toBe('Sold to hidden. Reference editable.');
  });

  it('disables a button-like widget its rules lock, by the fieldset around it', () => {
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          fields: [
            field({ apiId: 'title', name: 'Title' }),
            field({ apiId: 'status', name: 'Status', position: 1 }),
            field({
              apiId: 'featured',
              name: 'Featured',
              type: 'Boolean',
              position: 2,
              rules: [
                { action: 'disable', when: { field: 'status', operator: 'eq', value: 'sold' } },
              ],
            }),
          ],
        }}
        initial={{ title: { 'en-US': 'T' }, status: { 'en-US': 'sold' } }}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={vi.fn()}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('checkbox').matches(':disabled')).toBe(true);
  });

  it('names a hidden field that still holds a value, so two fields hiding each other can be cleared', () => {
    const notEmpty = (sibling: string): FieldRule => ({
      action: 'hide',
      when: { field: sibling, operator: 'notEmpty' },
    });
    const onSave = vi.fn();
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          fields: [
            field({ apiId: 'title', name: 'Title' }),
            field({ apiId: 'url', name: 'URL', position: 1, rules: [notEmpty('link')] }),
            field({ apiId: 'link', name: 'Link', position: 2, rules: [notEmpty('url')] }),
          ],
        }}
        initial={{ title: { 'en-US': 'T' }, url: { 'en-US': 'https://x' }, link: { 'en-US': 'l' } }}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    // Both hidden, both holding a value: neither is drawn as an input, each says so.
    expect(screen.queryByLabelText('URL')).toBeNull();
    expect(
      screen.getByText(/is hidden while Link is not empty, but still holds a value/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear URL' }));
    // With URL empty, Link opens; URL, hidden and empty, is drawn no more.
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toBe('l');
    expect(screen.queryByRole('button', { name: 'Clear URL' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear Link' })).toBeNull();
  });

  it('names a hidden field its rules also lock read-only, with nothing to clear', () => {
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          fields: [
            field({ apiId: 'title', name: 'Title' }),
            field({ apiId: 'status', name: 'Status', position: 1 }),
            field({
              apiId: 'ref',
              name: 'Reference',
              position: 2,
              rules: [
                { action: 'hide', when: { field: 'status', operator: 'eq', value: 'sold' } },
                { action: 'disable', when: { field: 'status', operator: 'notEmpty' } },
              ],
            }),
          ],
        }}
        initial={{ title: { 'en-US': 'T' }, status: { 'en-US': 'sold' }, ref: { 'en-US': 'R-9' } }}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={vi.fn()}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Reference')).toBeNull();
    expect(
      screen.getByText(
        /is hidden while Status is "sold", and keeps the value it holds: it is read-only while Status is not empty\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear Reference' })).toBeNull();
  });

  it('hides a nested field by its component sibling', () => {
    renderForm();
    expect(screen.queryByLabelText('URL')).toBeNull();
    type('Kind', 'link');
    expect(screen.getByLabelText('URL')).toBeTruthy();
  });
});

describe('conditional field rules in the content type dialog', () => {
  const saved = async (onSave: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0]?.[0] as { fields: FieldDefinition[] } | undefined)?.fields ?? [];
  };

  it('adds a rule to a field and saves it', async () => {
    const onSave = vi.fn(async () => {});
    const plain = { ...LISTING, fields: LISTING.fields.slice(0, 2) };
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={plain} onSave={onSave} />);
    const toggle = screen.getByRole('button', { name: 'Rules for Title' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('group', { name: 'Rules for Title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add rule to Title' }));
    fireEvent.change(screen.getByLabelText('Action for Title rule 1'), {
      target: { value: 'disable' },
    });
    fireEvent.change(screen.getByLabelText('Field read by Title rule 1'), {
      target: { value: 'status' },
    });
    fireEvent.change(screen.getByLabelText('Comparison for Title rule 1'), {
      target: { value: 'in' },
    });
    fireEvent.change(screen.getByLabelText('Value for Title rule 1'), {
      target: { value: 'sold, let' },
    });
    // Numbers only compare number fields.
    expect(screen.queryByRole('option', { name: 'is more than' })).toBeNull();
    const fields = await saved(onSave);
    expect(fields.find((f) => f.apiId === 'title')?.rules).toEqual([
      { action: 'disable', when: { field: 'status', operator: 'in', value: ['sold', 'let'] } },
    ]);
    expect(fields.find((f) => f.apiId === 'status')?.rules).toBeUndefined();
  });

  it('carries a rule it cannot draw through untouched, and keeps it beside new ones', async () => {
    const dotted: FieldRule = {
      action: 'hide',
      when: { field: 'cta.kind', operator: 'eq', value: 'none' },
    };
    const withDotted: ContentType = {
      ...LISTING,
      fields: LISTING.fields.map((f) =>
        f.apiId === 'soldTo' ? { ...f, rules: [hideUnlessSold, dotted] } : f,
      ),
    };
    const onSave = vi.fn(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={withDotted} onSave={onSave} />);
    // Open from the start, with the drawable rule as a row and the other one counted.
    expect(screen.getByRole('group', { name: 'Rules for Sold to' })).toBeTruthy();
    expect(screen.getByText(/1 rule reads a field inside a component/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Value for Sold to rule 1'), {
      target: { value: 'let' },
    });
    const fields = await saved(onSave);
    expect(fields.find((f) => f.apiId === 'soldTo')?.rules).toEqual([
      { action: 'hide', when: { field: 'status', operator: 'ne', value: 'let' } },
      dotted,
    ]);
  });

  it('leaves stored rules as they are when the editor is not touched', async () => {
    const onSave = vi.fn(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={LISTING} onSave={onSave} />);
    const fields = await saved(onSave);
    expect(fields.find((f) => f.apiId === 'soldTo')?.rules).toEqual([hideUnlessSold]);
    expect(fields.find((f) => f.apiId === 'cta')?.fields).toEqual(LISTING.fields[4]?.fields);
  });
});

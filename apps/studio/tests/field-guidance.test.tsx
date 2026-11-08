// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const LISTING: ContentType = {
  apiId: 'listing',
  name: 'Listing',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({
      apiId: 'title',
      name: 'Title',
      required: true,
      help: 'Lead with the neighbourhood.',
      placeholder: 'Sunny two-bed in Leith',
      description: 'The headline of the listing.',
    }),
    field({
      apiId: 'status',
      name: 'Status',
      position: 1,
      validations: {
        in: [{ value: 'open', label: 'Open for viewings' }, 'let'],
        messages: { in: 'Pick a status from the list' },
      },
    }),
    field({
      apiId: 'beds',
      name: 'Bedrooms',
      type: 'Integer',
      position: 2,
      validations: {
        in: [
          { value: 1, label: 'One' },
          { value: 2, label: 'Two' },
        ],
      },
    }),
    field({
      apiId: 'cta',
      name: 'Call to action',
      type: 'Component',
      position: 3,
      fields: [field({ apiId: 'label', name: 'Label', help: 'Two or three words.' })],
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

describe('field guidance on the entry form', () => {
  it('shows the help line under the input, describing it, and the placeholder in it', () => {
    renderForm();
    const title = screen.getByLabelText(/^Title/);
    expect(title.getAttribute('placeholder')).toBe('Sunny two-bed in Leith');
    const help = screen.getByText('Lead with the neighbourhood.');
    expect(title.getAttribute('aria-describedby')).toContain(help.id);
    // The description is for agents and API readers, not every entry form.
    expect(screen.queryByText('The headline of the listing.')).toBeNull();
    // A nested field's help shows under its own input.
    expect(screen.getByText('Two or three words.')).toBeTruthy();
  });

  it('offers listed values by label and saves the value, a number as a number', () => {
    const onSave = renderForm();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Flat' } });
    const status = screen.getByLabelText('Status');
    const labels = within(status)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['None', 'Open for viewings', 'let']);
    fireEvent.change(status, { target: { value: 'open' } });
    fireEvent.change(screen.getByLabelText('Bedrooms'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: { 'en-US': 'open' }, beds: { 'en-US': 2 } }),
    );
  });

  it('keeps a stored value the list no longer offers, and reports the rule’s own message', () => {
    const onSave = renderForm({ title: { 'en-US': 'Flat' }, status: { 'en-US': 'sold' } });
    expect((screen.getByLabelText('Status') as unknown as HTMLSelectElement).value).toBe('sold');
    expect(screen.getByRole('option', { name: 'sold (not listed)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Pick a status from the list/).length).toBeGreaterThan(0);
  });
});

describe('field guidance on other inputs', () => {
  it('links the help line to a rich-text editor', () => {
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          fields: [
            field({ apiId: 'body', name: 'Body', type: 'RichText', help: 'Keep it short.' }),
          ],
        }}
        initial={{}}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={vi.fn()}
        onCancel={() => {}}
      />,
    );
    const help = screen.getByText('Keep it short.');
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toContain(help.id);
  });

  it('offers a legacy list once per value, without an empty or unusable option', () => {
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          fields: [
            field({
              apiId: 'tone',
              name: 'Tone',
              validations: { in: ['a', 'a', '', true as never] },
            }),
          ],
        }}
        initial={{}}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={vi.fn()}
        onCancel={() => {}}
      />,
    );
    const labels = within(screen.getByLabelText('Tone'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['None', 'a']);
  });
});

describe('a clashing legacy list', () => {
  it('offers the option of the field’s type once, and saves a number for an Integer', () => {
    const onSave = vi.fn();
    render(
      <EntryForm
        contentType={{
          ...LISTING,
          displayField: 'beds',
          fields: [
            field({ apiId: 'beds', name: 'Beds', type: 'Integer', validations: { in: ['1', 1] } }),
          ],
        }}
        initial={{}}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const beds = screen.getByLabelText('Beds');
    expect(
      within(beds)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None', '1']);
    fireEvent.change(beds, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledWith({ beds: { 'en-US': 1 } });
  });
});

describe('field guidance in the content type dialog', () => {
  const saved = async (onSave: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0]?.[0] as { fields: FieldDefinition[] } | undefined)?.fields ?? [];
  };

  it('opens on a field that has guidance, and edits and clears it', async () => {
    const onSave = vi.fn(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={LISTING} onSave={onSave} />);
    const help = screen.getByLabelText('Help text for Title');
    expect((help as HTMLInputElement).value).toBe('Lead with the neighbourhood.');
    fireEvent.change(help, { target: { value: 'Start with the street.' } });
    fireEvent.change(screen.getByLabelText('Placeholder for Title'), { target: { value: ' ' } });

    // A field without guidance starts closed and opens on request; one with guidance says so
    // while closed.
    fireEvent.click(screen.getByRole('button', { name: 'Guidance for Title' }));
    expect(screen.getByRole('button', { name: 'Guidance for Title, set' }).textContent).toContain(
      '· set',
    );
    const toggle = screen.getByRole('button', { name: 'Guidance for Status' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('group', { name: 'Guidance for Status' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Description for Status'), {
      target: { value: 'Drives the badge on the card.' },
    });

    const fields = await saved(onSave);
    const title = fields.find((f) => f.apiId === 'title');
    expect(title?.help).toBe('Start with the street.');
    expect(title?.placeholder).toBeUndefined();
    expect(title?.description).toBe('The headline of the listing.');
    const status = fields.find((f) => f.apiId === 'status');
    expect(status?.description).toBe('Drives the badge on the card.');
    // Labelled options and messages authored elsewhere ride through untouched.
    expect(status?.validations).toEqual(LISTING.fields[1]?.validations);
  });
});

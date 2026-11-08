// @vitest-environment jsdom
import type { ComponentVariant, ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { EntryForm } from '~/cms/components/EntryForm';
import { EntryPreview } from '~/cms/components/EntryPreview';

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

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [field({ apiId: 'heading', name: 'Heading', required: true })],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [
    field({ apiId: 'label', name: 'Label', required: true }),
    field({ apiId: 'style', name: 'Style', position: 1, defaultValue: 'primary' }),
  ],
};

const blocksField = (variants: ComponentVariant[], over: Partial<FieldDefinition> = {}) =>
  field({
    apiId: 'body',
    name: 'Body',
    type: 'Array',
    position: 1,
    items: { type: 'Component', variants },
    ...over,
  });

const typeWith = (fields: FieldDefinition[]): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [field({ apiId: 'name', name: 'Name' }), ...fields],
});

const PAGE = typeWith([blocksField([HERO, CTA])]);

function renderForm(contentType: ContentType, initial = {}, onSave = vi.fn()) {
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

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
const savedBody = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[0]?.[0].body['en-US'];

/** Opens the "Add block" menu (Radix opens on pointerdown) and picks a block type. */
async function addBlock(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add block to Body' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('editing a blocks field', () => {
  it('says when there are no blocks yet', () => {
    renderForm(PAGE);
    expect(screen.getByText('No blocks yet.')).toBeTruthy();
  });

  it('adds a block of the type picked, starting from its defaults', async () => {
    const onSave = renderForm(PAGE);
    await addBlock('Call to action');
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    save();
    expect(savedBody(onSave)).toEqual([{ _type: 'cta', style: 'primary', label: 'Go' }]);
  });

  it("edits each block with its own type's fields and keeps _type and _key", () => {
    const onSave = renderForm(PAGE, {
      body: {
        'en-US': [
          { _type: 'hero', _key: 'k1', heading: 'Hi' },
          { _type: 'cta', _key: 'k2', label: 'Go' },
        ],
      },
    });
    expect(screen.getByLabelText(/^Heading/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Read more' } });
    save();
    expect(savedBody(onSave)).toEqual([
      { _type: 'hero', _key: 'k1', heading: 'Hi' },
      { _type: 'cta', _key: 'k2', label: 'Read more' },
    ]);
  });

  it('reorders and removes the block each control names', () => {
    const onSave = renderForm(PAGE, {
      body: {
        'en-US': [
          { _type: 'hero', _key: 'k1', heading: 'Hi' },
          { _type: 'cta', _key: 'k2', label: 'Go' },
          { _type: 'cta', _key: 'k3', label: 'More' },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move Call to action block 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Call to action block 3' }));
    save();
    expect(savedBody(onSave).map((b: { _key: string }) => b._key)).toEqual(['k2', 'k1']);
  });

  it('names the block, by type, in the error summary', () => {
    const onSave = renderForm(PAGE, {
      name: { 'en-US': 'Home' },
      body: { 'en-US': [{ _type: 'cta', label: 'Go' }, { _type: 'hero' }] },
    });
    save();
    expect(onSave).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Body 2 \(Hero\) › Heading/)).toBeTruthy();
  });

  it('shows a block of an unknown type without an editor, and lets it be removed', () => {
    const onSave = renderForm(PAGE, {
      name: { 'en-US': 'Home' },
      body: {
        'en-US': [
          { _type: 'quote', _key: 'q', text: 'x' },
          { _type: 'hero', heading: 'Hi' },
        ],
      },
    });
    expect(screen.getByText(/type “quote” is not in the content model/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Unknown block 1' }));
    save();
    expect(savedBody(onSave)).toEqual([{ _type: 'hero', heading: 'Hi' }]);
  });

  it('turns adding off at size.max, and offers a single type as a plain button', () => {
    renderForm(typeWith([blocksField([HERO], { validations: { size: { max: 1 } } })]), {
      body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
    });
    const add = screen.getByRole('button', { name: 'Add hero' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText('Holds one block.')).toBeTruthy();
  });
});

describe('previewing blocks', () => {
  it('draws each block under its type name', () => {
    render(
      <EntryPreview
        contentType={PAGE}
        fields={{
          name: { 'en-US': 'Home' },
          body: {
            'en-US': [
              { _type: 'hero', heading: 'Big news' },
              { _type: 'cta', label: 'Go' },
            ],
          },
        }}
        locale="en-US"
        localeConfig={{ defaultLocale: 'en-US', locales: ['en-US'] }}
        pickers={{ entries: [], assets: [] }}
      />,
    );
    expect(screen.getByText('Hero')).toBeTruthy();
    expect(screen.getByText('Big news')).toBeTruthy();
    expect(screen.getByText('Call to action')).toBeTruthy();
  });
});

describe('authoring block types in the content type dialog', () => {
  const renderDialog = (initial: ContentType, onSave = vi.fn(async () => {})) => {
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={initial} onSave={onSave} />);
    return onSave;
  };
  const saved = async (onSave: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0]?.[0] as { fields: FieldDefinition[] } | undefined)?.fields ?? [];
  };

  it('loads the block types and saves them back unchanged', async () => {
    const onSave = renderDialog(PAGE);
    expect(screen.getByDisplayValue('Call to action')).toBeTruthy();
    const body = (await saved(onSave)).find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'cta']);
    expect(body?.items?.fields).toBeUndefined();
    // What the editor doesn't show rides along.
    expect(body?.items?.variants?.[1]?.fields[1]?.defaultValue).toBe('primary');
  });

  it('adds a block type with a field', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: /add block type/i }));
    fireEvent.change(screen.getByLabelText('Name for block type 3 of Body'), {
      target: { value: 'Quote' },
    });
    fireEvent.change(screen.getByLabelText('Name for field 1 of Quote'), {
      target: { value: 'Text' },
    });
    fireEvent.change(screen.getByLabelText('Type for Text in Quote'), {
      target: { value: 'Text' },
    });
    const body = (await saved(onSave)).find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.[2]).toEqual({
      apiId: 'quote',
      name: 'Quote',
      fields: [
        {
          apiId: 'text',
          name: 'Text',
          type: 'Text',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    });
  });

  it('gives a link field in a block its target', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: /add field to call to action/i }));
    fireEvent.change(screen.getByLabelText('Name for field 3 of Call to action'), {
      target: { value: 'Target' },
    });
    fireEvent.change(screen.getByLabelText('Type for Target in Call to action'), {
      target: { value: 'Link' },
    });
    fireEvent.change(screen.getByLabelText('Link target for Target in Call to action'), {
      target: { value: 'Asset' },
    });
    const cta = (await saved(onSave)).find((f) => f.apiId === 'body')?.items?.variants?.[1];
    expect(cta?.fields[2]).toMatchObject({ apiId: 'target', type: 'Link', linkType: 'Asset' });
  });

  it('refuses to save a block type with no fields, saying which', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Heading from Hero' }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Body › Hero: add at least one field.')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('offers Blocks as a field type', async () => {
    renderDialog(typeWith([]));
    fireEvent.click(screen.getAllByRole('combobox', { name: /^Type for/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Blocks');
  });
});

// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';

// jsdom ships neither; radix's Select reaches for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// radix's Select scrolls the highlighted option into view.
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

/**
 * A type whose fields carry configuration this dialog cannot edit — the exact
 * material that used to be discarded by opening the dialog and pressing save.
 */
const RICH: ContentType = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  version: 3,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: true,
      required: true,
      position: 0,
      validations: { size: { max: 120 } },
    },
    {
      apiId: 'author',
      name: 'Author',
      type: 'Link',
      linkType: 'Entry',
      localized: false,
      required: false,
      position: 1,
      validations: { linkContentTypes: ['person'] },
    },
    {
      apiId: 'cards',
      name: 'Cards',
      type: 'Array',
      localized: false,
      required: false,
      position: 2,
      items: {
        type: 'Component',
        fields: [
          {
            apiId: 'heading',
            name: 'Heading',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
        ],
      },
    },
  ],
};

const renderDialog = (onSave = vi.fn(async () => {})) => {
  render(<ContentTypeDialog open onOpenChange={() => {}} initial={RICH} onSave={onSave} />);
  return onSave;
};

const saved = async (onSave: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  const [firstCall] = onSave.mock.calls;
  return (firstCall?.[0] as { fields: FieldDefinition[] } | undefined)?.fields ?? [];
};

describe('editing a content type does not destroy what it cannot edit', () => {
  it('keeps a Link field’s target configuration', async () => {
    // This dialog edits six attributes; a definition has more than a dozen.
    // Rebuilding fields from the rows dropped the rest on every save.
    const fields = await saved(renderDialog());
    const author = fields.find((f) => f.apiId === 'author');
    expect(author?.linkType).toBe('Entry');
    expect(author?.validations?.linkContentTypes).toEqual(['person']);
  });

  it('keeps a component’s nested shape', async () => {
    const fields = await saved(renderDialog());
    const cards = fields.find((f) => f.apiId === 'cards');
    expect(cards?.items?.type).toBe('Component');
    expect(cards?.items?.fields?.[0]?.apiId).toBe('heading');
  });

  it('keeps validations authored through the API', async () => {
    const fields = await saved(renderDialog());
    expect(fields.find((f) => f.apiId === 'title')?.validations?.size?.max).toBe(120);
  });

  it('still applies the edits the dialog does make', async () => {
    const onSave = renderDialog();
    fireEvent.change(screen.getByDisplayValue('Title'), { target: { value: 'Headline' } });
    const fields = await saved(onSave);
    const title = fields.find((f) => f.apiId === 'title');
    expect(title?.name).toBe('Headline');
    // ...without losing the configuration alongside it.
    expect(title?.validations?.size?.max).toBe(120);
  });
});

describe('the type dropdown', () => {
  it('does not offer to create a component it cannot give a shape', async () => {
    renderDialog();
    // A component with no fields is refused by the domain, so offering the type
    // without nested-field authoring would only produce a save that fails.
    fireEvent.click(screen.getAllByRole('combobox', { name: /^Type for/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Symbol');
    expect(options).not.toContain('Component');
  });
});

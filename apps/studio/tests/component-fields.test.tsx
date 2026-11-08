// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';

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

const CARD: FieldDefinition[] = [
  field({ apiId: 'title', name: 'Title', required: true }),
  field({ apiId: 'body', name: 'Body', type: 'Text', position: 1 }),
];

const typeWith = (fields: FieldDefinition[]): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [field({ apiId: 'name', name: 'Name', position: 0 }), ...fields],
});

const COMPONENT = typeWith([
  field({ apiId: 'hero', name: 'Hero', type: 'Component', fields: CARD, position: 1 }),
]);

const REPEATER = typeWith([
  field({
    apiId: 'cards',
    name: 'Cards',
    type: 'Array',
    items: { type: 'Component', fields: CARD },
    position: 1,
  }),
]);

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

describe('required fields', () => {
  it('say so in their name, with an asterisk in muted ink rather than an error colour', () => {
    renderForm(typeWith([field({ apiId: 'title', name: 'Title', required: true, position: 1 })]));
    const input = screen.getByRole('textbox', { name: 'Title (required)' });
    expect(input).toBeTruthy();
    const mark = screen.getByText('*');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.className).not.toMatch(/destructive|bad/);
  });
});

describe('editing a component', () => {
  it('renders an input per nested field, not a JSON blob', () => {
    renderForm(COMPONENT);
    // The raw-JSON fallback was usable and awful; these are real inputs.
    expect(screen.getByLabelText(/^Title/)).toBeTruthy();
    expect(screen.getByLabelText(/^Body/)).toBeTruthy();
  });

  it('saves nested values as one object under the component field', () => {
    const onSave = renderForm(COMPONENT);
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText(/^Body/), { target: { value: 'World' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Page' } });
    save();
    expect(onSave).toHaveBeenCalledWith({
      name: { 'en-US': 'Page' },
      hero: { 'en-US': { title: 'Hello', body: 'World' } },
    });
  });

  it('loads existing nested values into their inputs', () => {
    renderForm(COMPONENT, { hero: { 'en-US': { title: 'Existing' } } });
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Existing');
  });

  it('keeps a sibling nested value when one is edited', () => {
    const onSave = renderForm(COMPONENT, { hero: { 'en-US': { title: 'Keep', body: 'Also' } } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Changed' } });
    save();
    expect(onSave.mock.calls[0]?.[0].hero['en-US']).toEqual({ title: 'Changed', body: 'Also' });
  });
});

describe('editing a repeater', () => {
  it('starts empty and says so', () => {
    renderForm(REPEATER);
    expect(screen.getByText(/nothing here yet/i)).toBeTruthy();
  });

  it('adds an item and edits it', () => {
    const onSave = renderForm(REPEATER);
    fireEvent.click(screen.getByRole('button', { name: /add card/i }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'First' } });
    save();
    expect(onSave.mock.calls[0]?.[0].cards['en-US']).toEqual([{ title: 'First' }]);
  });

  it('numbers items from one, the way a person counts them', () => {
    renderForm(REPEATER, { cards: { 'en-US': [{ title: 'a' }, { title: 'b' }] } });
    expect(screen.getByText('Card 1')).toBeTruthy();
    expect(screen.getByText('Card 2')).toBeTruthy();
  });

  it('removes the item that was asked for, not the last one', () => {
    const onSave = renderForm(REPEATER, {
      cards: { 'en-US': [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Card 2' }));
    save();
    expect(onSave.mock.calls[0]?.[0].cards['en-US']).toEqual([{ title: 'a' }, { title: 'c' }]);
  });

  it('reorders without losing anything', () => {
    const onSave = renderForm(REPEATER, {
      cards: { 'en-US': [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move Card 3 up' }));
    save();
    expect(onSave.mock.calls[0]?.[0].cards['en-US']).toEqual([
      { title: 'a' },
      { title: 'c' },
      { title: 'b' },
    ]);
  });

  it('cannot move the first item up or the last down', () => {
    renderForm(REPEATER, { cards: { 'en-US': [{ title: 'a' }, { title: 'b' }] } });
    expect(screen.getByRole('button', { name: 'Move Card 1 up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Move Card 2 down' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('names every control by the item it acts on', () => {
    renderForm(REPEATER, { cards: { 'en-US': [{ title: 'a' }, { title: 'b' }] } });
    // A column of identical "Remove" buttons is unusable by keyboard or screen
    // reader — and removing the wrong card mid-edit is not recoverable.
    const names = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((n): n is string => Boolean(n));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('validation inside components', () => {
  it('marks the nested field that is wrong, not the component', () => {
    renderForm(COMPONENT, { hero: { 'en-US': { body: 'no title' } } });
    save();
    const title = screen.getByLabelText(/^Title/);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(/^Name/).getAttribute('aria-invalid')).toBeNull();
  });

  it('points at the item that failed, counting from one', () => {
    renderForm(REPEATER, { cards: { 'en-US': [{ title: 'ok' }, { body: 'missing title' }] } });
    save();
    const summary = screen.getByRole('alert');
    // "cards[1].title" is a precise address and a poor instruction.
    expect(within(summary).getByText(/Cards 2 › Title/)).toBeTruthy();
    expect(within(summary).queryByText(/cards\[1\]/)).toBeNull();
  });

  it('reads a component path as directions', () => {
    renderForm(COMPONENT, { hero: { 'en-US': {} } });
    save();
    expect(within(screen.getByRole('alert')).getByText(/Hero › Title/)).toBeTruthy();
  });

  it('clears the nested error once the field is filled in', () => {
    renderForm(COMPONENT, { hero: { 'en-US': {} } });
    save();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Now set' } });
    expect(screen.getByLabelText(/^Title/).getAttribute('aria-invalid')).toBeNull();
  });
});

describe('editing a list of short text values', () => {
  const KEYWORDS = typeWith([
    field({
      apiId: 'keywords',
      name: 'Keywords',
      type: 'Array',
      items: { type: 'Symbol' },
      position: 1,
    }),
  ]);

  it('edits keywords as chips, not JSON', () => {
    const onSave = renderForm(KEYWORDS, {
      name: { 'en-US': 'Page' },
      keywords: { 'en-US': ['cms', 'drafts'] },
    });
    const input = screen.getByRole('textbox', { name: /^Keywords/ });
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.change(input, { target: { value: 'release' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'a, b,' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove “drafts”' }));
    save();
    expect(onSave).toHaveBeenCalledWith({
      name: { 'en-US': 'Page' },
      keywords: { 'en-US': ['cms', 'release', 'a', 'b'] },
    });
  });
});

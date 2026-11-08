// @vitest-environment jsdom
// Tables in the rich-text editor: inserting one from the toolbar, the table controls that appear
// while the cursor is in it (named for a screen reader, reachable by keyboard), and the stored
// document each edit emits.
import type { RichTextDocument, RichTextNode } from '@commerceworker/domain';
import { validateRichText } from '@commerceworker/domain';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichTextEditor } from '~/cms/components/RichTextEditor';

const PICKERS = { entries: [], assets: [] };

/** The editor's last emitted document. */
function mount(value?: unknown) {
  const onChange = vi.fn<(doc: RichTextDocument | undefined) => void>();
  render(<RichTextEditor value={value} pickers={PICKERS} onChange={onChange} />);
  const last = () => onChange.mock.lastCall?.[0];
  return { onChange, last };
}

const tableOf = (doc: RichTextDocument | undefined): RichTextNode | undefined =>
  doc?.content.find((n) => n.nodeType === 'table');

const shape = (table: RichTextNode | undefined) =>
  table?.content?.map((row) => row.content?.map((cell) => cell.nodeType));

const press = async (name: string) => {
  // mousedown is prevented (the editor keeps its selection); the click runs the command.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('rich-text tables', () => {
  it('inserts a three-by-three table with a header row, as a document the domain accepts', async () => {
    const { last } = mount();
    expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull();

    await press('Insert table');

    const doc = last();
    expect(shape(tableOf(doc))).toEqual([
      ['table-header-cell', 'table-header-cell', 'table-header-cell'],
      ['table-cell', 'table-cell', 'table-cell'],
      ['table-cell', 'table-cell', 'table-cell'],
    ]);
    expect(validateRichText(doc)).toEqual([]);
  });

  it('shows the table controls while the cursor is in a table, each with an accessible name', async () => {
    mount();
    await press('Insert table');

    const controls = screen.getByRole('toolbar', { name: 'Table' });
    const names = within(controls)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual([
      'Row below',
      'Column right',
      'Header row',
      'Delete row',
      'Delete column',
      'Delete table',
    ]);
    // Buttons, so Tab reaches them and Enter or Space presses them.
    for (const button of within(controls).getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
    }
    expect(
      within(controls).getByRole('button', { name: 'Header row' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // One table at a time from the toolbar: the cursor's table is edited, not nested into.
    expect(
      (screen.getByRole('button', { name: 'Insert table' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('toggles the header row off and back on', async () => {
    const { last } = mount();
    await press('Insert table');
    const headerRow = () =>
      screen.getByRole('button', { name: 'Header row' }).getAttribute('aria-pressed');

    await press('Header row');
    expect(shape(tableOf(last()))?.[0]).toEqual(['table-cell', 'table-cell', 'table-cell']);
    expect(headerRow()).toBe('false');

    await press('Header row');
    expect(shape(tableOf(last()))?.[0]).toEqual([
      'table-header-cell',
      'table-header-cell',
      'table-header-cell',
    ]);
    expect(headerRow()).toBe('true');
  });

  it('adds and removes rows and columns at the cursor', async () => {
    const { last } = mount();
    await press('Insert table');

    await press('Row below');
    expect(tableOf(last())?.content).toHaveLength(4);
    await press('Column right');
    expect(tableOf(last())?.content?.[0]?.content).toHaveLength(4);
    await press('Delete column');
    expect(tableOf(last())?.content?.[0]?.content).toHaveLength(3);
    // The cursor is in the header row, so that is the row that goes.
    await press('Delete row');
    expect(shape(tableOf(last()))).toEqual([
      ['table-cell', 'table-cell', 'table-cell'],
      ['table-cell', 'table-cell', 'table-cell'],
      ['table-cell', 'table-cell', 'table-cell'],
    ]);
    expect(validateRichText(last())).toEqual([]);
  });

  it('keeps the last row and column: removing those is deleting the table', async () => {
    const { last } = mount();
    await press('Insert table');
    // Down to one column, then one row, from the toolbar alone.
    await press('Delete column');
    await press('Delete column');
    await press('Delete row');
    await press('Delete row');
    expect(shape(tableOf(last()))).toEqual([['table-cell']]);
    const disabled = (name: string) =>
      (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
    expect(disabled('Delete column')).toBe(true);
    expect(disabled('Delete row')).toBe(true);
    expect(disabled('Delete table')).toBe(false);
  });

  it('deletes the table, and the table controls go with it', async () => {
    const { last } = mount();
    await press('Insert table');
    await press('Delete table');

    expect(tableOf(last())).toBeUndefined();
    expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Insert table' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('renders a stored table as a grid in the editor', () => {
    const cell = (nodeType: string, value: string): RichTextNode => ({
      nodeType,
      data: {},
      content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value, marks: [] }] }],
    });
    mount({
      nodeType: 'document',
      content: [
        {
          nodeType: 'table',
          data: {},
          content: [
            { nodeType: 'table-row', data: {}, content: [cell('table-header-cell', 'Plan')] },
            { nodeType: 'table-row', data: {}, content: [cell('table-cell', 'Starter')] },
          ],
        },
      ],
    });
    const grid = screen.getByRole('table');
    expect(within(grid).getByRole('columnheader', { name: 'Plan' })).toBeTruthy();
    expect(within(grid).getByRole('cell', { name: 'Starter' })).toBeTruthy();
  });
});

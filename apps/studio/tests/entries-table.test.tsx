// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EntriesTable,
  type EntryRowActions,
  shouldIgnoreShortcut,
} from '~/cms/components/entries/EntriesTable';
import type { PreviewEntry } from '~/cms/lib/management';

// jsdom has no layout, so it has no scrollIntoView; every real browser does.
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

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [field({ apiId: 'title', name: 'Headline', localized: true })],
};

const entry = (id: string, status: string, title?: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  updatedAt: '2026-10-01T09:30:00.000Z',
  fields: title === undefined ? {} : { title: { 'en-US': title } },
});

const ENTRIES = [
  entry('e-draft', 'draft', 'Spring launch'),
  entry('e-changed', 'changed', 'Pricing page'),
  entry('e-live', 'published', 'About us'),
  entry('e-none', 'published'),
];

function actions(): EntryRowActions {
  return {
    publish: vi.fn(),
    diff: vi.fn(),
    duplicate: vi.fn(),
    unpublish: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    purge: vi.fn(),
  };
}

function renderTable(over: Partial<Parameters<typeof EntriesTable>[0]> = {}) {
  const props = {
    type: ARTICLE,
    entries: ENTRIES,
    locale: 'en-US',
    picked: new Set<string>(),
    busy: false,
    viewingTrash: false,
    hrefFor: (e: PreviewEntry) => `/content/article/${e.id}`,
    onPick: vi.fn(),
    onPickAll: vi.fn(),
    actions: actions(),
    ...over,
  };
  const view = render(
    <MemoryRouter>
      <EntriesTable {...props} />
    </MemoryRouter>,
  );
  return Object.assign(props, {
    rerender: (next: Partial<Parameters<typeof EntriesTable>[0]>) =>
      view.rerender(
        <MemoryRouter>
          <EntriesTable {...props} {...next} />
        </MemoryRouter>,
      ),
  });
}

// Radix menus open on pointerdown (left button, no modifiers).
const openMenu = (name: string) =>
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });

describe('EntriesTable rows', () => {
  it('heads the title column with the field name, not its apiId', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Headline' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'title' })).toBeNull();
  });

  it('links each title to the entry editor', () => {
    renderTable();
    const link = screen.getByRole('link', { name: 'Spring launch' });
    expect(link.getAttribute('href')).toBe('/content/article/e-draft');
    expect(screen.getByRole('link', { name: 'Untitled entry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('labels checkboxes by title, never by id', () => {
    renderTable();
    expect(screen.getByRole('checkbox', { name: 'Select “Spring launch”' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select untitled entry' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /e-draft/ })).toBeNull();
  });

  it('offers Publish only for draft and changed entries, in its own cell', () => {
    const props = renderTable();
    const rows = screen.getAllByRole('row').slice(1);
    // Every row has the same number of cells, so columns never shift.
    for (const row of rows) expect(within(row).getAllByRole('cell')).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: /^Publish / })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Publish “Pricing page”' }));
    expect(props.actions.publish).toHaveBeenCalledWith(ENTRIES[1]);
  });

  it('keeps the row Publish quiet: a ghost at badge height, shown on hover, focus, J/K, a tick or touch', () => {
    renderTable();
    const publish = screen.getByRole('button', { name: 'Publish “Spring launch”' });
    expect(publish.className).toContain('h-6');
    for (const shown of [
      'group-hover/row:opacity-100',
      'group-focus-within/row:opacity-100',
      'group-data-active/row:opacity-100',
      'group-data-[state=selected]/row:opacity-100',
      'touch:opacity-100',
    ])
      expect(publish.className).toContain(shown);
  });

  it('shows when each entry changed, the full time in its tooltip', () => {
    renderTable();
    const row = screen.getByRole('link', { name: 'Spring launch' }).closest('[role="row"]');
    const time = (row as HTMLElement).querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-10-01T09:30:00.000Z');
    expect(time?.getAttribute('title')).toBeTruthy();
  });

  it('marks a ticked row selected', () => {
    renderTable({ picked: new Set(['e-live']) });
    const row = screen.getByRole('link', { name: 'About us' }).closest('[role="row"]');
    expect(row?.getAttribute('data-state')).toBe('selected');
  });

  it('says why there are no rows in a row under the headers', () => {
    renderTable({ entries: [], empty: 'No entries match the current filters.' });
    expect(screen.getByRole('columnheader', { name: 'Headline' })).toBeTruthy();
    expect(
      screen.getByRole('cell', { name: 'No entries match the current filters.' }),
    ).toBeTruthy();
  });

  it('puts the rest in a per-row menu with Move to trash last', () => {
    const props = renderTable();
    openMenu('More actions for About us');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Diff vs published', 'Duplicate', 'Unpublish', 'Move to trash']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to trash' }));
    expect(props.actions.trash).toHaveBeenCalledWith(ENTRIES[2]);
  });

  it('leaves Diff and Unpublish out of a draft’s menu', () => {
    renderTable();
    openMenu('More actions for Spring launch');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Duplicate', 'Move to trash']);
  });

  it('restores from the trash and keeps permanent delete in the menu', () => {
    const props = renderTable({ viewingTrash: true });
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]!);
    expect(props.actions.restore).toHaveBeenCalledWith(ENTRIES[0]);
    openMenu('More actions for Spring launch');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently…' }));
    expect(props.actions.purge).toHaveBeenCalledWith(ENTRIES[0]);
  });
});

describe('EntriesTable keyboard', () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

  it('moves with J/K and the arrows, and X selects the focused row', () => {
    const props = renderTable();
    press('j');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Spring launch' }));
    press('j');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Pricing page' }));
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'About us' }));
    press('k');
    press('ArrowUp');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Spring launch' }));
    press('x');
    expect(props.onPick).toHaveBeenCalledWith(['e-draft'], true);
  });

  it('tells a screen reader the keys, from the table itself', () => {
    renderTable();
    const table = screen.getByRole('table');
    const describedBy = table.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(/J or K/);
  });

  it('ignores keys with a modifier held', () => {
    renderTable();
    press('j', { metaKey: true });
    press('j', { ctrlKey: true });
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores keys while typing or while a dialog is open', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const typing = new KeyboardEvent('keydown', { key: 'j' });
    Object.defineProperty(typing, 'target', { value: input });
    expect(shouldIgnoreShortcut(typing)).toBe(true);
    input.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(shouldIgnoreShortcut(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true);
    dialog.remove();
    expect(shouldIgnoreShortcut(new KeyboardEvent('keydown', { key: 'j' }))).toBe(false);
  });
});

describe('EntriesTable sorting from its headers', () => {
  it('sorts Title, Status and Updated from their headers, the sorted one aria-sorted', () => {
    const onSort = vi.fn();
    const props = renderTable({ onSort });
    // No order is least recently changed first: Updated, ascending.
    expect(screen.getByRole('columnheader', { name: 'Updated' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Headline' }));
    expect(onSort).toHaveBeenLastCalledWith('title');
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(onSort).toHaveBeenLastCalledWith('sys.status');
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    expect(onSort).toHaveBeenLastCalledWith('sys.updatedAt');

    props.rerender({ order: { field: 'title', direction: 'desc' } });
    expect(screen.getByRole('columnheader', { name: 'Headline' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(
      screen.getByRole('columnheader', { name: 'Updated' }).getAttribute('aria-sort'),
    ).toBeNull();
  });

  it('keeps plain captions when the list can’t sort', () => {
    renderTable();
    expect(screen.queryByRole('button', { name: 'Headline' })).toBeNull();
  });
});

describe('EntriesTable selection', () => {
  it('ticks one, then a shift-click ticks the range between', () => {
    const props = renderTable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Spring launch”' }));
    expect(props.onPick).toHaveBeenLastCalledWith(['e-draft'], true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “About us”' }), {
      shiftKey: true,
    });
    expect(props.onPick).toHaveBeenLastCalledWith(['e-draft', 'e-changed', 'e-live'], true);
  });

  it('draws the header box from the whole selection: some is mixed, all is ticked', () => {
    const props = renderTable({ picked: new Set(['e-live']) });
    const all = () => screen.getByRole('checkbox', { name: 'Select all entries' });
    expect(all().getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(all());
    expect(props.onPickAll).toHaveBeenLastCalledWith(true);
    props.rerender({ picked: new Set(ENTRIES.map((e) => e.id)) });
    expect(all().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(all());
    expect(props.onPickAll).toHaveBeenLastCalledWith(false);
  });
});

describe('EntriesTable Load more', () => {
  it('sits in the foot, and hands focus to the first row it brought', () => {
    const onLoadMore = vi.fn();
    const props = renderTable({ entries: ENTRIES.slice(0, 2), onLoadMore });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    props.rerender({ entries: ENTRIES, onLoadMore: undefined });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'About us' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

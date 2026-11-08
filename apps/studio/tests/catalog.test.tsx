import { BulkBar } from '@commerceworker/ui/bulk-bar';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@commerceworker/ui/catalog';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

describe('ListSearch', () => {
  it('is a named search field', () => {
    render(<ListSearch label="Search things" value="" onChange={() => {}} />);
    expect(screen.getByRole('searchbox', { name: 'Search things' })).toBeTruthy();
  });

  it('offers Clear only once it holds text', () => {
    const { rerender } = render(
      <ListSearch label="Search things" value="" onChange={() => {}} onClear={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    rerender(<ListSearch label="Search things" value="a" onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  it('clears on Clear and on Escape, and leaves Escape alone when empty', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <ListSearch label="Search things" value="a" onChange={() => {}} onClear={onClear} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(2);
    rerender(<ListSearch label="Search things" value="" onChange={() => {}} onClear={onClear} />);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(2);
  });
});

describe('Catalog', () => {
  it('is a named list whose rows hold their title, facts, state and actions', () => {
    render(
      <Catalog aria-label="Things">
        <CatalogRow
          media={<CatalogTile>301</CatalogTile>}
          title="A thing"
          meta="Made today"
          aside={<CatalogFigure label="Entries">4</CatalogFigure>}
          actions={<button type="button">Edit</button>}
        />
      </Catalog>,
    );
    const row = within(screen.getByRole('list', { name: 'Things' })).getByRole('listitem');
    for (const text of ['301', 'A thing', 'Made today', 'Entries', '4']) {
      expect(within(row).getByText(text)).toBeTruthy();
    }
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });
});

describe('keeping focus in a list', () => {
  it('stays in the field when Clear takes itself away', () => {
    function Field() {
      const [value, setValue] = useState('a');
      return (
        <ListSearch
          label="Search things"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClear={() => setValue('')}
        />
      );
    }
    render(<Field />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  function Rows(props: { initial: string[] }) {
    const [rows, setRows] = useState(props.initial);
    return (
      <div className="card">
        <ListToolbar>
          <ListSearch label="Search things" value="" onChange={() => {}} />
        </ListToolbar>
        {rows.length ? (
          <Catalog aria-label="Things">
            {rows.map((row) => (
              <CatalogRow
                key={row}
                title={row}
                actions={
                  <button type="button" onClick={() => setRows(rows.filter((r) => r !== row))}>
                    Pause {row}
                  </button>
                }
              />
            ))}
          </Catalog>
        ) : (
          <CatalogEmpty>Nothing left.</CatalogEmpty>
        )}
      </div>
    );
  }

  it('moves to the row that took the place of one an action removed', async () => {
    render(<Rows initial={['a', 'b']} />);
    const pause = screen.getByRole('button', { name: 'Pause a' });
    pause.focus();
    fireEvent.click(pause);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause b' })),
    );
  });

  it('leaves focus alone when a row’s own dialog, in a portal, held it', async () => {
    function Asked() {
      const [gone, setGone] = useState(false);
      return (
        <div className="card">
          <ListToolbar>
            <ListSearch label="Search things" value="" onChange={() => {}} />
          </ListToolbar>
          <Catalog aria-label="Things">
            {gone ? null : (
              <CatalogRow
                title="a"
                actions={createPortal(
                  <button type="button" onClick={() => setGone(true)}>
                    Confirm
                  </button>,
                  document.body,
                )}
              />
            )}
            <CatalogRow title="b" />
          </Catalog>
        </div>
      );
    }
    render(<Asked />);
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull());
    await Promise.resolve();
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox'));
  });

  it('moves to the search when the last row goes', async () => {
    render(<Rows initial={['a']} />);
    const pause = screen.getByRole('button', { name: 'Pause a' });
    pause.focus();
    fireEvent.click(pause);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')));
  });
});

describe('ListToolbar', () => {
  it('says what the filters left', () => {
    render(<ListToolbar summary="3 shown" />);
    expect(screen.getByRole('status').textContent).toBe('3 shown');
  });
});

describe('CatalogEmpty', () => {
  it('clears the filters and hands focus to the list’s search', () => {
    const onClear = vi.fn();
    render(
      <div className="card">
        <ListToolbar>
          <ListSearch label="Search things" value="zz" onChange={() => {}} />
        </ListToolbar>
        <CatalogEmpty onClear={onClear}>Nothing matches.</CatalogEmpty>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });
});

describe('BulkBar', () => {
  it('names its group, counts the ticks and clears them', () => {
    const onClear = vi.fn();
    render(
      <BulkBar label="Selected things" count={3} onClear={onClear}>
        <button type="button">Publish selected</button>
      </BulkBar>,
    );
    const bar = screen.getByRole('group', { name: 'Selected things' });
    expect(within(bar).getByText('3 selected')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Publish selected' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

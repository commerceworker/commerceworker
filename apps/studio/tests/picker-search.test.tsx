// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { PickOption } from '~/cms/components/EntryForm';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const option = (id: string, label: string): PickOption => ({ id, label, contentType: 'article' });

/** The seed the picker is given before anyone types — a capped page, as in life. */
const SEED = [option('e1', 'Seeded one'), option('e2', 'Seeded two')];

function renderPicker(over: Partial<Parameters<typeof EntityPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <EntityPicker
      id="link"
      options={SEED}
      value=""
      ariaLabel="Reference"
      onChange={onChange}
      {...over}
    />,
  );
  return onChange;
}

const openList = () => fireEvent.focus(screen.getByLabelText('Reference'));
const type = (text: string) =>
  fireEvent.change(screen.getByLabelText('Reference'), { target: { value: text } });

describe('without a server search', () => {
  it('filters the options it was given', async () => {
    renderPicker();
    openList();
    type('two');
    await waitFor(() => expect(screen.queryByText(/Seeded one/)).toBeNull());
    expect(screen.getByText(/Seeded two/)).toBeTruthy();
  });
});

describe('with a server search', () => {
  let onSearch: Mock<(query: string) => Promise<PickOption[]>>;

  beforeEach(() => {
    onSearch = vi.fn(async (q: string) =>
      q ? [option('far', `Far away match for ${q}`)] : [option('recent', 'Recent entry')],
    );
  });

  it('asks the server rather than filtering the seed', async () => {
    renderPicker({ onSearch });
    openList();
    type('needle');

    // The seed cannot contain this: the point is reaching past the capped page.
    expect(await screen.findByText(/Far away match for needle/)).toBeTruthy();
    expect(screen.queryByText(/Seeded one/)).toBeNull();
  });

  it('debounces, so a keystroke is not a query', async () => {
    vi.useFakeTimers();
    renderPicker({ onSearch });
    openList();
    type('n');
    type('ne');
    type('nee');
    await vi.advanceTimersByTimeAsync(500);
    // One request for what was typed, not one per character.
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('nee');
  });

  it('says it is searching rather than that nothing matched', async () => {
    vi.useFakeTimers();
    renderPicker({ onSearch: () => new Promise<PickOption[]>(() => {}) });
    openList();
    type('anything');
    await vi.advanceTimersByTimeAsync(300);
    // "No matches" during a request tells someone to stop typing a query that
    // would have worked.
    expect(screen.getByText(/Searching…/)).toBeTruthy();
  });

  it('keeps the previous results when a lookup fails', async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce([option('ok', 'Found earlier')])
      .mockRejectedValueOnce(new Error('offline'));
    renderPicker({ onSearch: flaky });
    openList();
    type('first');
    expect(await screen.findByText(/Found earlier/)).toBeTruthy();

    type('second');
    await waitFor(() => expect(flaky).toHaveBeenCalledTimes(2));
    // Emptying the list on a failed request reads as "nothing matches", which
    // is a different and wrong answer.
    expect(screen.getByText(/Found earlier/)).toBeTruthy();
  });

  it('still shows what is selected once it falls outside the results', async () => {
    // Controlled, because the point is what the field shows after the value
    // changes to something the seed never held.
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <EntityPicker
          id="link"
          options={SEED}
          value={value}
          ariaLabel="Reference"
          onChange={(id) => setValue(id ?? '')}
          onSearch={onSearch}
        />
      );
    }
    render(<Harness />);

    openList();
    type('needle');
    fireEvent.click(await screen.findByText(/Far away match for needle/));
    const input = () => screen.getByLabelText('Reference') as HTMLInputElement;
    await waitFor(() => expect(input().value).toContain('Far away match'));

    // Search again for something that cannot return it. Reading the label out
    // of the current results — or out of the seed, which never held it — would
    // blank the field down to a bare id the moment somebody typed.
    openList();
    type('unrelated');
    await screen.findByText(/Far away match for unrelated/);
    fireEvent.keyDown(input(), { key: 'Escape' });

    await waitFor(() => expect(input().value).toContain('Far away match for needle'));
  });
});

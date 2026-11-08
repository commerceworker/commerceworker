// @vitest-environment jsdom
import type { Menu, MenuItem } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's Switch measures itself through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The TanStack cache scoping isn't under test here (see redirects-settings.test.tsx): each query
// loads when its key changes, and an invalidation reloads every one.
const refetchers = new Set<() => void>();
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const fn = useRef(queryFn);
    fn.current = queryFn;
    const key = JSON.stringify(segments);
    const load = useCallback(() => {
      fn.current().then(setData);
    }, [key]);
    useEffect(() => {
      load();
      refetchers.add(load);
      return () => {
        refetchers.delete(load);
      };
    }, [load]);
    return { data };
  },
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

const { Menus } = await import('~/cms/components/Menus');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError, RequestTimeoutError } = await import('~/cms/lib/management');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const AT = '2026-01-01T00:00:00.000Z';
const url = (id: string, label: string, children: MenuItem[] = []): MenuItem => ({
  id,
  label,
  link: { type: 'url', url: `/${id}` },
  children,
});
const menuOf = (items: MenuItem[], revision = 1): Menu => ({
  id: 'm1',
  handle: 'main',
  name: 'Main',
  items,
  revision,
  createdAt: AT,
  updatedAt: AT,
});

function fakeClient(menu: Menu | null) {
  return {
    listMenus: vi.fn(async () =>
      menu
        ? [
            {
              id: menu.id,
              handle: menu.handle,
              name: menu.name,
              itemCount: 3,
              revision: menu.revision,
              updatedAt: AT,
            },
          ]
        : [],
    ),
    getMenu: vi.fn(async () => menu as Menu),
    previewMenu: vi.fn(async () => ({
      menu: menu as Menu,
      locale: 'en-US',
      items: (menu?.items ?? []).map((i) => ({
        id: i.id,
        link: i.link,
        label: i.label ?? '',
        url: i.id === 'b' ? null : `/${i.id}`,
        status: i.id === 'b' ? ('unpublished' as const) : ('live' as const),
        children: [],
      })),
    })),
    createMenu: vi.fn(async (input: { name: string; handle: string }) => ({
      ...menuOf([]),
      id: 'new',
      ...input,
    })),
    updateMenu: vi.fn(async () => menu as Menu),
    moveMenuItem: vi.fn(async () => ({ ...(menu as Menu), revision: (menu?.revision ?? 0) + 1 })),
    deleteMenu: vi.fn(async () => {}),
    listTags: vi.fn(async () => []),
    listConcepts: vi.fn(async () => []),
    suggestEntries: vi.fn(async () => []),
  };
}

const mount = (client: ReturnType<typeof fakeClient>) =>
  render(
    <ToastProvider>
      <Menus client={client as unknown as ManagementClient} />
    </ToastProvider>,
  );

/** Opens the one menu's editor from the list. */
async function openEditor(client: ReturnType<typeof fakeClient>) {
  mount(client);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit the menu Main' }));
  return screen.findByRole('list', { name: 'Items of Main' });
}

describe('Settings → Menus', () => {
  it('lists menus by name, handle and item count', async () => {
    mount(fakeClient(menuOf([url('a', 'A')])));
    const list = await screen.findByRole('list', { name: 'Menus' });
    expect(await within(list).findByText('Main')).toBeTruthy();
    expect(within(list).getByText('main')).toBeTruthy();
    expect(within(list).getByText('3')).toBeTruthy();
  });

  it('searches the menus it holds, by name and handle, with a way out of a miss', async () => {
    const client = fakeClient(menuOf([]));
    client.listMenus.mockResolvedValue([
      { id: 'm1', handle: 'main', name: 'Main', itemCount: 3, revision: 1, updatedAt: AT },
      { id: 'm2', handle: 'legal-links', name: 'Footer', itemCount: 1, revision: 1, updatedAt: AT },
    ]);
    mount(client);
    const search = await screen.findByRole('searchbox', { name: 'Search menus' });
    await screen.findByText('Footer');

    fireEvent.change(search, { target: { value: 'FOOT' } });
    expect(screen.queryByText('Main')).toBeNull();
    expect(screen.getByText('Footer')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'legal' } });
    expect(screen.getByText('Footer')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'nothing here' } });
    expect(screen.queryByRole('list', { name: 'Menus' })).toBeNull();
    expect(screen.getByText(/No menus match/).textContent).toContain('nothing here');
    // Asked of the server once: the filter is the screen's, over the whole list it holds.
    expect(client.listMenus).toHaveBeenCalledTimes(1);

    const miss = screen.getByText(/No menus match/);
    fireEvent.click(within(miss).getByRole('button', { name: 'Clear filters' }));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Main')).toBeTruthy();
    expect(screen.getByText('Footer')).toBeTruthy();
  });

  it('creates a menu, suggesting the handle from its name, then opens it', async () => {
    const client = fakeClient(null);
    mount(client);
    await screen.findByText('No menus yet');
    fireEvent.click(screen.getByRole('button', { name: 'New menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'New menu' });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Footer Legal' },
    });
    expect((within(dialog).getByLabelText('Handle') as HTMLInputElement).value).toBe(
      'footer-legal',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create menu' }));
    await waitFor(() =>
      expect(client.createMenu).toHaveBeenCalledWith({
        name: 'Footer Legal',
        handle: 'footer-legal',
        description: null,
      }),
    );
    await waitFor(() => expect(client.getMenu).toHaveBeenCalled());
  });

  it('reorders by keyboard: each button sends the move it names, with the revision', async () => {
    const client = fakeClient(
      menuOf([url('a', 'A'), url('b', 'B', [url('b1', 'B1')]), url('c', 'C')], 4),
    );
    const list = await openEditor(client);

    fireEvent.click(within(list).getByRole('button', { name: 'Move “B” up' }));
    await waitFor(() =>
      expect(client.moveMenuItem).toHaveBeenLastCalledWith('m1', {
        itemId: 'b',
        parentId: null,
        index: 0,
        revision: 4,
      }),
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Move “C” in a level' }));
    await waitFor(() =>
      expect(client.moveMenuItem).toHaveBeenLastCalledWith('m1', {
        itemId: 'c',
        parentId: 'b',
        index: 1,
        revision: 5,
      }),
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Move “B1” out a level' }));
    await waitFor(() =>
      expect(client.moveMenuItem).toHaveBeenLastCalledWith(
        'm1',
        expect.objectContaining({ itemId: 'b1', parentId: null, index: 2 }),
      ),
    );
    // Alt+arrow on a focused row does the same.
    fireEvent.keyDown(within(list).getByRole('button', { name: 'Move “A” down' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    await waitFor(() =>
      expect(client.moveMenuItem).toHaveBeenLastCalledWith(
        'm1',
        expect.objectContaining({ itemId: 'a', parentId: null, index: 1 }),
      ),
    );
    // Nothing above the first item, nothing to leave at the top, and the edges are disabled.
    expect(
      (within(list).getByRole('button', { name: 'Move “A” up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(list).getByRole('button', { name: 'Move “A” out a level' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('won’t indent past the deepest level a menu nests', async () => {
    const client = fakeClient(
      menuOf([url('a', 'A', [url('a1', 'A1', [url('a11', 'A11'), url('a12', 'A12')])])]),
    );
    const list = await openEditor(client);
    expect(
      (within(list).getByRole('button', { name: 'Move “A12” in a level' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('says why an item isn’t served, in words', async () => {
    const list = await openEditor(fakeClient(menuOf([url('a', 'A'), url('b', 'B')])));
    expect(await within(list).findByText('Not published')).toBeTruthy();
    expect(within(list).getByText('Live')).toBeTruthy();
  });

  it('stops on a save someone else beat, and reloads their version', async () => {
    const client = fakeClient(menuOf([url('a', 'A'), url('b', 'B')]));
    client.moveMenuItem.mockRejectedValueOnce(
      new ApiError(409, 'conflict', { error: { code: 'conflict', message: 'saved since' } }),
    );
    const list = await openEditor(client);
    fireEvent.click(within(list).getByRole('button', { name: 'Move “B” up' }));
    expect(await screen.findByText('This menu changed since you opened it')).toBeTruthy();
    expect(
      (within(list).getByRole('button', { name: 'Move “B” up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const calls = client.getMenu.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(client.getMenu.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() =>
      expect(screen.queryByText('This menu changed since you opened it')).toBeNull(),
    );
  });

  it('allows that the save it lost to may be the person’s own, after one didn’t confirm', async () => {
    const client = fakeClient(menuOf([url('a', 'A'), url('b', 'B')]));
    client.moveMenuItem
      .mockRejectedValueOnce(new RequestTimeoutError(true))
      .mockRejectedValueOnce(
        new ApiError(409, 'conflict', { error: { code: 'conflict', message: 'saved since' } }),
      );
    const list = await openEditor(client);
    const move = () => fireEvent.click(within(list).getByRole('button', { name: 'Move “B” up' }));
    move();
    await waitFor(() => expect(client.moveMenuItem).toHaveBeenCalledOnce());
    await waitFor(() => {
      move();
      expect(client.moveMenuItem).toHaveBeenCalledTimes(2);
    });
    await screen.findByText('This menu changed since you opened it');
    expect(screen.queryByText(/Someone else saved it/)).toBeNull();
    expect(screen.getByText(/your own save that didn’t confirm/)).toBeTruthy();
  });

  it('asks honestly about an item whose save didn’t confirm', async () => {
    const client = fakeClient(menuOf([url('a', 'A')], 2));
    client.updateMenu.mockRejectedValueOnce(new RequestTimeoutError(true));
    await openEditor(client);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: '/blog' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Blog' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await within(dialog).findByText(/didn’t confirm/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const ask = await within(dialog).findByRole('alertdialog', { name: /Discard/ });
    expect(ask.textContent).toContain('may have gone through');
    expect(ask.textContent).not.toContain('Nothing has been saved');
  });

  it('adds a URL item by saving the whole tree with the revision', async () => {
    const client = fakeClient(menuOf([url('a', 'A')], 2));
    await openEditor(client);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: '/blog' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Blog' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(client.updateMenu).toHaveBeenCalledWith('m1', {
        items: [
          { id: 'a', label: 'A', link: { type: 'url', url: '/a' }, children: [] },
          { label: 'Blog', link: { type: 'url', url: '/blog' } },
        ],
        revision: 2,
      }),
    );
  });
});

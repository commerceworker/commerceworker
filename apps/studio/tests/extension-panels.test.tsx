// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppExtensions } from '~/cms/components/AppExtensions';
import { Functions } from '~/cms/components/Functions';
import type { AppExtension, FunctionDefinition, ManagementClient } from '~/cms/lib/management';
import { ToastProvider } from '~/cms/lib/toast';

afterEach(cleanup);

const renderWith = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

/** A stateful fake of the management client for the registry panels. */
function fakeFunctionsClient() {
  let items: FunctionDefinition[] = [];
  return {
    listFunctions: vi.fn(async () => items),
    createFunction: vi.fn(async (input: { name: string; eventPattern: string; url: string }) => {
      const fn: FunctionDefinition = {
        id: `fn-${items.length + 1}`,
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...input,
      };
      items = [...items, fn];
      return fn;
    }),
    deleteFunction: vi.fn(async (id: string) => {
      items = items.filter((f) => f.id !== id);
    }),
  };
}

describe('Functions panel', () => {
  it('registers a function and lists it, then deletes it', async () => {
    const client = fakeFunctionsClient();
    renderWith(<Functions client={client as unknown as ManagementClient} />);

    expect(await screen.findByText('No functions registered.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'reindex' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() =>
      expect(client.createFunction).toHaveBeenCalledWith({
        name: 'reindex',
        eventPattern: 'entry.*',
        url: 'https://example.com/hook',
      }),
    );
    expect(await screen.findByText('reindex')).toBeTruthy();
    // Each fact says what it is, with no column header left to say it.
    const row = screen.getByText('reindex').closest('li') as HTMLElement;
    expect(row.textContent).toContain('On entry.*');
    expect(within(row).getByText('https://example.com/hook')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete “reindex”' }));
    // Deleting is permanent, so it asks inline first; nothing is sent yet.
    expect(screen.getByRole('alertdialog', { name: 'Delete “reindex”?' })).toBeTruthy();
    expect(client.deleteFunction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete function' }));
    await waitFor(() => expect(client.deleteFunction).toHaveBeenCalledWith('fn-1'));
    expect(await screen.findByText('No functions registered.')).toBeTruthy();
  });
});

function fakeExtensionsClient() {
  let items: AppExtension[] = [];
  return {
    listAppExtensions: vi.fn(async () => items),
    createAppExtension: vi.fn(
      async (input: { name: string; target: AppExtension['target']; entryUrl: string }) => {
        const app: AppExtension = {
          id: `ext-${items.length + 1}`,
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          ...input,
        };
        items = [...items, app];
        return app;
      },
    ),
    deleteAppExtension: vi.fn(async (id: string) => {
      items = items.filter((a) => a.id !== id);
    }),
  };
}

describe('AppExtensions panel', () => {
  it('installs a sidebar extension and lists it', async () => {
    const client = fakeExtensionsClient();
    renderWith(<AppExtensions client={client as unknown as ManagementClient} />);

    expect(await screen.findByText('No extensions installed.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'word-count' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/widget' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(client.createAppExtension).toHaveBeenCalledWith({
        name: 'word-count',
        target: 'sidebar',
        entryUrl: 'https://example.com/widget',
        fieldTypes: undefined,
      }),
    );
    expect(await screen.findByText('word-count')).toBeTruthy();
    const row = screen.getByText('word-count').closest('li') as HTMLElement;
    expect(within(row).getByText('Sidebar widget')).toBeTruthy();
    expect(within(row).getByText('https://example.com/widget')).toBeTruthy();
  });
});

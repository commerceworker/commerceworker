// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The TanStack cache scoping isn't under test here (see connected-apps.test.tsx).
const refetchers = new Set<() => void>();
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const load = useCallback(() => {
      queryFn().then(setData);
    }, [queryFn]);
    useEffect(() => {
      load();
      refetchers.add(load);
      return () => {
        refetchers.delete(load);
      };
    }, [load]);
    return { data };
  },
  useContentTypesQuery: () => ({ data: [] }),
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

// Its own screen, on its own client.
vi.mock('~/cms/components/BranchMerge', () => ({ BranchMerge: () => null }));

const { Settings } = await import('~/cms/components/Settings');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const preset = {
  id: 'r-editor',
  name: 'Editor',
  preset: 'editor',
  scopes: ['content:write'],
  contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
};
const custom = { ...preset, id: 'r-custom', name: 'Reviewer', preset: undefined };

function fakeClient() {
  return {
    listApiKeys: vi.fn(async () => [
      { id: 'k1', kind: 'cda', name: 'site', scopes: ['delivery:read'], revoked: false },
      {
        id: 'k2',
        kind: 'cma',
        name: 'old-ci',
        roleId: custom.id,
        scopes: ['content:write'],
        revoked: true,
      },
    ]),
    revokeApiKey: vi.fn(async () => {}),
    listRoles: vi.fn(async () => [preset, custom]),
    cloneRole: vi.fn(async () => ({})),
    deleteRole: vi.fn(async () => {}),
    listEnvironments: vi.fn(async () => [{ id: 'main' }, { id: 'staging' }]),
    listEnvironmentAliases: vi.fn(async () => [{ alias: 'live', targetEnvironmentId: 'main' }]),
    deleteEnvironmentAlias: vi.fn(async () => {}),
  };
}

const open = (client: ReturnType<typeof fakeClient>, section: string) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Settings
          client={client as unknown as ManagementClient}
          section={section}
          onSection={() => {}}
        />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('Settings → API keys', () => {
  it('keeps every column of a key in its row, in words', async () => {
    open(fakeClient(), 'api-keys');
    const row = (await screen.findByText('old-ci')).closest('li') as HTMLElement;
    expect(within(row).getByText('Management').getAttribute('title')).toBe(
      'Content Management API (CMA)',
    );
    expect(within(row).getByText('Role: Reviewer')).toBeTruthy();
    expect(within(row).getByText('Scopes: content:write')).toBeTruthy();
    expect(within(row).getByText('Revoked')).toBeTruthy();
    // Revoked is an end: there is nothing left to do to it.
    expect(within(row).queryByRole('button', { name: /^Revoke “/ })).toBeNull();
    const live = screen.getByText('site').closest('li') as HTMLElement;
    expect(within(live).getByText('No custom role')).toBeTruthy();
    expect(within(live).getByRole('button', { name: /^Revoke “/ })).toBeTruthy();
  });

  it('finds keys by role and status, and a miss says how to get them back', async () => {
    open(fakeClient(), 'api-keys');
    await screen.findByText('site');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search API keys' }), {
      target: { value: 'reviewer' },
    });
    expect(screen.queryByText('site')).toBeNull();
    expect(screen.getByText('old-ci')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Active' }));
    expect(screen.queryByRole('list', { name: 'API keys' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('site')).toBeTruthy();
    expect(screen.getByText('old-ci')).toBeTruthy();
  });
});

describe('Settings → Roles', () => {
  it('names scopes and content access in the row, with no search over a short list', async () => {
    open(fakeClient(), 'roles');
    const row = (await screen.findByText('Reviewer')).closest('li') as HTMLElement;
    expect(within(row).getByText('Scopes: content:write')).toBeTruthy();
    expect(within(row).getByText(/^Content: /)).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows a built-in role’s two actions, and folds a custom role’s three behind ⋯', async () => {
    const client = fakeClient();
    open(client, 'roles');
    await screen.findByText('Reviewer');
    const builtIn = screen.getByText('Built-in').closest('li') as HTMLElement;
    expect(within(builtIn).getByRole('button', { name: /^Clone “/ })).toBeTruthy();
    expect(within(builtIn).queryByRole('button', { name: /^More actions/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Content access for Reviewer' })).toBeTruthy();

    const more = screen.getByRole('button', { name: 'More actions for Reviewer' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clone' }));
    await waitFor(() =>
      expect(client.cloneRole).toHaveBeenCalledWith(custom.id, 'Reviewer (copy)'),
    );
  });

  it('asks before deleting from the menu, and Cancel goes back to the ⋯', async () => {
    const client = fakeClient();
    open(client, 'roles');
    const more = await screen.findByRole('button', { name: 'More actions for Reviewer' });
    more.focus();
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Delete the role “Reviewer”?' });
    expect(client.deleteRole).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});

describe('Settings → Environments', () => {
  it('says what an alias’s select is, and deleting one asks in place', async () => {
    const client = fakeClient();
    open(client, 'environments');
    const row = (await screen.findByText('live')).closest('li') as HTMLElement;
    expect(within(row).getByText('Target')).toBeTruthy();
    expect(within(row).getByRole('combobox', { name: 'Target environment for live' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: /^Delete the alias / }));
    expect(client.deleteEnvironmentAlias).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete alias' }));
    await waitFor(() => expect(client.deleteEnvironmentAlias).toHaveBeenCalledWith('live'));
  });
});

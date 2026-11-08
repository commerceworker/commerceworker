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

// A minimal fetch-and-refetch in place of the connection-scoped TanStack cache (see
// connected-apps.test.tsx): the component's rendering and client calls are what is under test.
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
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

const { Team, LAST_ADMIN_MESSAGE } = await import('~/cms/components/Team');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;
type TeamSummary = import('~/cms/lib/management').TeamSummary;
type RolePresetSummary = import('~/cms/lib/management').RolePresetSummary;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const PRESETS: RolePresetSummary[] = [
  ['viewer', 'Viewer', ['preview:read']],
  ['approver', 'Approver', ['preview:read', 'workflow:approve']],
  ['editor', 'Editor', ['content:write']],
  ['manager', 'Manager', ['content:manage']],
  ['admin', 'Administrator', ['space:admin']],
].map(([preset, name, scopes]) => ({
  preset: preset as RolePresetSummary['preset'],
  roleId: `role-${preset}`,
  name: name as string,
  description: `${name} description`,
  scopes: scopes as string[],
}));

const role = (preset: string) => {
  const p = PRESETS.find((x) => x.preset === preset);
  return p ? { id: p.roleId, name: p.name, preset: p.preset } : null;
};

function fakeClient(team: TeamSummary) {
  let current = team;
  return {
    getTeam: vi.fn(async () => current),
    listRolePresets: vi.fn(async () => PRESETS),
    listRoles: vi.fn(async () => []),
    addMember: vi.fn(async (input: { email: string; role: string }) => {
      current = {
        ...current,
        people: [
          ...current.people,
          {
            id: `p-${current.people.length + 1}`,
            email: input.email,
            linked: false,
            disabled: false,
            role: role(input.role),
            admin: input.role === 'admin',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      };
      return current.people.at(-1);
    }),
    updateMember: vi.fn(async () => ({})),
    removeMember: vi.fn(async () => {}),
    setApiKeyRole: vi.fn(async (id: string, r: string | null) => ({ id, roleId: r })),
    setAccessSettings: vi.fn(async (s: { ssoOnly: boolean }) => s),
  };
}

const oneAdminKey: TeamSummary = {
  people: [
    {
      id: 'p-1',
      email: 'ada@example.com',
      name: 'Ada',
      linked: true,
      disabled: false,
      role: role('editor'),
      admin: false,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  keys: [
    {
      id: 'k-1',
      kind: 'cma',
      name: 'Deploy key',
      issuance: 'key',
      role: role('admin'),
      admin: true,
    },
  ],
  adminCount: 1,
  settings: { ssoOnly: false },
  sso: true,
};

const renderTeam = (client: ReturnType<typeof fakeClient>) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Team client={client as unknown as ManagementClient} />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('Team', () => {
  it('lists people and keys with their roles', async () => {
    renderTeam(fakeClient(oneAdminKey));
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('Deploy key')).toBeTruthy();
    // The key's kind in words; the acronym only in its tooltip.
    const kind = screen.getByText('Management');
    expect(kind.getAttribute('title')).toBe('Content Management API (CMA)');
    expect(screen.queryByText('CMA')).toBeNull();
    const select = screen.getByLabelText('Role for Deploy key') as HTMLSelectElement;
    expect(select.value).toBe('role-admin');
  });

  it('stamps only a disabled person, and says Active to a screen reader alone', async () => {
    const team: TeamSummary = {
      ...oneAdminKey,
      people: [
        ...oneAdminKey.people,
        {
          id: 'p-2',
          email: 'bo@example.com',
          name: 'Bo',
          linked: true,
          disabled: true,
          role: role('viewer'),
          admin: false,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    renderTeam(fakeClient(team));
    const ada = (await screen.findByText('Ada')).closest('li') as HTMLElement;
    const bo = screen.getByText('Bo').closest('li') as HTMLElement;
    expect(within(bo).getByText('Disabled')).toBeTruthy();
    expect(within(ada).queryByText('Disabled')).toBeNull();
    expect(within(ada).getByText('Active').className).toContain('sr-only');
  });

  it('finds people by name, email or role and by status; a miss says how to get them back', async () => {
    const team: TeamSummary = {
      ...oneAdminKey,
      people: [
        ...oneAdminKey.people,
        {
          id: 'p-2',
          email: 'bo@example.com',
          name: 'Bo',
          linked: true,
          disabled: true,
          role: role('viewer'),
          admin: false,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    renderTeam(fakeClient(team));
    await screen.findByText('Ada');
    const search = screen.getByRole('searchbox', { name: 'Search people' });

    fireEvent.change(search, { target: { value: 'viewer' } });
    expect(screen.queryByText('Ada')).toBeNull();
    expect(screen.getByText('Bo')).toBeTruthy();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }));
    expect(screen.queryByText('Ada')).toBeNull();

    fireEvent.change(search, { target: { value: 'ada' } });
    expect(screen.queryByRole('list', { name: 'People' })).toBeNull();
    expect(screen.getByText(/No people match/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('Bo')).toBeTruthy();
  });

  it('finds keys by name, and a miss clears from where it is said', async () => {
    renderTeam(fakeClient(oneAdminKey));
    await screen.findByText('Deploy key');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search API keys' }), {
      target: { value: 'nothing like it' },
    });
    expect(screen.queryByRole('list', { name: 'API keys and their roles' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Deploy key')).toBeTruthy();
  });

  it('says there is no one yet in place of the list, not as a row of it', async () => {
    renderTeam(fakeClient({ ...oneAdminKey, people: [], keys: [] }));
    expect(await screen.findByText(/No one on the team yet/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'People' })).toBeNull();
    expect(screen.getByText('No API keys.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'API keys and their roles' })).toBeNull();
  });

  it('changes a role only after an inline confirm', async () => {
    const client = fakeClient(oneAdminKey);
    renderTeam(client);
    const select = (await screen.findByLabelText(
      'Role for Ada (ada@example.com)',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'role-approver' } });
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Change Ada (ada@example.com) to Approver?')).toBeTruthy();
    // Under the row, on a line of its own, and still a member of the list.
    expect(confirm.closest('li')?.parentElement).toBe(select.closest('li')?.parentElement);
    expect(confirm.closest('li')).not.toBe(select.closest('li'));
    expect(client.updateMember).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(client.updateMember).toHaveBeenCalledWith('p-1', { role: 'role-approver' }),
    );
  });

  it('explains instead of demoting the last administrator', async () => {
    const client = fakeClient(oneAdminKey);
    renderTeam(client);
    const select = await screen.findByLabelText('Role for Deploy key');
    fireEvent.change(select, { target: { value: 'role-editor' } });
    const notice = await screen.findByRole('alertdialog');
    expect(within(notice).getByText(LAST_ADMIN_MESSAGE)).toBeTruthy();
    expect(within(notice).queryByRole('button', { name: 'Change role' })).toBeNull();
    expect(client.setApiKeyRole).not.toHaveBeenCalled();
  });

  it('marks the last administrator person instead of offering turn off/remove', async () => {
    const admins: TeamSummary = {
      ...oneAdminKey,
      keys: [],
      people: [
        {
          ...(oneAdminKey.people[0] as TeamSummary['people'][number]),
          role: role('admin'),
          admin: true,
        },
      ],
    };
    renderTeam(fakeClient(admins));
    expect(await screen.findByText('Last administrator')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('adds a person with a preset', async () => {
    const client = fakeClient(oneAdminKey);
    renderTeam(client);
    await screen.findByText('Ada');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'approver' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() =>
      expect(client.addMember).toHaveBeenCalledWith({
        email: 'grace@example.com',
        role: 'approver',
      }),
    );
    expect(await screen.findByText('grace@example.com')).toBeTruthy();
  });

  it('offers SSO-only sign-in only when SSO is configured', async () => {
    renderTeam(fakeClient({ ...oneAdminKey, sso: false }));
    await screen.findByText('Ada');
    expect(screen.queryByLabelText('Require single sign-on for people')).toBeNull();
    cleanup();
    renderTeam(fakeClient(oneAdminKey));
    expect(await screen.findByLabelText('Require single sign-on for people')).toBeTruthy();
  });
});

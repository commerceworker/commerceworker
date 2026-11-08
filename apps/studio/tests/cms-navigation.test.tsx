// The CMS's navigation pieces the web shell mounts: the nav source (G-letters, Settings
// sections), the header's breadcrumbs, the ⌘K command palette, the Settings section nav, the New
// entry control and the single-key shortcut guard. The shell itself (routes/shell.tsx) is covered by e2e/shell.spec.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
const client = {
  listContentTypes: vi.fn(async () => [
    { apiId: 'article', name: 'Article', displayField: 'title', fields: [], status: 'published' },
  ]),
  listEntries: vi.fn(async () => []),
  getSpaceConfig: vi.fn(async () => ({ locales: ['en-US'], defaultLocale: 'en-US' })),
  listEnvironments: vi.fn(async () => []),
  listSpaces: vi.fn(async () => [{ id: 'acme', name: 'Acme' }]),
  countPendingApprovals: vi.fn(async () => ({ workflowTasks: 2, agentReviews: 1, total: 3 })),
};
const conn = { space: 'acme', environment: 'staging', locale: 'en-US' };

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn, client, signOut, updateConn: vi.fn(), ready: true }),
}));

const { CommandPalette, openCommandPalette } = await import(
  '~/cms/components/layout/CommandPalette'
);
const { NAV, SETTINGS_GROUPS, SETTINGS_SECTIONS, visibleNav } = await import(
  '~/cms/components/layout/nav'
);
const { SettingsNav } = await import('~/cms/components/layout/SettingsNav');
const { SpaceSwitcher } = await import('~/cms/components/layout/SpaceSwitcher');
const { Breadcrumbs } = await import('~/cms/components/layout/Breadcrumbs');
const { NewEntry } = await import('~/cms/components/layout/NewEntry');
const { DEFAULT_FEATURES } = await import('~/cms/lib/features');
const { plainKeyAllowed } = await import('~/cms/lib/shortcuts');
const { approvalsCountLabel, usePendingApprovalsCount } = await import('~/cms/lib/approvals');

function Here() {
  const loc = useLocation();
  return <p data-testid="path">{loc.pathname}</p>;
}

function renderAt(path: string, element: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [path] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  signOut.mockReset();
});

describe('breadcrumbs', () => {
  it('name a content type by its name, under the nav’s name for Content', async () => {
    renderAt('/content/article', <Breadcrumbs />);
    expect(screen.getByRole('link', { name: 'Content' }).getAttribute('href')).toBe('/content');
    expect(await screen.findByText('Article')).toBeTruthy();
  });

  it('name a page outside the nav as the shell names it, not by its URL', () => {
    renderAt('/team', <Breadcrumbs pages={[{ to: '/team', label: 'People and sign-in' }]} />);
    expect(screen.getByText('People and sign-in')).toBeTruthy();
    expect(screen.queryByText('Team')).toBeNull();
  });
});

describe('nav source', () => {
  it('lists the audit log once, as a Settings section', () => {
    const audit = SETTINGS_SECTIONS.filter((s) => s.label === 'Audit log');
    expect(audit).toHaveLength(1);
    expect(NAV.some((n) => n.label === 'Audit log')).toBe(false);
  });

  it('gives every destination a unique G-letter', () => {
    const keys = NAV.map((n) => n.shortcutKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every Settings section in exactly one group, and has no connection section', () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'team',
        'api-keys',
        'connected-apps',
        'roles',
        'webhooks',
        'environments',
        'locales',
        'redirects',
        'menus',
        'trash',
        'ai-actions',
        'functions',
        'extensions',
        'plugins',
        'audit-log',
      ]),
    );
    // The web app's session replaces the old token connection.
    expect(ids).not.toContain('connection');
  });

  it('labels the per-space team as space access, apart from the deployment’s people', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'team')?.label).toBe('Space access');
  });

  it('shows Approvals now its inbox exists', () => {
    expect(visibleNav(DEFAULT_FEATURES).some((n) => n.to === '/approvals')).toBe(true);
  });

  it('leaves Approvals out everywhere while its feature is off', () => {
    const off = visibleNav({ ...DEFAULT_FEATURES, approvals: false });
    expect(off.some((n) => n.to === '/approvals')).toBe(false);
    expect(off.some((n) => n.badge)).toBe(false);
  });
});

describe('approvals count', () => {
  function Count({ enabled }: { enabled: boolean }) {
    const n = usePendingApprovalsCount(enabled);
    return <p data-testid="count">{n === undefined ? 'unknown' : n}</p>;
  }

  it('shows the server’s total, not a count of capped lists', async () => {
    renderAt('/', <Count enabled />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3'));
  });

  it('asks nothing until the scope is known', () => {
    client.countPendingApprovals.mockClear();
    renderAt('/', <Count enabled={false} />);
    expect(screen.getByTestId('count').textContent).toBe('unknown');
    expect(client.countPendingApprovals).not.toHaveBeenCalled();
  });

  it('writes 99+ past two digits', () => {
    expect(approvalsCountLabel(7)).toBe('7');
    expect(approvalsCountLabel(99)).toBe('99');
    expect(approvalsCountLabel(100)).toBe('99+');
  });
});

describe('command palette', () => {
  const palette = (path: string) =>
    renderAt(
      path,
      <>
        <CommandPalette />
        <Here />
      </>,
    );

  it('offers every NAV destination and the real actions', async () => {
    palette('/content/article');
    act(openCommandPalette);
    const list = await screen.findByRole('listbox', { name: 'Results' });
    for (const n of visibleNav(DEFAULT_FEATURES))
      expect(within(list).getByRole('option', { name: n.label })).toBeTruthy();
    expect(within(list).getByRole('option', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(within(list).getByRole('option', { name: 'Sign out' })).toBeTruthy();
    await waitFor(() =>
      expect(within(list).getByRole('option', { name: 'New Article entry' })).toBeTruthy(),
    );
  });

  it('opens a singleton rather than offering a new entry or an import', async () => {
    client.listContentTypes.mockResolvedValueOnce([
      { apiId: 'article', name: 'Article', displayField: 'title', fields: [], status: 'published' },
      {
        apiId: 'settings',
        name: 'Site settings',
        displayField: 'title',
        fields: [],
        status: 'published',
        singleton: true,
      } as never,
    ]);
    palette('/content/settings');
    act(openCommandPalette);
    const list = await screen.findByRole('listbox', { name: 'Results' });
    const open = await within(list).findByRole('option', { name: 'Open Site settings' });
    expect(within(list).queryByRole('option', { name: /^New .* entry$/ })).toBeNull();
    expect(within(list).queryByRole('option', { name: /^Import / })).toBeNull();
    fireEvent.click(open);
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/content/settings/entry'),
    );
  });

  it('finds Settings sections by name once you type', async () => {
    palette('/dashboard');
    act(openCommandPalette);
    const input = await screen.findByRole('combobox', { name: 'Command palette search' });
    fireEvent.change(input, { target: { value: 'webhooks' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/settings/webhooks'));
  });

  it('says a search that missed out loud, from a region that was already there', async () => {
    palette('/dashboard');
    act(openCommandPalette);
    const input = await screen.findByRole('combobox', { name: 'Command palette search' });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.change(input, { target: { value: 'nothing is called this' } });
    expect(status.textContent).toBe('No results found.');
    // Once: the words on screen, inside the listbox, are hidden from a screen reader.
    const shown = within(screen.getByRole('listbox')).getByText('No results found.');
    expect(shown.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens on ⌘K', async () => {
    palette('/dashboard');
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByRole('combobox', { name: 'Command palette search' })).toBeTruthy();
  });
});

describe('settings nav', () => {
  it('links every section, grouped, marking the current one', () => {
    renderAt('/settings/webhooks', <SettingsNav section="webhooks" onSection={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const g of SETTINGS_GROUPS)
      expect(within(nav).getByRole('list', { name: g.label })).toBeTruthy();
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(SETTINGS_SECTIONS.length);
    expect(within(nav).getByRole('link', { name: 'Webhooks' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // The current section is the shared current item; the others aren't.
    expect(within(nav).getByRole('link', { name: 'Webhooks' }).className).toContain('current-item');
    expect(within(nav).getByRole('link', { name: 'Audit log' }).className).not.toContain(
      'current-item',
    );
  });
});

describe('New entry', () => {
  it("links straight to the content type's new entry on its pages", async () => {
    renderAt('/content/article', <NewEntry look="header" />);
    const link = await screen.findByRole('link', { name: 'New entry' });
    expect(link.getAttribute('href')).toBe('/content/article/new');
  });

  it('asks which content type anywhere else', async () => {
    renderAt('/releases', <NewEntry look="header" />);
    const button = await screen.findByRole('button', { name: 'New entry' });
    // Radix menus open on pointerdown, not click.
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    const item = await screen.findByRole('menuitem', { name: 'Article' });
    expect(item.getAttribute('href')).toBe('/content/article/new');
  });
});

describe('the header locale switcher', () => {
  it('says which locales Delivery doesn’t serve, in words', async () => {
    client.getSpaceConfig.mockResolvedValueOnce({
      locales: ['en-US', 'ar'],
      defaultLocale: 'en-US',
      localeSettings: {
        'en-US': { delivered: true, direction: 'ltr' },
        ar: { delivered: false, direction: 'rtl' },
      },
    } as never);
    renderAt('/', <SpaceSwitcher />);
    const trigger = await screen.findByRole('combobox', { name: 'Locale' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: 'ar Not delivered' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'en-US' })).toBeTruthy();
  });
});

describe('plainKeyAllowed', () => {
  it('rejects modifiers, fields and open dialogs', () => {
    const ev = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent('keydown', init);
      Object.defineProperty(e, 'target', { value: target });
      return e;
    };
    expect(plainKeyAllowed(ev({ key: 'g' }))).toBe(true);
    expect(plainKeyAllowed(ev({ key: 'g', ctrlKey: true }))).toBe(false);
    expect(plainKeyAllowed(ev({ key: 'g', altKey: true }))).toBe(false);
    const ta = document.createElement('textarea');
    expect(plainKeyAllowed(ev({ key: 'g' }, ta))).toBe(false);
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('data-state', 'open');
    document.body.appendChild(dlg);
    expect(plainKeyAllowed(ev({ key: 'g' }))).toBe(false);
    dlg.remove();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The page's server half isn't under test: only its screen, on the loader's answer below.
vi.mock('~/lib/audit.server', () => ({}));
vi.mock('~/lib/auth.server', () => ({}));
vi.mock('~/lib/invites.server', () => ({}));
vi.mock('~/lib/scim.server', () => ({}));
vi.mock('~/lib/settings.server', () => ({}));
vi.mock('~/lib/sso.server', () => ({}));
vi.mock('~/lib/team.server', () => ({}));
vi.mock('~/lib/two-factor.server', () => ({}));

const { default: Team } = await import('~/routes/team');

afterEach(cleanup);

const person = (over: Record<string, unknown>) => ({
  id: 'u-ada',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  role: 'admin',
  createdAt: 1,
  lastLoginAt: null,
  disabledAt: null,
  twoFactorAt: null,
  passwordChangeDue: false,
  ...over,
});

const people = [
  person({ twoFactorAt: 1 }),
  person({ id: 'u-bo', email: 'bo@example.com', name: 'Bo', role: 'member' }),
  person({
    id: 'u-cy',
    email: 'cy@example.com',
    name: 'Cy',
    role: 'member',
    twoFactorAt: 1,
    passwordChangeDue: true,
  }),
  person({ id: 'u-di', email: 'di@example.com', name: 'Di', role: 'member', disabledAt: 1 }),
];

async function renderPage() {
  const sent: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: '/team',
      // biome-ignore lint/suspicious/noExplicitAny: the stub's props aren't the route's own.
      Component: Team as any,
      HydrateFallback: () => null,
      loader: () => ({
        people,
        me: { kind: 'user', id: 'u-ada' },
        now: 0,
        twoFactorRequired: 'off',
        sso: null,
        scim: { endpoint: 'https://x.example/scim', token: null, groups: [] },
        signInUrl: 'https://x.example/login',
        stepUp: 'password',
        invites: [],
        spaces: [],
      }),
      action: async ({ request }) => {
        sent.push(
          Object.fromEntries((await request.formData()).entries()) as Record<string, string>,
        );
        return { ok: true, done: 'Done.' };
      },
    },
  ]);
  render(<Stub initialEntries={['/team']} />);
  await screen.findByRole('list', { name: 'People' });
  return sent;
}

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
const openMenu = (name: string) =>
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });

describe('People and sign-in: the people list', () => {
  it('keeps what the table said: who, two-factor, sign-in, status and role', async () => {
    await renderPage();
    const ada = row('Ada Lovelace');
    expect(within(ada).getByText('AL')).toBeTruthy();
    expect(within(ada).getByText('you')).toBeTruthy();
    expect(within(ada).getByText('ada@example.com')).toBeTruthy();
    expect(within(ada).getByText('Two-factor')).toBeTruthy();
    expect(within(ada).getByText('Last sign-in')).toBeTruthy();
    expect(within(ada).getByText('Never')).toBeTruthy();
    expect(within(row('Cy')).getByText('Temporary password')).toBeTruthy();
    expect(within(row('Di')).getByText('Disabled')).toBeTruthy();
    expect(within(row('Bo')).queryByText('Disabled')).toBeNull();
    expect(within(row('Bo')).getByLabelText('Role for Bo')).toHaveProperty('value', 'member');
  });

  it('finds people by name or email and by status; a miss says how to get them back', async () => {
    await renderPage();
    const search = screen.getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(search, { target: { value: 'BO@EX' } });
    expect(screen.getByText('Bo')).toBeTruthy();
    expect(screen.queryByText('Cy')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }));
    expect(screen.queryByRole('list', { name: 'People' })).toBeNull();
    expect(screen.getByText(/No people match/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Cy')).toBeTruthy();
    expect(screen.getByText('Di')).toBeTruthy();
  });

  it('leaves two actions as buttons, and yourself no way to disable yourself', async () => {
    await renderPage();
    const bo = row('Bo');
    expect(within(bo).getByRole('button', { name: /^Reset password for / })).toBeTruthy();
    expect(within(bo).getByRole('button', { name: /^Disable for / })).toBeTruthy();
    expect(within(row('Di')).getByRole('button', { name: /^Enable for / })).toBeTruthy();
    const ada = row('Ada Lovelace');
    expect(
      within(ada)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toContain('Reset password…');
    expect(within(ada).queryByRole('button', { name: /^Disable for / })).toBeNull();
    expect(within(ada).queryByRole('button', { name: /^More actions/ })).toBeNull();
  });

  it('folds a third action behind ⋯; its question takes focus, and Keep goes back to the ⋯', async () => {
    await renderPage();
    const more = screen.getByRole('button', { name: 'More actions for Cy' });
    more.focus();
    openMenu('More actions for Cy');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset two-factor…' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByText(/Turn off Cy’s two-factor sign-in/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Keep' })),
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it('sends what a menu’s question asked, for the person it was asked about', async () => {
    const sent = await renderPage();
    openMenu('More actions for Cy');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disable…' }));
    const ask = await screen.findByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ intent: 'disable', id: 'u-cy' }));
  });

  it('drops an open question when the filter moves on, so it can’t return unasked', async () => {
    await renderPage();
    fireEvent.click(within(row('Bo')).getByRole('button', { name: /^Disable for / }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    const search = screen.getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(search, { target: { value: 'cy' } });
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText('Bo')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

vi.stubGlobal('scrollTo', () => {});

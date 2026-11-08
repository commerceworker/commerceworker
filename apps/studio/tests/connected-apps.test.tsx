// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's Checkbox measures itself through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/**
 * `useScopedQuery`/`useInvalidate` exist to scope the TanStack cache by
 * connection; that scoping is not what these tests are about. Standing in a
 * minimal fetch-and-refetch keeps the component under test untouched while
 * still exercising its real rendering, interactions and client calls.
 */
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

const { ConnectedApps } = await import('~/cms/components/ConnectedApps');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;
type ConnectedApp = import('~/cms/lib/management').ConnectedApp;
type PersonalAccessToken = import('~/cms/lib/management').PersonalAccessToken;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const renderWith = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

const HOUR = 3600_000;

function fakeClient(over: { apps?: ConnectedApp[]; tokens?: PersonalAccessToken[] } = {}) {
  let apps: ConnectedApp[] = over.apps ?? [];
  let tokens: PersonalAccessToken[] = over.tokens ?? [];
  return {
    listConnectedApps: vi.fn(async () => apps),
    revokeConnectedApp: vi.fn(async (clientId: string, subject: string) => {
      const before = apps.length;
      apps = apps.filter((a) => !(a.clientId === clientId && a.subject === subject));
      return { revokedTokens: before - apps.length };
    }),
    listPersonalAccessTokens: vi.fn(async () => tokens),
    createPersonalAccessToken: vi.fn(
      async (input: { name: string; scopes: string[]; expiresInDays?: number }) => {
        const pat: PersonalAccessToken = {
          id: `pat-${tokens.length + 1}`,
          name: input.name,
          subject: 'admin@example.com',
          scopes: input.scopes,
          revoked: false,
        };
        tokens = [...tokens, pat];
        return { id: pat.id, token: 'cwpat_cda_secret-value' };
      },
    ),
    revokePersonalAccessToken: vi.fn(async (id: string) => {
      tokens = tokens.map((t) => (t.id === id ? { ...t, revoked: true } : t));
    }),
  };
}

const claude: ConnectedApp = {
  clientId: 'client-1',
  clientName: 'Claude',
  subject: 'editor@example.com',
  scopes: ['delivery:read', 'preview:read'],
  tokenCount: 2,
  lastUsedAt: '2026-08-15T10:00:00.000Z',
};

/** Confirms the destructive action inside the radix AlertDialog portal. */
async function confirm(triggerName: RegExp | string, confirmName: RegExp | string) {
  fireEvent.click(screen.getByRole('button', { name: triggerName }));
  const button = await screen.findByRole('button', { name: confirmName });
  fireEvent.click(button);
}

describe('Connected applications', () => {
  it('lists each connection with who authorized it and what it can do', async () => {
    const client = fakeClient({ apps: [claude] });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);

    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(screen.getByText('editor@example.com')).toBeTruthy();
    // Scopes are shown in plain language, not as raw scope strings.
    expect(screen.getByText('Access: Read published content, Read drafts')).toBeTruthy();
    // Several tokens behind one connection is surfaced, not hidden.
    expect(screen.getByText('2 active tokens')).toBeTruthy();
    // With no column headers, each fact says what it is.
    const row = screen.getByText('Claude').closest('li') as HTMLElement;
    expect(row.textContent).toContain('Authorized by editor@example.com');
    expect(row.textContent).toContain('Last used');
  });

  it('confirms a disconnect in red: it removes the access for good', async () => {
    const client = fakeClient({ apps: [claude] });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('Claude');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect “Claude”' }));
    const dialog = await screen.findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: 'Disconnect' });
    expect(action.className).toContain('text-destructive');
  });

  it('disconnects an application by client and subject', async () => {
    const client = fakeClient({ apps: [claude] });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('Claude');

    await confirm('Disconnect “Claude”', 'Disconnect');
    await waitFor(() =>
      expect(client.revokeConnectedApp).toHaveBeenCalledWith('client-1', 'editor@example.com'),
    );
    // The row goes away once the list refetches.
    await waitFor(() => expect(screen.queryByText('Claude')).toBeNull());
  });

  it('shows an empty state when nothing is connected', async () => {
    const client = fakeClient();
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    expect(await screen.findByText('No applications are connected.')).toBeTruthy();
  });
});

describe('Personal access tokens', () => {
  it('creates a token with the chosen scopes and reveals it exactly once', async () => {
    const client = fakeClient();
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('No personal access tokens yet.');

    fireEvent.change(screen.getByPlaceholderText(/What is it for/), {
      target: { value: 'release CI' },
    });
    // Default selection is read-only; add write.
    fireEvent.click(screen.getByLabelText('Create and edit content'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() =>
      expect(client.createPersonalAccessToken).toHaveBeenCalledWith({
        name: 'release CI',
        scopes: ['delivery:read', 'search:read', 'content:write'],
        expiresInDays: undefined,
      }),
    );
    // Shown once, with a copy affordance — it is never retrievable again.
    expect(await screen.findByText('cwpat_cda_secret-value')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('passes an expiry when one is given', async () => {
    const client = fakeClient();
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('No personal access tokens yet.');

    fireEvent.change(screen.getByPlaceholderText(/What is it for/), {
      target: { value: 'temp' },
    });
    fireEvent.change(screen.getByPlaceholderText('Expires in days'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() =>
      expect(client.createPersonalAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ expiresInDays: 30 }),
      ),
    );
  });

  it('will not submit without a name or with no scopes selected', async () => {
    const client = fakeClient();
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('No personal access tokens yet.');

    const submit = screen.getByRole('button', { name: 'Create token' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/What is it for/), { target: { value: 'x' } });
    expect(
      (screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    // Clearing every scope disables it again — a token with no access is not a token.
    fireEvent.click(screen.getByLabelText('Read published content'));
    fireEvent.click(screen.getByLabelText('Search content'));
    expect(
      (screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // Accessible names for the scope checkboxes are guarded in
  // checkbox-a11y.test.tsx. They are deliberately NOT asserted here with
  // getByRole({ name }): jsdom resolves a wrapping <label> that Chrome ignores,
  // so that form of assertion passes even when the name is missing.

  it('distinguishes active, expired and revoked tokens by text', async () => {
    const client = fakeClient({
      tokens: [
        { id: 'a', name: 'live', scopes: ['delivery:read'], revoked: false },
        {
          id: 'b',
          name: 'lapsed',
          scopes: ['delivery:read'],
          revoked: false,
          expiresAt: new Date(Date.now() - HOUR).toISOString(),
        },
        { id: 'c', name: 'gone', scopes: ['delivery:read'], revoked: true },
      ],
    });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);

    // Status is never conveyed by color alone (PRODUCT.md accessibility line).
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    // A never-expiring token says so rather than leaving a gap
    // ('live' and 'gone' both lack an expiry).
    expect(screen.getAllByText('Never expires')).toHaveLength(2);
    expect((screen.getByText('lapsed').closest('li') as HTMLElement).textContent).toContain(
      'Expires',
    );
    // Revoked rows offer no revoke action.
    expect(screen.getAllByRole('button', { name: /^Revoke / })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Revoke “gone”' })).toBeNull();
  });

  it('tells unnamed tokens apart by the end of their id, on screen and to a screen reader', async () => {
    const client = fakeClient({
      tokens: [
        { id: '0190-aaaa-1111', scopes: ['delivery:read'], revoked: false },
        { id: '0190-aaaa-2222', scopes: ['delivery:read'], revoked: false },
      ],
    });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);

    expect(await screen.findByText('ID ending 1111')).toBeTruthy();
    expect(screen.getByText('ID ending 2222')).toBeTruthy();
    await confirm('Revoke the unnamed token ending 2222', 'Revoke token');
    await waitFor(() =>
      expect(client.revokePersonalAccessToken).toHaveBeenCalledWith('0190-aaaa-2222'),
    );
  });

  it('revokes a token', async () => {
    const client = fakeClient({
      tokens: [{ id: 'a', name: 'live', scopes: ['delivery:read'], revoked: false }],
    });
    renderWith(<ConnectedApps client={client as unknown as ManagementClient} />);
    await screen.findByText('live');

    await confirm('Revoke “live”', 'Revoke token');
    await waitFor(() => expect(client.revokePersonalAccessToken).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.getByText('Revoked')).toBeTruthy());
  });
});

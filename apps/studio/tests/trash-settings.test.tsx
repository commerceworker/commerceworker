// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's radio group measures itself through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The TanStack cache scoping isn't under test here (see connected-apps.test.tsx): each query
// loads when its key changes, and an invalidation reloads every one.
const refetchers = new Set<() => void>();
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const [error, setError] = useState<unknown>(null);
    const fn = useRef(queryFn);
    fn.current = queryFn;
    const key = JSON.stringify(segments);
    const load = useCallback(() => {
      setError(null);
      fn.current().then(setData, setError);
    }, [key]);
    useEffect(() => {
      load();
      refetchers.add(load);
      return () => {
        refetchers.delete(load);
      };
    }, [load]);
    return { data, isError: error !== null, error, refetch: async () => load() };
  },
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

const { TrashSettings, retentionDaysOf } = await import('~/cms/components/TrashSettings');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

function fakeClient(initial: number | null) {
  let saved = initial;
  return {
    getTrashSettings: vi.fn(async () => ({ retentionDays: saved })),
    setTrashSettings: vi.fn(async (input: { retentionDays: number | null }) => {
      saved = input.retentionDays;
      return { retentionDays: saved };
    }),
  };
}

const renderTrash = (client: ReturnType<typeof fakeClient>) =>
  render(
    <ToastProvider>
      <TrashSettings client={client as unknown as ManagementClient} />
    </ToastProvider>,
  );

describe('Settings → Trash', () => {
  it('is off by default, and says the trash is kept until someone deletes it', async () => {
    const client = fakeClient(null);
    renderTrash(client);
    const off = await screen.findByRole('radio', { name: 'Keep until deleted' });
    expect(off.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/stay in the trash until someone restores them/)).toBeTruthy();
    expect(screen.queryByLabelText('Days in the trash')).toBeNull();
    // Nothing changed: nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('turning it on asks first, says what it deletes, and saves the days', async () => {
    const client = fakeClient(null);
    renderTrash(client);
    fireEvent.click(await screen.findByRole('radio', { name: 'Delete after a while' }));
    const days = screen.getByLabelText('Days in the trash');
    fireEvent.change(days, { target: { value: '14' } });
    expect(screen.getByText(/hourly sweep permanently deletes entries/)).toBeTruthy();
    expect(screen.getByText(/longer than 14 days/)).toBeTruthy();
    expect(screen.getByText(/link to is kept/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Asked in a modal: it deletes trash that is already old enough, for good.
    const ask = await screen.findByRole('alertdialog', {
      name: 'Delete trashed entries after 14 days?',
    });
    expect(client.setTrashSettings).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Save and delete' }));
    await screen.findByText('Trashed entries are deleted after 14 days');
    expect(client.setTrashSettings).toHaveBeenCalledExactlyOnceWith({ retentionDays: 14 });
  });

  it('turning it off saves at once, with nothing to confirm', async () => {
    const client = fakeClient(30);
    renderTrash(client);
    const days = await screen.findByLabelText('Days in the trash');
    expect((days as HTMLInputElement).value).toBe('30');
    fireEvent.click(screen.getByRole('radio', { name: 'Keep until deleted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Trashed entries are kept until someone deletes them');
    expect(client.setTrashSettings).toHaveBeenCalledExactlyOnceWith({ retentionDays: null });
  });

  it('refuses days out of range before asking the API, and ties the reason to the field', async () => {
    const client = fakeClient(30);
    renderTrash(client);
    const days = await screen.findByLabelText('Days in the trash');
    fireEvent.change(days, { target: { value: '0' } });
    const reason = screen.getByText(/A whole number of days, from 1 to 3650/);
    expect(days.getAttribute('aria-invalid')).toBe('true');
    expect(days.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    fireEvent.change(days, { target: { value: '7' } });
    expect(days.getAttribute('aria-describedby')?.split(' ')).not.toContain(reason.id);
  });

  it('shows the refusal of a role that may not change it', async () => {
    const client = fakeClient(30);
    client.setTrashSettings.mockRejectedValueOnce(new ApiError(403, 'Missing scope space:admin'));
    renderTrash(client);
    fireEvent.click(await screen.findByRole('radio', { name: 'Keep until deleted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setTrashSettings).toHaveBeenCalled());
    expect(await screen.findByText(/space:admin/)).toBeTruthy();
  });
});

describe('Settings → Trash loading', () => {
  it('says it is loading, busy, until the setting arrives', async () => {
    let answer: (v: { retentionDays: number | null }) => void = () => {};
    const client = fakeClient(null);
    client.getTrashSettings.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    renderTrash(client);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading the trash setting…');
    expect(status.closest('[aria-busy="true"]')).toBeTruthy();
    answer({ retentionDays: null });
    await screen.findByRole('radio', { name: 'Keep until deleted' });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('says a failed load as one, with Retry, never as a setting that looks off', async () => {
    const client = fakeClient(14);
    client.getTrashSettings.mockRejectedValueOnce(new ApiError(500, 'D1 is unavailable'));
    renderTrash(client);
    await screen.findByText('The trash setting didn’t load');
    expect(screen.getByText('D1 is unavailable')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Keep until deleted' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByLabelText('Days in the trash')) as HTMLInputElement).toHaveProperty(
      'value',
      '14',
    );
  });
});

describe('retentionDaysOf', () => {
  it('takes whole days from 1 to 3650 and nothing else', () => {
    expect(retentionDaysOf('30')).toBe(30);
    expect(retentionDaysOf(' 7 ')).toBe(7);
    expect(retentionDaysOf('3650')).toBe(3650);
    expect(retentionDaysOf('0')).toBeNull();
    expect(retentionDaysOf('3651')).toBeNull();
    expect(retentionDaysOf('1.5')).toBeNull();
    expect(retentionDaysOf('')).toBeNull();
  });
});

// @vitest-environment jsdom
import type { Redirect } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's Switch measures itself through it.
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

const { Redirects } = await import('~/cms/components/Redirects');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const AT = '2026-01-01T00:00:00.000Z';
const redirect = (over: Partial<Redirect>): Redirect => ({
  id: 'r1',
  source: '/old',
  destination: '/new',
  status: 301,
  enabled: true,
  origin: 'manual',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function fakeClient(
  items: Redirect[],
  chains: { id: string; via: string[]; destination: string }[] = [],
) {
  return {
    listRedirects: vi.fn(async (q: { q?: string }) => ({
      items: items.filter((r) => !q.q || r.source.includes(q.q) || (r.note ?? '').includes(q.q)),
    })),
    analyzeRedirects: vi.fn(async () => ({
      loops: [],
      chains,
      duplicates: [],
      count: items.length,
      max: 10000,
    })),
    getSpaceConfig: vi.fn(async () => ({ defaultLocale: 'en-US', locales: ['en-US', 'de'] })),
    createRedirect: vi.fn(async (_input: unknown) => ({ redirect: items[0], chains: [] })),
    updateRedirect: vi.fn(async () => ({ redirect: items[0], chains: [] })),
    deleteRedirect: vi.fn(async () => {}),
    collapseRedirectChains: vi.fn(async () => ({ updated: 1 })),
    importRedirects: vi.fn(async (input: { dryRun?: boolean }) => ({
      dryRun: input.dryRun === true,
      created: 2,
      updated: 0,
      unchanged: 0,
      chains: [],
    })),
  };
}

const renderRedirects = (client: ReturnType<typeof fakeClient>) =>
  render(
    <ToastProvider>
      <Redirects client={client as unknown as ManagementClient} />
    </ToastProvider>,
  );

describe('Settings → Redirects', () => {
  it('lists redirects with their status, locale and where a slug change made one', async () => {
    renderRedirects(
      fakeClient([
        redirect({}),
        redirect({
          id: 'r2',
          source: '/blog/a',
          destination: '/blog/b',
          origin: 'slug',
          locale: 'de',
          status: 308,
        }),
      ]),
    );
    const row = (await screen.findByText('/blog/a')).closest('li') as HTMLElement;
    expect(within(row).getByText('From a slug change')).toBeTruthy();
    expect(within(row).getByText('Locale de')).toBeTruthy();
    expect(within(row).getByText('308')).toBeTruthy();
    const plain = screen.getByText('/old').closest('li') as HTMLElement;
    expect(within(plain).getByText('All locales')).toBeTruthy();
  });

  it('says how to start when there are none', async () => {
    renderRedirects(fakeClient([]));
    expect(await screen.findByText('No redirects yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New redirect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  });

  it('searches, and says when a search misses', async () => {
    const client = fakeClient([redirect({})]);
    renderRedirects(client);
    await screen.findByText('/old');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search redirects' }), {
      target: { value: 'zzz' },
    });
    await screen.findByText('No redirects match “zzz”.');
    expect(client.listRedirects).toHaveBeenLastCalledWith({ q: 'zzz', limit: 100 });
  });

  it('switches a redirect off from its row', async () => {
    const client = fakeClient([redirect({})]);
    renderRedirects(client);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enabled: /old' }));
    await waitFor(() =>
      expect(client.updateRedirect).toHaveBeenCalledWith('r1', { enabled: false }),
    );
  });

  it('adds a redirect, and shows the API’s refusal beside its field', async () => {
    const client = fakeClient([redirect({})]);
    client.createRedirect.mockRejectedValueOnce(
      new ApiError(422, 'refused', {
        error: {
          code: 'validation_failed',
          issues: [
            { field: 'destination', message: 'These redirects send readers round in a loop' },
          ],
        },
      }),
    );
    renderRedirects(client);
    await screen.findByText('/old');
    fireEvent.click(screen.getByRole('button', { name: 'New redirect' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '/new' } });
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '/old' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add redirect' }));
    expect(await within(dialog).findByText(/round in a loop/)).toBeTruthy();
    expect(within(dialog).getByLabelText('To').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '/newer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add redirect' }));
    await waitFor(() => expect(client.createRedirect).toHaveBeenCalledTimes(2));
    expect(client.createRedirect.mock.calls[1]?.[0]).toEqual({
      source: '/new',
      destination: '/newer',
      status: 301,
      locale: null,
      enabled: true,
      note: null,
    });
  });

  it('offers to collapse chains when the set has them', async () => {
    const client = fakeClient([redirect({})], [{ id: 'r1', via: ['r2'], destination: '/c' }]);
    renderRedirects(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse chains' }));
    await waitFor(() => expect(client.collapseRedirectChains).toHaveBeenCalled());
  });

  it('imports after a check, writing nothing until Import', async () => {
    const client = fakeClient([redirect({})]);
    renderRedirects(client);
    await screen.findByText('/old');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('CSV'), {
      target: { value: 'source,destination\n/a,/b\n/c,/d\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    expect(await within(dialog).findByText(/2 to add/)).toBeTruthy();
    expect(client.importRedirects).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
      expect.any(AbortSignal),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(client.importRedirects).toHaveBeenLastCalledWith(
        expect.objectContaining({ format: 'csv', dryRun: false }),
      ),
    );
  });

  it('names each bad row when an import is refused', async () => {
    const client = fakeClient([redirect({})]);
    client.importRedirects.mockRejectedValueOnce(
      new ApiError(422, 'refused', {
        error: {
          issues: [{ field: 'rows[1].source', message: 'A source is a path starting with /' }],
        },
      }),
    );
    renderRedirects(client);
    await screen.findByText('/old');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('CSV'), {
      target: { value: 'source,destination\n/a,/b\nbad,/d\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    expect(
      await within(dialog).findByText('Row 2: A source is a path starting with /'),
    ).toBeTruthy();
  });
});

// @vitest-environment jsdom
// Settings → Locales: whether Delivery serves each locale and which way its text runs, saved per
// change, with turning a locale off asked first and the default locale's switch off-limits.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementClient, SpaceConfig } from '~/cms/lib/management';

// jsdom ships no ResizeObserver; radix's radio group and switch measure themselves through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let current: Record<string, unknown> = {};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client: current, conn: { space: 'blog', environment: 'main' } }),
}));

const { LocaleSettings } = await import('~/cms/components/LocaleSettings');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');

afterEach(cleanup);

const CONFIG: SpaceConfig = {
  spaceId: 'blog',
  name: 'Blog',
  defaultLocale: 'en',
  locales: ['en', 'fr', 'ar'],
  fallbacks: { fr: 'en' },
  localeSettings: {
    en: { delivered: true, direction: 'ltr' },
    fr: { delivered: true, direction: 'ltr' },
    ar: { delivered: true, direction: 'rtl' },
  },
};

function fakeClient(opts: { scopes?: string[]; failFirstLoad?: boolean } = {}) {
  let config = CONFIG;
  let failing = opts.failFirstLoad === true;
  const client = {
    getSpaceConfig: vi.fn(async () => {
      if (failing) {
        failing = false;
        throw new ApiError(500, 'The database is busy');
      }
      return config;
    }),
    getSpaceAccess: vi.fn(async () => ({
      spaceId: 'blog',
      kind: 'user',
      scopes: opts.scopes ?? ['space:admin', 'preview:read'],
    })),
    setLocaleSettings: vi.fn(
      async (changes: Record<string, { delivered?: boolean; direction?: 'ltr' | 'rtl' }>) => {
        const next = { ...config.localeSettings };
        for (const [locale, change] of Object.entries(changes)) {
          next[locale] = { ...(next[locale] ?? { delivered: true, direction: 'ltr' }), ...change };
        }
        config = { ...config, localeSettings: next };
        return config;
      },
    ),
  };
  current = client;
  return client;
}

const renderLocales = (client: ReturnType<typeof fakeClient>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <LocaleSettings client={client as unknown as ManagementClient} />
      </ToastProvider>
    </QueryClientProvider>,
  );

const rowOf = (locale: string) =>
  screen.getByText(locale, { selector: 'span.font-medium' }).closest('li') as HTMLElement;

describe('Settings → Locales', () => {
  it('draws the list while it loads, then a row per locale with its fallback', async () => {
    const client = fakeClient();
    const { container } = renderLocales(client);
    // Drawn Page: the list and its captions are real while the rows load, and the region says it
    // is loading.
    expect(screen.getByRole('list', { name: 'Locales' })).toBeTruthy();
    expect(screen.getAllByText('Delivered').length).toBe(2);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading the locale settings…');

    await screen.findByRole('switch', { name: 'Deliver fr' });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(rowOf('en')).getByText('Default')).toBeTruthy();
    expect(within(rowOf('en')).getByText('No fallback')).toBeTruthy();
    expect(within(rowOf('fr')).getAllByText('en').length).toBe(1);
    // No fallback set: the chain ends at the default locale.
    expect(within(rowOf('ar')).getByText('en')).toBeTruthy();
    expect(
      within(rowOf('ar'))
        .getByRole('radio', { name: 'Right to left' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps the default locale delivered, and says why', async () => {
    renderLocales(fakeClient());
    const en = await screen.findByRole('switch', { name: 'Deliver en' });
    expect(en).toHaveProperty('disabled', true);
    const why = document.getElementById(en.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toMatch(/every fallback ends here/);
  });

  it('saves a direction at once and reloads the space config', async () => {
    const client = fakeClient();
    renderLocales(client);
    await screen.findByRole('switch', { name: 'Deliver fr' });
    fireEvent.click(within(rowOf('fr')).getByRole('radio', { name: 'Right to left' }));
    await waitFor(() =>
      expect(client.setLocaleSettings).toHaveBeenCalledWith({ fr: { direction: 'rtl' } }),
    );
    await waitFor(() => expect(client.getSpaceConfig.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(
        within(rowOf('fr'))
          .getByRole('radio', { name: 'Right to left' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('asks in place before Delivery stops serving a locale, and backs out without a save', async () => {
    const client = fakeClient();
    renderLocales(client);
    const fr = await screen.findByRole('switch', { name: 'Deliver fr' });
    fireEvent.click(fr);
    const ask = screen.getByRole('alertdialog', { name: 'Stop delivering fr?' });
    expect(within(ask).getByRole('button', { name: 'Keep delivering' })).toBe(
      document.activeElement,
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep delivering' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.setLocaleSettings).not.toHaveBeenCalled();
    expect(fr.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(fr);
    fireEvent.click(screen.getByRole('button', { name: 'Stop delivering' }));
    await waitFor(() =>
      expect(client.setLocaleSettings).toHaveBeenCalledWith({ fr: { delivered: false } }),
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Deliver fr' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    // Turning it back on asks nothing.
    fireEvent.click(screen.getByRole('switch', { name: 'Deliver fr' }));
    await waitFor(() =>
      expect(client.setLocaleSettings).toHaveBeenLastCalledWith({ fr: { delivered: true } }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('is read only without space:admin, and says so', async () => {
    const client = fakeClient({ scopes: ['preview:read', 'content:write'] });
    renderLocales(client);
    expect(await screen.findByText(/takes the space:admin permission/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Deliver fr' })).toHaveProperty('disabled', true);
    for (const radio of within(rowOf('ar')).getAllByRole('radio')) {
      expect(radio).toHaveProperty('disabled', true);
    }
  });

  it('says a failed load is one, with Retry, never as locales turned off', async () => {
    const client = fakeClient({ failFirstLoad: true });
    renderLocales(client);
    expect(await screen.findByText('The locale settings didn’t load')).toBeTruthy();
    expect(screen.getByText('The database is busy')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch', { name: 'Deliver fr' })).toBeTruthy();
  });
});

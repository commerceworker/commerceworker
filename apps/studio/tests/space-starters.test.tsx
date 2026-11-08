// Creating a space with the deployment's starters: the list comes from GET /starters (the two
// every deployment has when it can't be read), and a starter that installs in the background
// switches to the new space at once and follows the install in the dialog until it completes or
// stops. Through the real Management client and scope provider, against a mocked same-origin fetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTER_INSTALL_POLL_MS } from '~/cms/components/layout/StarterInstallProgress';
import { ClientProvider } from '~/cms/lib/client-context';
import type { StarterInstall } from '~/cms/lib/management';
import { ToastProvider } from '~/cms/lib/toast';
import { CmsPage } from '~/cms/providers';

vi.mock('~/lib/use-me', () => ({
  useMe: () => ({ kind: 'user', id: 'usr_1', name: 'Pat', role: 'admin' }),
  useCan: () => true,
}));

const ENTERPRISE = {
  id: 'enterprise',
  title: 'Enterprise demo (Aldermoor)',
  description: 'A global professional-services firm in 13 locales.',
  background: true,
};
const SAMPLE = {
  id: 'sample',
  title: 'Start with sample content',
  description: 'A content model covering every field type.',
  background: false,
};
const EMPTY = {
  id: 'empty',
  title: 'Empty space',
  description: 'No content types and no entries.',
  background: false,
};

const progress = (over: Partial<StarterInstall>): StarterInstall => ({
  install: 'inst-1',
  starter: 'enterprise',
  step: 1,
  steps: 3,
  phase: 'model',
  title: 'Content model',
  jobId: 'job-1',
  status: 'running',
  ...over,
});

function setup(opts: { starters?: 'fail'; installs?: StarterInstall[] } = {}) {
  const spaces: { id: string; name: string }[] = [];
  const posts: unknown[] = [];
  const reads: string[] = [];
  const installs = [...(opts.installs ?? [])];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === '/starters') {
      return opts.starters === 'fail'
        ? json({ error: { message: 'down' } }, 500)
        : json({ items: [SAMPLE, EMPTY, ENTERPRISE] });
    }
    if (url === '/spaces' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { spaceId: string; name: string };
      posts.push(body);
      spaces.push({ id: body.spaceId, name: body.name });
      return json(
        {
          id: body.spaceId,
          name: body.name,
          starter: 'enterprise',
          installing: { install: 'inst-1', jobId: 'job-1', steps: 3 },
        },
        201,
      );
    }
    if (url === '/spaces') return json({ items: spaces });
    if (url.includes('/starter-installs/')) {
      reads.push(url);
      return json(installs.length > 1 ? installs.shift() : installs[0]);
    }
    if (url.endsWith('/space-config'))
      return json({ spaceId: 'aldermoor', defaultLocale: 'en-US', locales: ['en-US'] });
    return json({});
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <ToastProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ClientProvider fetchImpl={fetchImpl}>
            <CmsPage title="Overview">
              <p>The overview</p>
            </CmsPage>
          </ClientProvider>
        </QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { posts, reads };
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Create a space' }));
  return screen.findByRole('dialog', { name: 'New space' });
}

async function createEnterprise(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aldermoor' } });
  fireEvent.click(within(dialog).getByRole('radio', { name: /Enterprise demo/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create space' }));
}

describe('space starters', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the deployment’s background starter, then follows its install to completion', async () => {
    const { posts, reads } = setup({
      installs: [
        progress({}),
        progress({ step: 2, phase: 'content', title: 'Insights and case studies' }),
        progress({
          step: 3,
          phase: 'governance',
          title: 'Teams and workflows',
          status: 'completed',
        }),
      ],
    });
    const dialog = await openDialog();
    const enterprise = await within(dialog).findByRole('radio', { name: /Enterprise demo/ });
    expect(enterprise.closest('label')?.textContent).toMatch(/Installs in the background/);
    expect(enterprise.closest('label')?.textContent).toMatch(/13 locales/);

    await createEnterprise(dialog);
    await waitFor(() =>
      expect(posts).toEqual([
        { spaceId: 'aldermoor', name: 'Aldermoor', defaultLocale: 'en-US', starter: 'enterprise' },
      ]),
    );
    // The scope has moved to the new space while the dialog stays on the install.
    expect(await screen.findByText('The overview')).toBeTruthy();
    const card = await within(dialog).findByRole('region', { name: 'Starter install' });
    expect(await within(card).findByText('Installing Content model: step 1 of 3…')).toBeTruthy();
    expect(reads[0]).toBe('/spaces/aldermoor/environments/main/starter-installs/inst-1');
    expect(within(dialog).getByRole('button', { name: 'Close and keep installing' })).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(STARTER_INSTALL_POLL_MS));
    expect(
      await within(card).findByText('Installing Insights and case studies: step 2 of 3…'),
    ).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(STARTER_INSTALL_POLL_MS));
    expect(await within(card).findByText('Installed Enterprise demo (Aldermoor)')).toBeTruthy();

    // Done: polling stops.
    const count = reads.length;
    await act(() => vi.advanceTimersByTimeAsync(STARTER_INSTALL_POLL_MS * 3));
    expect(reads.length).toBe(count);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says honestly where an install stopped, what failed and how to finish it', async () => {
    setup({
      installs: [
        progress({
          step: 2,
          phase: 'content',
          title: 'Insights and case studies',
          status: 'failed',
          failures: [{ id: 'c00000', error: 'Chunk failed after 5 attempts' }],
        }),
      ],
    });
    const dialog = await openDialog();
    await within(dialog).findByRole('radio', { name: /Enterprise demo/ });
    await createEnterprise(dialog);
    const card = await within(dialog).findByRole('region', { name: 'Starter install' });
    expect(
      await within(card).findByText('The install stopped at Insights and case studies'),
    ).toBeTruthy();
    const alert = within(card).getByRole('alert');
    expect(alert.textContent).toMatch(/Chunk failed after 5 attempts/);
    expect(alert.textContent).toMatch(/Create the space again/);
    expect(within(card).getByText(/1 of 3 steps done/)).toBeTruthy();
  });

  it('falls back to sample and empty when the starters can’t be read', async () => {
    setup({ starters: 'fail' });
    const dialog = await openDialog();
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByRole('radio')
          .map((r) => (r as HTMLInputElement).value),
      ).toEqual(['sample', 'empty']),
    );
    expect(within(dialog).queryByRole('radio', { name: /Enterprise demo/ })).toBeNull();
  });
});

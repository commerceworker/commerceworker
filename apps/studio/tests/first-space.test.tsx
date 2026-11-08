// The CMS with no space to work in: a deployment admin creates the first one (sample content or
// empty) and lands in it; a member is told to ask a deployment admin. Through the real Management
// client and scope provider, against a mocked same-origin fetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spaceIdFrom } from '~/cms/components/layout/CreateSpaceDialog';
import { ClientProvider } from '~/cms/lib/client-context';
import { ToastProvider } from '~/cms/lib/toast';
import { CmsPage } from '~/cms/providers';
import type { Role } from '~/lib/roles';

const me = vi.hoisted(() => ({ role: 'admin' as Role }));
vi.mock('~/lib/use-me', () => ({
  useMe: () => ({ kind: 'user', id: 'usr_1', name: 'Pat', role: me.role }),
  useCan: (min: Role) => min === 'member' || me.role === 'admin',
}));

function setup() {
  const spaces: { id: string; name: string }[] = [];
  const posts: unknown[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === '/spaces' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { spaceId: string; name: string };
      posts.push(body);
      spaces.push({ id: body.spaceId, name: body.name });
      return json({ id: body.spaceId, name: body.name, starter: 'sample' }, 201);
    }
    if (url === '/spaces') return json({ items: spaces });
    if (url.endsWith('/space-config'))
      return json({ spaceId: 'marketing-site', defaultLocale: 'en-US', locales: ['en-US'] });
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
  return { posts };
}

describe('the first space', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('offers a deployment admin sample content or an empty space, and switches to the new one', async () => {
    me.role = 'admin';
    const { posts } = setup();

    fireEvent.click(await screen.findByRole('button', { name: 'Create a space' }));
    const dialog = await screen.findByRole('dialog', { name: 'New space' });
    const sample = within(dialog).getByRole('radio', { name: /Start with sample content/ });
    const empty = within(dialog).getByRole('radio', { name: /Empty space/ });
    expect((sample as HTMLInputElement).checked).toBe(true);
    expect((empty as HTMLInputElement).checked).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Marketing Site' },
    });
    // The id follows the name.
    expect((within(dialog).getByLabelText('Space ID') as HTMLInputElement).value).toBe(
      'marketing-site',
    );
    expect((within(dialog).getByLabelText('Default locale') as HTMLInputElement).value).toBe(
      'en-US',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create space' }));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          spaceId: 'marketing-site',
          name: 'Marketing Site',
          defaultLocale: 'en-US',
          starter: 'sample',
        },
      ]),
    );
    // The scope moves to the new space and the page itself renders.
    expect(await screen.findByText('The overview')).toBeTruthy();
  });

  it('creates an empty space when asked, and refuses an id the API would refuse', async () => {
    me.role = 'admin';
    const { posts } = setup();

    fireEvent.click(await screen.findByRole('button', { name: 'Create a space' }));
    const dialog = await screen.findByRole('dialog', { name: 'New space' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Blog' } });
    fireEvent.change(within(dialog).getByLabelText('Space ID'), { target: { value: 'my blog' } });
    expect(within(dialog).getByLabelText('Space ID').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create space' }));
    expect(posts).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText('Space ID'), { target: { value: 'blog' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Empty space/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create space' }));
    await waitFor(() =>
      expect(posts).toEqual([
        { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US', starter: 'empty' },
      ]),
    );
  });

  it('tells a member to ask a deployment admin, with nothing to create', async () => {
    me.role = 'member';
    setup();

    expect(await screen.findByRole('heading', { name: 'No spaces yet' })).toBeTruthy();
    expect(screen.getByText(/Ask a deployment admin to add you to one/)).toBeTruthy();
    expect(screen.queryByText(/the API/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create a space' })).toBeNull();
  });
});

describe('spaceIdFrom', () => {
  it('derives an id the API accepts from a name', () => {
    expect(spaceIdFrom('Marketing Site')).toBe('marketing-site');
    expect(spaceIdFrom('  Café & Co. ')).toBe('cafe-co');
    expect(spaceIdFrom('x'.repeat(80))).toHaveLength(64);
    expect(spaceIdFrom('🎉')).toBe('');
  });
});

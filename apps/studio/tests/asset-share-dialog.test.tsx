// @vitest-environment jsdom
import type { AssetShareLink } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkInput } from '~/cms/lib/management';

configure({ asyncUtilTimeout: 5000 });

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

const link = (over: Partial<AssetShareLink> = {}): AssetShareLink => ({
  id: 'l1',
  targetType: 'asset',
  targetId: 'a1',
  expiresAt: '2026-11-08T12:00:00.000Z',
  allowDownload: true,
  hasPassword: false,
  createdAt: '2026-11-01T12:00:00.000Z',
  url: 'https://media.example/s/s/main/l1/tok',
  ...over,
});

let links: AssetShareLink[] = [];
const client = {
  publishAsset: vi.fn(async (id: string): Promise<unknown> => ({ id, status: 'published' })),
  listShareLinks: vi.fn(async (_t: unknown) => links),
  createShareLink: vi.fn(async (input: ShareLinkInput) => {
    const made = link({
      id: 'l2',
      expiresAt: input.expiresAt,
      hasPassword: Boolean(input.password),
      allowDownload: input.allowDownload ?? true,
      url: 'https://media.example/s/s/main/l2/tok',
    });
    links = [made, ...links];
    return made;
  }),
  revokeShareLink: vi.fn(async (id: string) => {
    links = links.filter((l) => l.id !== id);
    return link({ id, revokedAt: '2026-11-01T12:00:00.000Z' });
  }),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { AssetShareDialog } = await import('~/cms/components/assets/AssetShareDialog');
const { ApiError } = await import('~/cms/lib/management');

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  links = [];
});

function renderDialog(
  props: {
    type?: 'asset' | 'collection';
    published?: boolean;
    archived?: boolean;
    name?: string;
    onPublished?: () => void;
  } = {},
) {
  const type = props.type ?? 'asset';
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <AssetShareDialog
          open
          onOpenChange={() => {}}
          target={{ type, id: type === 'asset' ? 'a1' : 'c1', name: props.name ?? 'hero.jpg' }}
          {...(type === 'asset' ? { published: props.published ?? true } : {})}
          {...(props.onPublished ? { onPublished: props.onPublished } : {})}
          {...(props.archived ? { archived: true } : {})}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('sharing an asset or a collection', () => {
  it('lists the links that still open, with what each allows', async () => {
    links = [link({ hasPassword: true, allowDownload: false })];
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Share “hero.jpg”' });
    expect(within(dialog).getByText(/Only published files are shared/)).toBeTruthy();
    const list = await within(dialog).findByRole('list', { name: 'Active links' });
    expect(within(list).getByText('https://media.example/s/s/main/l1/tok')).toBeTruthy();
    expect(within(list).getByText(/Expires in 7 days/)).toBeTruthy();
    expect(within(list).getByText('Password')).toBeTruthy();
    expect(within(list).getByText('View only')).toBeTruthy();
    expect(client.listShareLinks).toHaveBeenCalledWith({ targetType: 'asset', targetId: 'a1' });
  });

  it('makes a link from a preset, with a password and no downloads, and focuses its Copy', async () => {
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('radio', { name: '1 day' }));
    fireEvent.click(within(form).getByRole('switch', { name: 'Allow downloads' }));
    fireEvent.change(within(form).getByLabelText(/Password/), {
      target: { value: 'correct horse' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(client.createShareLink).toHaveBeenCalled());
    const sent = client.createShareLink.mock.calls[0]?.[0] as ShareLinkInput;
    expect(sent).toMatchObject({
      targetType: 'asset',
      targetId: 'a1',
      allowDownload: false,
      password: 'correct horse',
    });
    // A day from now, by the clock it was made on.
    expect(Date.parse(sent.expiresAt) - NOW).toBeGreaterThanOrEqual(24 * 3600_000);
    expect(Date.parse(sent.expiresAt) - NOW).toBeLessThan(24 * 3600_000 + 60_000);

    const copy = await screen.findByRole('button', { name: /Copy the link that expires/ });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    fireEvent.click(copy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://media.example/s/s/main/l2/tok'),
    );
    expect(await screen.findByText('Link copied')).toBeTruthy();
    // The password is never kept in the form once sent.
    expect((within(form).getByLabelText(/Password/) as HTMLInputElement).value).toBe('');
  });

  it('asks for a custom date before sending, and shows the API’s word on one out of range', async () => {
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Custom' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect(await within(form).findByText(/Choose the date and time/)).toBeTruthy();
    expect(client.createShareLink).not.toHaveBeenCalled();

    client.createShareLink.mockRejectedValueOnce(
      new ApiError(422, 'POST → 422', {
        error: {
          issues: [
            {
              field: 'expiresAt',
              message: 'A share link expires between 5 minutes and 90 days from now',
            },
          ],
        },
      }),
    );
    const when = within(form).getByLabelText('Expires at');
    fireEvent.change(when, { target: { value: '2027-06-01T09:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect(await within(form).findByText(/between 5 minutes and 90 days/)).toBeTruthy();
    expect(when.getAttribute('aria-invalid')).toBe('true');
    expect(client.createShareLink.mock.calls[0]?.[0]?.expiresAt).toBe(
      new Date('2027-06-01T09:00').toISOString(),
    );
  });

  it('names a password the API refused beside the field', async () => {
    client.createShareLink.mockRejectedValueOnce(
      new ApiError(422, 'POST → 422', {
        error: { issues: [{ field: 'password', message: 'A password is 8 to 256 characters' }] },
      }),
    );
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    const password = within(form).getByLabelText(/Password/);
    fireEvent.change(password, { target: { value: 'short' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect(await within(form).findByText('A password is 8 to 256 characters')).toBeTruthy();
    expect(password.getAttribute('aria-invalid')).toBe('true');
  });

  it('won’t make a link to an unpublished asset, and says why', async () => {
    links = [link()];
    renderDialog({ published: false });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Publish it to share it')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Create link' })).toBeNull();
    // A link made while it was published can still be revoked.
    expect(within(dialog).getByRole('button', { name: /Revoke the link/ })).toBeTruthy();
  });

  it('tells a role without content:publish why it can’t share, and offers no form', async () => {
    client.listShareLinks.mockRejectedValueOnce(new ApiError(403, 'GET → 403'));
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Your role can’t share')).toBeTruthy();
    expect(within(dialog).getByText(/content:publish/)).toBeTruthy();
    expect(within(dialog).queryByRole('form', { name: 'New share link' })).toBeNull();
  });

  it('says a refused create (the asset was unpublished meanwhile) in the server’s words', async () => {
    client.createShareLink.mockRejectedValueOnce(
      new ApiError(409, 'POST → 409', {
        error: { message: 'Only a published asset can be shared: publish it first' },
      }),
    );
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    const alert = (await within(form).findByText('The link wasn’t created')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(within(alert).getByText(/publish it first/)).toBeTruthy();
  });

  it('publishes an unpublished asset from the warning, then offers the form', async () => {
    const onPublished = vi.fn();
    renderDialog({ published: false, onPublished });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish asset' }));
    expect(await screen.findByRole('form', { name: 'New share link' })).toBeTruthy();
    expect(client.publishAsset).toHaveBeenCalledExactlyOnceWith('a1');
    expect(onPublished).toHaveBeenCalledOnce();
    expect(screen.queryByText('Publish it to share it')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: '7 days' })),
    );
  });

  it('keeps the warning when the publish is refused, saying why', async () => {
    client.publishAsset.mockRejectedValueOnce(new ApiError(409, 'Under embargo'));
    renderDialog({ published: false });
    const publish = await screen.findByRole('button', { name: 'Publish asset' });
    publish.focus();
    fireEvent.click(publish);
    await waitFor(() => expect(client.publishAsset).toHaveBeenCalledOnce());
    // In the dialog, in the server's words: a toast sits outside the modal.
    const alert = (await screen.findByText('It wasn’t published')).closest('[role="alert"]');
    expect(alert?.textContent).toContain('Under embargo');
    expect(screen.getByText('Publish it to share it')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New share link' })).toBeNull();
    // The button that asked keeps focus through the wait and the refusal.
    await waitFor(() => expect(document.activeElement).toBe(publish));
  });

  it('never says it wasn’t published when no answer came, nor on a refused retry', async () => {
    client.publishAsset
      .mockRejectedValueOnce(new ApiError(503, 'POST → 503'))
      .mockRejectedValueOnce(new ApiError(409, 'POST → 409'));
    renderDialog({ published: false });
    const publish = await screen.findByRole('button', { name: 'Publish asset' });
    fireEvent.click(publish);
    await screen.findByText(/didn’t confirm/);
    expect(screen.queryByText('It wasn’t published')).toBeNull();

    fireEvent.click(publish);
    await screen.findByText('This try was refused');
    expect(screen.queryByText('It wasn’t published')).toBeNull();
  });

  it('tells an archived asset to restore first, with nothing to press', async () => {
    renderDialog({ published: false, archived: true });
    expect(await screen.findByText('Restore it to share it')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish asset' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New share link' })).toBeNull();
  });

  it('never says the link wasn’t created when no answer came, nor on a refused retry', async () => {
    client.createShareLink
      .mockRejectedValueOnce(new ApiError(503, 'POST → 503'))
      .mockRejectedValueOnce(new ApiError(409, 'POST → 409'));
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    await within(form).findByText(/didn’t confirm/);
    expect(within(form).queryByText('The link wasn’t created')).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    await within(form).findByText('This try was refused');
    expect(within(form).queryByText('The link wasn’t created')).toBeNull();
  });

  it('revokes a link after asking in a modal over the dialog', async () => {
    links = [link()];
    renderDialog();
    const revoke = await screen.findByRole('button', { name: /Revoke the link/ });
    fireEvent.click(revoke);
    const confirm = await screen.findByRole('alertdialog', { name: /Revoke this link\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(client.revokeShareLink).toHaveBeenCalledWith('l1'));
    expect(await screen.findByText('No link opens it now.')).toBeTruthy();
  });

  it('shares a collection, saying its drafts stay off the page', async () => {
    renderDialog({ type: 'collection', name: 'Launch' });
    const dialog = await screen.findByRole('dialog', { name: 'Share “Launch”' });
    expect(within(dialog).getByText(/drafts in the collection stay off the page/)).toBeTruthy();
    const form = await within(dialog).findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(client.createShareLink.mock.calls[0]?.[0]).toMatchObject({
        targetType: 'collection',
        targetId: 'c1',
        allowDownload: true,
      }),
    );
    // The seven-day preset is the default.
    const sent = client.createShareLink.mock.calls[0]?.[0] as ShareLinkInput;
    expect(Math.round((Date.parse(sent.expiresAt) - NOW) / 86_400_000)).toBe(7);
    expect(sent.password).toBeUndefined();
  });

  it('hands focus back to what opened it when it closes', async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Share
          </button>
          <AssetShareDialog
            open={open}
            onOpenChange={setOpen}
            target={{ type: 'asset', id: 'a1', name: 'hero.jpg' }}
            published
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <Opener />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const share = screen.getByRole('button', { name: 'Share' });
    share.focus();
    fireEvent.click(share);
    const dialog = await screen.findByRole('dialog', { name: 'Share “hero.jpg”' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(share));
  });

  it('announces an expiry the API refused and ties it to the expiry choice', async () => {
    client.createShareLink.mockRejectedValueOnce(
      new ApiError(422, 'POST → 422', {
        error: {
          issues: [
            {
              field: 'expiresAt',
              message: 'A share link expires between 5 minutes and 90 days from now',
            },
          ],
        },
      }),
    );
    renderDialog();
    const form = await screen.findByRole('form', { name: 'New share link' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toMatch(/between 5 minutes and 90 days/);
    const choice = within(form).getByRole('radiogroup', { name: 'Expires after' });
    expect(choice.getAttribute('aria-describedby')).toBe(alert.id);
  });
});

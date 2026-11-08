// @vitest-environment jsdom
import type { ContentType } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJobSummary, ContentTypeDependents } from '~/cms/lib/management';

const client = {
  contentTypeDependents: vi.fn<(apiId: string) => Promise<ContentTypeDependents>>(),
  deleteContentType:
    vi.fn<
      (
        apiId: string,
        o: { purgeEntries?: boolean },
      ) => Promise<{ deleted: true } | { deleted: false; job: BulkJobSummary }>
    >(),
  cloneContentType:
    vi.fn<(apiId: string, to: { apiId: string; name: string }) => Promise<ContentType>>(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => fn(),
  }),
}));

const { DeleteContentTypeDialog, CloneContentTypeDialog } = await import(
  '~/cms/components/ContentTypeActions'
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const note = {
  apiId: 'note',
  name: 'Note',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [],
} as unknown as ContentType;

const free: ContentTypeDependents = {
  contentType: 'note',
  entries: { live: 0, trashed: 0 },
  linkedFrom: [],
  menus: [],
  redirects: [],
};

function renderDelete(onDeleted = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DeleteContentTypeDialog type={note} open onOpenChange={() => {}} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return onDeleted;
}

const deleteButton = () =>
  screen.getByRole('button', { name: /^Delete (content type|type and entries)$/ });

describe('deleting a content type from the admin', () => {
  it('waits for the API ID to be typed, then deletes', async () => {
    client.contentTypeDependents.mockResolvedValue(free);
    client.deleteContentType.mockResolvedValue({ deleted: true });
    const onDeleted = renderDelete();
    const confirm = await screen.findByLabelText(/to confirm/);
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    fireEvent.change(confirm, { target: { value: 'Note' } });
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    fireEvent.change(confirm, { target: { value: 'note' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(null));
    expect(client.deleteContentType).toHaveBeenCalledWith('note', { purgeEntries: false });
  });

  it('names what blocks it, and offers no confirm then', async () => {
    client.contentTypeDependents.mockResolvedValue({
      ...free,
      linkedFrom: [{ contentType: 'post', field: 'body.byline.who' }],
      menus: [{ id: 'm', handle: 'main' }],
      urlPattern: '/notes/{id}',
    });
    renderDelete();
    expect(await screen.findByText('post.body.byline.who links to it')).toBeTruthy();
    expect(screen.getByText('The menu “main” links its entries')).toBeTruthy();
    expect(screen.getByText(/URL pattern \/notes\/\{id\}/)).toBeTruthy();
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    // No disabled red button, no opt-in and no job explanation: what blocks it is the whole answer.
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy();
  });

  it('offers no opt-in while blocked, even with entries', async () => {
    client.contentTypeDependents.mockResolvedValue({
      ...free,
      entries: { live: 3, trashed: 1 },
      menus: [{ id: 'm', handle: 'main' }],
    });
    renderDelete();
    await screen.findByText('The menu “main” links its entries');
    expect(within(screen.getByRole('dialog')).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/A background job/)).toBeNull();
  });

  it('says which step is outstanding on the disabled button', async () => {
    client.contentTypeDependents.mockResolvedValue({ ...free, entries: { live: 3, trashed: 1 } });
    renderDelete();
    const confirm = await screen.findByLabelText(/to confirm/);
    const gate = () => document.getElementById('ct-delete-gate')?.textContent;
    expect(deleteButton().getAttribute('aria-describedby')).toBe('ct-delete-gate');
    expect(gate()).toBe('To delete it, tick “Delete its 4 entries too” and type note.');

    fireEvent.change(confirm, { target: { value: 'note' } });
    expect(gate()).toBe('To delete it, tick “Delete its 4 entries too”.');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    expect(gate()).toBeUndefined();
    expect(deleteButton().hasAttribute('disabled')).toBe(false);
  });

  it('moves focus from Keep it to the first field once the check lands', async () => {
    let answer: (d: typeof free) => void = () => {};
    client.contentTypeDependents.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderDelete();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' })),
    );
    answer({ ...free, entries: { live: 1, trashed: 0 } });
    const box = await within(screen.getByRole('dialog')).findByRole('checkbox');
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('leaves focus on Keep it when the check finds it blocked', async () => {
    client.contentTypeDependents.mockResolvedValue({
      ...free,
      menus: [{ id: 'm', handle: 'main' }],
    });
    renderDelete();
    await screen.findByText('The menu “main” links its entries');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' })),
    );
  });

  it('deletes the entries too only when asked to, as a job', async () => {
    client.contentTypeDependents.mockResolvedValue({ ...free, entries: { live: 3, trashed: 1 } });
    const job = { id: 'j1', action: 'content_type_delete', status: 'running' } as BulkJobSummary;
    client.deleteContentType.mockResolvedValue({ deleted: false, job });
    const onDeleted = renderDelete();
    fireEvent.change(await screen.findByLabelText(/to confirm/), { target: { value: 'note' } });
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    const box = within(screen.getByRole('dialog')).getByRole('checkbox');
    expect(document.getElementById(box.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Delete its 4 entries too (1 in the trash)',
    );
    fireEvent.click(box);
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(job));
    expect(client.deleteContentType).toHaveBeenCalledWith('note', { purgeEntries: true });
  });
});

describe('cloning a content type from the admin', () => {
  it('suggests a name and API ID, and sends what was typed', async () => {
    client.cloneContentType.mockResolvedValue({ ...note, apiId: 'memo', name: 'Memo' });
    const onCloned = vi.fn();
    render(
      <CloneContentTypeDialog source={note} open onOpenChange={() => {}} onCloned={onCloned} />,
    );
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Note copy');
    expect((screen.getByLabelText('API ID') as HTMLInputElement).value).toBe('noteCopy');
    fireEvent.change(name, { target: { value: 'Memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone content type' }));
    await waitFor(() => expect(onCloned).toHaveBeenCalled());
    expect(client.cloneContentType).toHaveBeenCalledWith('note', { apiId: 'memo', name: 'Memo' });
  });

  it('shows the API’s refusal', async () => {
    client.cloneContentType.mockRejectedValue(new Error('A content type "memo" already exists'));
    render(
      <CloneContentTypeDialog source={note} open onOpenChange={() => {}} onCloned={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clone content type' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A content type "memo" already exists');
    // The refusal is the API ID's: that field is marked and described by it.
    const apiId = screen.getByLabelText('API ID');
    expect(apiId.getAttribute('aria-invalid')).toBe('true');
    expect(apiId.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('marks the name, not the API ID, when only the name is missing', async () => {
    render(
      <CloneContentTypeDialog source={note} open onOpenChange={() => {}} onCloned={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone content type' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A name is required.');
    expect(screen.getByLabelText('API ID').getAttribute('aria-invalid')).toBeNull();
    expect(client.cloneContentType).not.toHaveBeenCalled();
  });
});

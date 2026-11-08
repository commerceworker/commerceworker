// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJobReport, BulkJobSummary } from '~/cms/lib/management';

const client = {
  getBulkJob: vi.fn<(id: string) => Promise<BulkJobSummary>>(),
  getBulkJobReport: vi.fn<(id: string) => Promise<BulkJobReport>>(),
  cancelBulkJob: vi.fn<(id: string) => Promise<BulkJobSummary>>(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 's', environment: 'main', locale: 'en-US' } }),
}));

const { useContentTypeDeleteJob, ContentTypeDeleteJobCard } = await import(
  '~/cms/components/ContentTypeDeleteJob'
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const job = (patch: Partial<BulkJobSummary> = {}): BulkJobSummary => ({
  id: 'j1',
  action: 'content_type_delete',
  status: 'running',
  totalItems: 2,
  totalChunks: 1,
  completedChunks: 0,
  succeeded: 0,
  failed: 0,
  config: { contentType: 'note' },
  ...patch,
});

/** The layout's hook and the overview's card, as the Content section wires them. */
function setup(onSettled = vi.fn()) {
  let api: ReturnType<typeof useContentTypeDeleteJob> | undefined;
  function Harness() {
    const deleteJob = useContentTypeDeleteJob(onSettled);
    api = deleteJob;
    return <ContentTypeDeleteJobCard job={deleteJob} />;
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  const start = (j: BulkJobSummary) => act(() => api?.start(j, { apiId: 'note', name: 'Note' }));
  return { start, onSettled };
}

describe('the content type delete job card', () => {
  it('waits for the type’s outcome after the entries are done, then reloads once', async () => {
    const { start, onSettled } = setup();
    // The job has finished its entries, but the type's own delete is still to come.
    client.getBulkJob.mockResolvedValueOnce(
      job({ status: 'completed', completedChunks: 1, succeeded: 2 }),
    );
    start(job());
    expect(await screen.findByText('Deleting the content type “Note”…')).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled();

    client.getBulkJob.mockResolvedValue(
      job({
        status: 'completed',
        completedChunks: 1,
        succeeded: 2,
        config: { contentType: 'note', typeDeletion: { deleted: true } },
      }),
    );
    expect(
      await screen.findByText('“Note” was deleted, with its entries', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Deleting the content type/)).toBeNull();
  });

  it('names the entries that kept the type, from the job’s report', async () => {
    const { start, onSettled } = setup();
    client.getBulkJobReport.mockResolvedValue({
      job: job(),
      chunks: [
        {
          chunkId: '0',
          status: 'completed',
          attempts: 1,
          itemCount: 2,
          failures: [{ id: 'e-linked', error: 'Linked from published entries' }],
        },
      ],
    });
    start(
      job({
        status: 'completed',
        completedChunks: 1,
        succeeded: 1,
        failed: 1,
        config: {
          contentType: 'note',
          typeDeletion: { deleted: false, reason: '1 entry could not be deleted' },
        },
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('“Note” was kept: 1 entry couldn’t be deleted');
    await waitFor(() => expect(alert.textContent).toContain('e-linked'));
    expect(alert.textContent).toContain('Linked from published entries');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal’s reason when no entry failed', async () => {
    const { start } = setup();
    start(
      job({
        status: 'completed',
        completedChunks: 1,
        succeeded: 2,
        config: {
          contentType: 'note',
          typeDeletion: { deleted: false, reason: 'other content types link to it: post.note' },
        },
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Its delete was refused: other content types link to it: post.note.',
    );
    expect(client.getBulkJobReport).not.toHaveBeenCalled();
  });

  it('stops the job through the bulk-job cancel', async () => {
    const { start } = setup();
    client.getBulkJob.mockResolvedValue(job());
    client.cancelBulkJob.mockResolvedValue(
      job({
        status: 'cancelled',
        config: {
          contentType: 'note',
          typeDeletion: { deleted: false, reason: 'the job was stopped' },
        },
      }),
    );
    start(job());
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop job' }));
    await waitFor(() => expect(client.cancelBulkJob).toHaveBeenCalledWith('j1'));
    expect((await screen.findByRole('alert')).textContent).toContain('The job was stopped');
  });
});

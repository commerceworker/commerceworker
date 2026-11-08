// @vitest-environment jsdom

import type { EntryChange } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuditLogFilters, AuditLogPage } from '~/cms/lib/management';

const listAuditLog =
  vi.fn<(q: AuditLogFilters & { limit?: number; cursor?: string }) => Promise<AuditLogPage>>();
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client: { listAuditLog }, conn: { space: 's1', environment: 'main' } }),
}));

const { AuditLog, auditLogFilters } = await import('~/cms/components/AuditLog');

const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `a${n}`,
  spaceId: 's1',
  actor: 'usr_ada',
  action: 'PUT /entries/:id',
  targetType: 'entry',
  targetId: `e${n}`,
  status: 200,
  at: '2026-01-01T00:00:00.000Z',
  ...over,
});

function show() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuditLog />
    </QueryClientProvider>,
  );
}

const lastQuery = () => listAuditLog.mock.calls.at(-1)?.[0];

beforeEach(() => {
  listAuditLog.mockReset();
  listAuditLog.mockImplementation(async () => ({ items: [row(1), row(2)] }));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the audit log screen', () => {
  it('filters by what is typed, from the first page', async () => {
    show();
    await screen.findByRole('button', { name: 'Filter by target e1' });
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: '  usr_grace ' } });
    fireEvent.change(screen.getByLabelText('Target type'), { target: { value: 'release' } });
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ actor: 'usr_grace', targetType: 'release' }),
    );
    expect(lastQuery()?.cursor).toBeUndefined();
  });

  it('filters by a row’s value when it is pressed', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Filter by target e2' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ targetId: 'e2', targetType: 'entry' }));
    expect(screen.getByLabelText<HTMLInputElement>('Target ID').value).toBe('e2');
  });

  it('sends a picked day as the reader’s whole day', () => {
    const q = auditLogFilters({
      actor: '',
      action: '',
      targetType: '',
      targetId: '',
      from: '2026-03-02',
      to: '2026-03-02',
    });
    expect(q.from).toBe(new Date(2026, 2, 2, 0, 0, 0, 0).toISOString());
    expect(q.to).toBe(new Date(2026, 2, 2, 23, 59, 59, 999).toISOString());
  });

  it('says so at the fields when To is before From, and never asks the API', async () => {
    show();
    await screen.findByRole('button', { name: 'Filter by target e1' });
    const calls = () => listAuditLog.mock.calls.length;
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-02' } });
    await waitFor(() => expect(lastQuery()?.from).toBeDefined());
    const before = calls();
    // Past the filter bar's debounce on a fake clock: nothing should follow it.
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-01' } });
    expect(screen.getByRole('alert').textContent).toBe('To is before From.');
    expect(screen.getByLabelText('To').getAttribute('aria-invalid')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    expect(calls()).toBe(before);
    expect(lastQuery()?.to).toBeUndefined();
  });

  it('appends the next page with its cursor and hands focus to the first row it brought', async () => {
    listAuditLog.mockImplementation(async (q) =>
      q.cursor === 'c2'
        ? { items: [row(3), row(4)] }
        : { items: [row(1), row(2)], nextCursor: 'c2' },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('button', { name: 'Filter by target e4' });
    expect(lastQuery()?.cursor).toBe('c2');
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows.filter((r) => r.textContent?.includes('usr_ada'))).toHaveLength(4);
    await waitFor(() => {
      const third = screen.getAllByRole('button', { name: 'Filter by actor usr_ada' })[2];
      expect(document.activeElement).toBe(third);
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps filters on the next page', async () => {
    listAuditLog.mockImplementation(async (q) =>
      q.cursor ? { items: [row(3)] } : { items: [row(1)], nextCursor: 'c2' },
    );
    show();
    await screen.findByRole('button', { name: 'Load more' });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'POST /releases' } });
    await waitFor(() => expect(lastQuery()?.action).toBe('POST /releases'));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Load more' }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(lastQuery()?.cursor).toBe('c2'));
    expect(lastQuery()?.action).toBe('POST /releases');
  });

  it('keeps the headers when filters miss, with the way out in the row', async () => {
    listAuditLog.mockImplementation(async (q) => (q.actor ? { items: [] } : { items: [row(1)] }));
    show();
    await screen.findByRole('button', { name: 'Filter by target e1' });
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'nobody' } });
    await screen.findByText('No audit entries match these filters.');
    expect(screen.getByRole('columnheader', { name: 'Actor' })).toBeTruthy();

    const clears = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clears.at(-1) as HTMLElement);
    await screen.findByRole('button', { name: 'Filter by target e1' });
    expect(screen.getByLabelText<HTMLInputElement>('Actor').value).toBe('');
  });

  it('moves focus to the first field when Clear filters goes', async () => {
    show();
    await screen.findByRole('button', { name: 'Filter by target e1' });
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Actor'));
  });

  it('survives a year too long to be a date, and asks without it', async () => {
    expect(
      auditLogFilters({
        actor: '',
        action: '',
        targetType: '',
        targetId: '',
        from: '20261-03-02',
        to: '20261-03-02',
      }),
    ).toMatchObject({ from: undefined, to: undefined });
  });

  it('says a failed read is one, with Retry, never an empty log', async () => {
    listAuditLog.mockRejectedValueOnce(new Error('D1 is down'));
    show();
    await screen.findByText('The audit log didn’t load');
    expect(screen.queryByText('No audit entries yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Filter by target e1' });
  });

  describe('what a row changed', () => {
    const change = (over: Partial<EntryChange> = {}): EntryChange => ({
      entryId: 'e1',
      contentType: 'article',
      kind: 'updated',
      version: 3,
      paths: ['fields.title', 'fields.hero.alt', 'fields.sections[].heading'],
      locales: ['de', 'en-US'],
      ...over,
    });
    const showing = async (detail: AuditEntry['detail']) => {
      listAuditLog.mockResolvedValue({ items: [row(1, { detail })] });
      show();
      await screen.findByRole('button', { name: 'Filter by target e1' });
    };

    it('reads the paths and the locales in the model’s words, whole in the title', async () => {
      await showing({ entries: [change()] });
      const paths = screen.getByText('title, hero.alt, sections[].heading');
      expect(paths.closest('p')?.title).toBe('title, hero.alt, sections[].heading in de, en-US');
      expect(screen.getByText('de, en-US')).toBeTruthy();
    });

    it('has a column for it, with a dash on a row that doesn’t say', async () => {
      listAuditLog.mockResolvedValue({ items: [row(1)] });
      show();
      await screen.findByRole('button', { name: 'Filter by target e1' });
      expect(screen.getByRole('columnheader', { name: 'Changed' })).toBeTruthy();
      expect(screen.getByText('—', { selector: 'span' })).toBeTruthy();
    });

    it('draws its skeleton with a cell for every column', async () => {
      listAuditLog.mockImplementation(() => new Promise(() => {}));
      show();
      const skeleton = document.querySelector('tbody tr[aria-hidden="true"]');
      expect(skeleton?.querySelectorAll('td')).toHaveLength(6);
    });

    it('shortens a long list of locales to a count, keeping them in the title', async () => {
      await showing({ entries: [change({ locales: ['de', 'en-US', 'fr'] })] });
      expect(screen.getByText('3 locales')).toBeTruthy();
      expect(screen.getByText(/^title/).closest('p')?.title).toContain('de, en-US, fr');
    });

    it('says a cut-short row is one, in words that cover other entries too', async () => {
      await showing({ entries: [change()], truncated: true });
      expect(screen.getByText('Other changes not listed')).toBeTruthy();
    });

    it('never says nothing changed on a row that was cut short', async () => {
      await showing({ entries: [change({ paths: [], locales: [] })], truncated: true });
      expect(screen.queryByText('No field changed')).toBeNull();
      expect(screen.getByText('Other changes not listed')).toBeTruthy();
    });

    it('says a row whose change couldn’t be read wasn’t recorded', async () => {
      await showing({ entries: [], truncated: true });
      expect(screen.getByText('Not recorded')).toBeTruthy();
    });

    it('says a save that changed nothing changed nothing', async () => {
      await showing({ entries: [change({ paths: [], locales: [] })] });
      expect(screen.getByText('No field changed')).toBeTruthy();
    });

    it('doesn’t call a create with no fields a save', async () => {
      await showing({ entries: [change({ kind: 'created', paths: [], locales: [] })] });
      expect(screen.getByText('Created with no fields')).toBeTruthy();
    });

    it('counts a field the type no longer declares', async () => {
      await showing({ entries: [change({ paths: [], locales: [], undeclaredFields: 1 })] });
      expect(screen.getByText('1 field no longer in the model')).toBeTruthy();
      expect(screen.queryByText('No field changed')).toBeNull();
    });

    it('counts the entries of a row that changed several', async () => {
      await showing({ entries: [change(), change({ entryId: 'e2' })] });
      expect(screen.getByText('2 entries')).toBeTruthy();
      cleanup();
      await showing({ entries: [change(), change({ entryId: 'e2' })], truncated: true });
      expect(screen.getByText('More than 2 entries')).toBeTruthy();
    });
  });

  it('reads out what the filters found', async () => {
    show();
    await screen.findByRole('button', { name: 'Filter by target e1' });
    expect(screen.getByRole('status').textContent).toBe('2 audit entries shown');
  });

  it('says the log is empty when nothing has happened yet', async () => {
    listAuditLog.mockImplementation(async () => ({ items: [] }));
    show();
    await screen.findByText('No audit entries yet.');
    expect(screen.queryByRole('table')).toBeNull();
  });
});

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

// The TanStack cache scoping isn't under test here (see connected-apps.test.tsx).
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

// The deliveries sheet reads the client from context; here it is the test's fake.
let contextClient: unknown;
vi.mock('~/cms/lib/client-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useClient: () => ({ client: contextClient }),
}));

const { Webhooks } = await import('~/cms/components/Settings');
const { WebhookDeliveriesSheet } = await import('~/cms/components/WebhookDeliveriesSheet');
const { WebhookDialog } = await import('~/cms/components/WebhookDialog');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;
type WebhookSummary = import('~/cms/lib/management').WebhookSummary;
type WebhookDeliveryRecord = import('~/cms/lib/management').WebhookDeliveryRecord;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const scoped: WebhookSummary = {
  id: 'w1',
  url: 'https://hooks.example.com/staging',
  topics: ['*'],
  active: true,
  environmentId: 'staging',
};
const everywhere: WebhookSummary = {
  id: 'w2',
  url: 'https://hooks.example.com/all',
  topics: ['entry.published'],
  active: true,
  environmentId: null,
};

function fakeClient(hooks: WebhookSummary[]) {
  return {
    listWebhooks: vi.fn(async () => hooks),
    createWebhook: vi.fn(async (input: { url: string }) => ({ ...scoped, url: input.url })),
    updateWebhook: vi.fn(async () => scoped),
    deleteWebhook: vi.fn(async () => {}),
    sendWebhookTest: vi.fn(async (id: string) => ({
      webhookId: id,
      eventId: 'evt-test',
      eventType: 'webhook.test',
    })),
  };
}

const renderWebhooks = (client: ReturnType<typeof fakeClient>) =>
  render(
    <ToastProvider>
      <Webhooks client={client as unknown as ManagementClient} />
    </ToastProvider>,
  );

describe('Settings → Webhooks', () => {
  it("shows each hook's environments: its own, or all of them", async () => {
    renderWebhooks(fakeClient([scoped, everywhere]));
    const scopedRow = (await screen.findByText(scoped.url)).closest('li') as HTMLElement;
    expect(within(scopedRow).getByText('staging')).toBeTruthy();
    const wideRow = screen.getByText(everywhere.url).closest('li') as HTMLElement;
    expect(within(wideRow).getByText('All environments')).toBeTruthy();
  });

  it('finds hooks by address and status, and a miss says how to get them back', async () => {
    const paused = {
      ...everywhere,
      id: 'w3',
      url: 'https://hooks.example.com/paused',
      active: false,
    };
    renderWebhooks(fakeClient([scoped, paused]));
    await screen.findByText(scoped.url);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search webhooks' }), {
      target: { value: 'STAGING' },
    });
    expect(screen.getByText(scoped.url)).toBeTruthy();
    expect(screen.queryByText(paused.url)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Paused' }));
    expect(screen.queryByRole('list', { name: 'Webhooks' })).toBeNull();
    expect(screen.getByText(/No webhooks match/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText(scoped.url)).toBeTruthy();
    expect(screen.getByText(paused.url)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps Pause, Edit and Delete behind ⋯, and Delete still asks first', async () => {
    const client = fakeClient([scoped]);
    renderWebhooks(client);
    const more = await screen.findByRole('button', { name: `More actions for ${scoped.url}` });
    const open = () => fireEvent.pointerDown(more, { button: 0, ctrlKey: false });

    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    await waitFor(() =>
      expect(client.updateWebhook).toHaveBeenCalledWith(scoped.id, { active: false }),
    );

    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Delete webhook?' });
    expect(client.deleteWebhook).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteWebhook).toHaveBeenCalledWith(scoped.id));
  });

  it('creates a hook for the current environment unless every environment is ticked', async () => {
    const client = fakeClient([]);
    renderWebhooks(client);
    await screen.findByText('No webhooks yet.');
    const add = (url: string) => {
      fireEvent.change(screen.getByPlaceholderText('https://example.com/hooks/cms'), {
        target: { value: url },
      });
      fireEvent.change(screen.getByPlaceholderText('Signing secret'), {
        target: { value: 'shh' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
    };

    add('https://hooks.example.com/one');
    await waitFor(() => expect(client.createWebhook).toHaveBeenCalledTimes(1));
    // Left out, not false: the API scopes it to the environment (or, under an alias, the space).
    expect(client.createWebhook.mock.calls[0]?.[0]).not.toHaveProperty('allEnvironments');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Send events from every environment' }));
    add('https://hooks.example.com/two');
    await waitFor(() => expect(client.createWebhook).toHaveBeenCalledTimes(2));
    expect(client.createWebhook.mock.calls[1]?.[0]).toMatchObject({ allEnvironments: true });
  });
});

describe('Settings → Webhooks: tests', () => {
  it('queues a test for the one webhook, once, and opens its log waiting for it', async () => {
    const client = fakeClient([scoped, everywhere]);
    let release: () => void = () => {};
    client.sendWebhookTest.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ webhookId: id, eventId: 'evt-test', eventType: 'webhook.test' });
        }),
    );
    contextClient = { webhookDeliveries: vi.fn(async () => []) };
    renderWebhooks(client);
    const button = await screen.findByRole('button', { name: `Send test to ${everywhere.url}` });
    fireEvent.click(button);
    // Busy while it queues: a second press can't queue a second test.
    const busy = screen.getByRole('button', { name: `Sending test to ${everywhere.url}` });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    release();
    await waitFor(() => expect(client.sendWebhookTest).toHaveBeenCalledTimes(1));
    expect(client.sendWebhookTest).toHaveBeenCalledWith(everywhere.id);
    expect(await screen.findByText('Waiting for the engine to send it…')).toBeTruthy();
  });
});

describe('Webhook deliveries sheet', () => {
  const original = {
    id: 7,
    webhookId: scoped.id,
    eventId: 'evt-1',
    eventType: 'entry.published',
    status: 'failed' as const,
    statusCode: 500,
    attempts: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const resent = { ...original, id: 8, status: 'success' as const, attempts: 1, resendOf: 7 };
  const open = (pollMs = 5) =>
    render(
      <ToastProvider>
        <WebhookDeliveriesSheet webhook={scoped} open onOpenChange={() => {}} pollMs={pollMs} />
      </ToastProvider>,
    );

  it('resends one and reads the log again until the new attempt is there', async () => {
    let log: WebhookDeliveryRecord[] = [original];
    const client = {
      webhookDeliveries: vi.fn(async () => log),
      resendWebhookDelivery: vi.fn(async () => {
        // The engine sends it a moment later.
        setTimeout(() => {
          log = [resent, original];
        }, 12);
        return {
          webhookId: scoped.id,
          eventId: 'evt-1',
          eventType: 'entry.published',
          resendOf: 7,
        };
      }),
    };
    contextClient = client;
    open();
    expect(await screen.findByText('entry.published')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resend delivery #7' }));
    await waitFor(() =>
      expect(client.resendWebhookDelivery).toHaveBeenCalledWith(scoped.id, original.id),
    );
    // No Refresh pressed: the log is read again until the resend shows, naming the one it repeats.
    expect(await screen.findByText(/#8, resend of #7/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText('Waiting for the engine to send it…')).toBeNull(),
    );
  });

  it('keeps the rows on screen while it reloads', async () => {
    let finish: (d: WebhookDeliveryRecord[]) => void = () => {};
    const client = {
      webhookDeliveries: vi
        .fn()
        .mockResolvedValueOnce([original])
        .mockImplementationOnce(() => new Promise((r) => (finish = r))),
    };
    contextClient = client;
    open();
    await screen.findByText('entry.published');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Deliveries' }).getAttribute('aria-busy')).toBe(
        'true',
      ),
    );
    expect(screen.getByText('entry.published')).toBeTruthy();
    finish([resent, original]);
    expect(await screen.findByText(/resend of #7/)).toBeTruthy();
  });

  it('shows a failed load as an error with Retry, not as an empty log', async () => {
    const client = {
      webhookDeliveries: vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([original]),
    };
    contextClient = client;
    open();
    expect(await screen.findByText('The delivery log didn’t load')).toBeTruthy();
    expect(screen.queryByText('No deliveries yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('entry.published')).toBeTruthy();
    expect(screen.queryByText('The delivery log didn’t load')).toBeNull();
  });

  it('reports a resend the api refuses (its event is past retention)', async () => {
    contextClient = {
      webhookDeliveries: vi.fn(async () => [original]),
      resendWebhookDelivery: vi.fn(async () => {
        throw new Error(
          "Delivery 7's event is past the event retention, so it can't be sent again",
        );
      }),
    };
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Resend delivery #7' }));
    expect(await screen.findByText(/past the event retention/)).toBeTruthy();
  });
});

describe('Edit webhook dialog', () => {
  const open = (webhook: WebhookSummary) => {
    const onSave = vi.fn(async (_changes: Record<string, unknown>) => {});
    render(<WebhookDialog open onOpenChange={() => {}} webhook={webhook} onSave={onSave} />);
    return onSave;
  };
  const box = () => screen.getByRole('checkbox', { name: 'Send events from every environment' });

  it('reflects the scope, and sends allEnvironments only when it changes', async () => {
    const onSave = open(scoped);
    expect(box().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('allEnvironments');

    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ allEnvironments: true });
  });

  it('scopes a space-wide hook to this environment when unticked', async () => {
    const onSave = open(everywhere);
    expect(box().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ allEnvironments: false });
  });
});

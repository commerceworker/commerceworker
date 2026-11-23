import type { Principal } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

let me: Principal = {
  kind: 'user',
  id: 'usr_1',
  name: 'Ann',
  email: 'ann@example.com',
  role: 'admin',
};
const ORDER = ['viewer', 'operator', 'admin'];
const requireUser = vi.fn(async (_r: Request, role = 'viewer') => {
  if (ORDER.indexOf(me.role) < ORDER.indexOf(role))
    throw new Response('Forbidden', { status: 403 });
  return me;
});
const stepUp = vi.fn(async (): Promise<string | null> => null);
vi.mock('~/lib/auth.server', () => ({
  requireUser,
  stepUp,
  stepUpMethod: vi.fn(async () => 'code'),
}));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit }));

const sub = {
  id: 'whs_1',
  url: 'https://erp.example.com/hooks?token=receivers-own',
  events: ['*'],
  active: true,
  createdAt: 1,
  previousExpiresAt: null,
};
const store = {
  createSubscription: vi.fn(async () => ({ subscription: sub, secret: 'whsec_new' })),
  rotateSubscription: vi.fn(async (id: string) =>
    id === sub.id ? { subscription: sub, secret: 'whsec_rotated' } : null,
  ),
  listSubscriptions: vi.fn(async () => [sub]),
  listDeliveries: vi.fn(async () => [
    {
      id: 'whd_1',
      subscriptionId: sub.id,
      orderId: 'ord_1',
      event: 'order.paid',
      payload: { data: { contact: { email: 'buyer@example.com' } } },
      status: 'failed',
      attempts: 32,
      responseStatus: 503,
      lastError: 'HTTP 503',
      createdAt: 1,
      deliveredAt: null,
    },
  ]),
};
vi.mock('~/lib/webhooks.server', async (actual) => ({
  ...(await actual<typeof import('~/lib/webhooks.server')>()),
  ...store,
}));

const route = await import('~/routes/webhooks');

const post = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return new Request('https://app.test/webhooks', { method: 'POST', body: f });
};
const call = (fields: Record<string, string | string[]>) =>
  route.action({ request: post(fields), params: {}, context: {} } as never);
const load = () =>
  route.loader({
    request: new Request('https://app.test/webhooks'),
    params: {},
    context: {},
  } as never);
/** What a `data()` result carries, or the plain object. */
const body = (r: unknown) => ((r as { data?: unknown }).data ?? r) as Record<string, unknown>;
const init = (r: unknown) => (r as { init?: ResponseInit | null }).init;

beforeEach(() => {
  me = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'admin' };
  vi.clearAllMocks();
});

describe('the Webhooks screen', () => {
  it('refuses anyone below Admin, reading and changing alike', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      me = { ...me, role };
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(
        call({ intent: 'create', url: 'https://erp.example.com/hooks', all: 'on' }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(store.createSubscription).not.toHaveBeenCalled();
  });

  it('never sends a delivery’s payload to the browser', async () => {
    const d = await load();
    expect(d.deliveries).toHaveLength(1);
    expect(d.deliveries[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(d)).not.toContain('buyer@example.com');
  });

  it('adds a subscription after a step-up, returns its secret once and never stored', async () => {
    const r = await call({
      intent: 'create',
      url: 'https://erp.example.com/hooks?token=receivers-own',
      events: ['order.paid', 'order.shipped'],
      code: '123456',
    });
    expect(stepUp).toHaveBeenCalledWith(expect.any(Request), me, { code: '123456', password: '' });
    expect(store.createSubscription).toHaveBeenCalledWith({
      url: 'https://erp.example.com/hooks?token=receivers-own',
      events: ['order.paid', 'order.shipped'],
    });
    expect(body(r).secret).toMatchObject({ value: 'whsec_new' });
    expect(new Headers(init(r)?.headers).get('cache-control')).toBe('private, no-store');
    // The audit names the address without its query, and never the secret.
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'webhook.subscribed', {
      actor: me,
      target: 'https://erp.example.com/hooks',
      detail: { id: 'whs_1', events: ['order.paid', 'order.shipped'], via: 'app' },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('whsec_');
  });

  it('checks the address before asking for a code, so a typo spends none', async () => {
    const r = await call({ intent: 'create', url: 'https://10.0.0.5/hooks', all: 'on' });
    expect(init(r)?.status).toBe(400);
    expect(String(body(r).error)).toContain('public host name');
    const none = await call({ intent: 'create', url: 'https://erp.example.com/hooks' });
    expect(body(none).error).toBe('Choose the events to send, or all of them.');
    expect(stepUp).not.toHaveBeenCalled();
    expect(store.createSubscription).not.toHaveBeenCalled();
  });

  it('refuses a failed step-up, audits it and changes nothing', async () => {
    stepUp.mockResolvedValueOnce('Enter a current code from your authenticator app.');
    const r = await call({ intent: 'rotate', id: 'whs_1', code: '000000' });
    expect(init(r)?.status).toBe(403);
    expect(store.rotateSubscription).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.step_up_failed', {
      actor: me,
      target: null,
      detail: {
        intent: 'webhook.rotate',
        error: 'Enter a current code from your authenticator app.',
      },
    });
  });

  it('rotates a secret, and answers an unknown subscription with 404', async () => {
    const r = await call({ intent: 'rotate', id: 'whs_1', code: '123456' });
    expect(body(r).secret).toMatchObject({ value: 'whsec_rotated', label: 'New signing secret' });
    expect(new Headers(init(r)?.headers).get('cache-control')).toBe('private, no-store');
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'webhook.rotated', {
      actor: me,
      target: 'https://erp.example.com/hooks',
      detail: { id: 'whs_1', via: 'app' },
    });
    const missing = await call({ intent: 'rotate', id: 'whs_gone', code: '123456' });
    expect(init(missing)?.status).toBe(404);
  });

  it('asks no step-up where nobody signs in yet', async () => {
    me = { kind: 'open', id: 'open', name: 'Open', role: 'admin' } as Principal;
    await call({ intent: 'create', url: 'https://erp.example.com/hooks', all: 'on' });
    expect(stepUp).not.toHaveBeenCalled();
    expect(store.createSubscription).toHaveBeenCalled();
  });

  it('refuses anything else the form might post', async () => {
    const r = await call({ intent: 'delete', id: 'whs_1' });
    expect(init(r)?.status).toBe(400);
  });
});

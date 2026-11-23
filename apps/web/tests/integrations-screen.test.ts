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
vi.mock('~/lib/audit.server', () => ({ audit, actorName: (p: Principal) => p.email ?? p.name }));
vi.mock('~/lib/orders.server', () => ({
  publishedFlows: vi.fn(async () => [{ id: 'flw_b2b', name: 'B2B order' }]),
}));

const view = (over: Record<string, unknown> = {}) => ({
  id: 'int_1',
  name: 'Payments',
  events: ['payment.received'],
  startOrders: false,
  flows: [],
  channel: null,
  createdAt: 1,
  createdBy: 'ann@example.com',
  lastUsedAt: null,
  revokedAt: null,
  previousExpiresAt: null,
  ...over,
});
const store = {
  listIntegrations: vi.fn(async () => [
    view({ id: 'int_old', revokedAt: 5, createdAt: 9 }),
    view({ id: 'int_live', createdAt: 2 }),
  ]),
  createIntegration: vi.fn(async (input: Record<string, unknown>) => ({
    integration: view({ ...input, id: 'int_new' }),
    secret: 'whsec_new',
  })),
  rotateIntegration: vi.fn(async (id: string) =>
    id === 'int_1' ? { integration: view(), secret: 'whsec_rotated' } : null,
  ),
};
vi.mock('~/lib/integrations.server', () => store);

const route = await import('~/routes/integrations');

const post = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return new Request('https://app.test/integrations', { method: 'POST', body: f });
};
const call = (fields: Record<string, string | string[]>) =>
  route.action({ request: post(fields), params: {}, context: {} } as never);
const body = (r: unknown) => ((r as { data?: unknown }).data ?? r) as Record<string, unknown>;
const init = (r: unknown) => (r as { init?: ResponseInit | null }).init;

beforeEach(() => {
  me = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'admin' };
  vi.clearAllMocks();
});

describe('the Integrations screen', () => {
  it('refuses anyone below Admin, reading and changing alike', async () => {
    me = { ...me, role: 'operator' };
    await expect(
      route.loader({
        request: new Request('https://app.test/integrations'),
        params: {},
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call({ intent: 'create', name: 'X', anyEvent: 'on' })).rejects.toMatchObject({
      status: 403,
    });
    expect(store.createIntegration).not.toHaveBeenCalled();
  });

  it('lists live integrations before revoked ones', async () => {
    const d = await route.loader({
      request: new Request('https://app.test/integrations'),
      params: {},
      context: {},
    } as never);
    expect(d.integrations.map((i) => i.id)).toEqual(['int_live', 'int_old']);
  });

  it('adds one with the scope chosen, after a step-up, returning its secret once', async () => {
    const r = await call({
      intent: 'create',
      name: ' Partner ERP ',
      events: ['payment.received'],
      otherEvents: 'carrier.exception, payment.received  invoice.disputed',
      startOrders: 'on',
      flows: ['flw_b2b'],
      channel: 'edi',
      code: '123456',
    });
    expect(stepUp).toHaveBeenCalled();
    expect(store.createIntegration).toHaveBeenCalledWith(
      {
        name: 'Partner ERP',
        events: ['payment.received', 'carrier.exception', 'invoice.disputed'],
        startOrders: true,
        flows: ['flw_b2b'],
        channel: 'edi',
      },
      'ann@example.com',
    );
    expect(body(r).secret).toMatchObject({ value: 'whsec_new' });
    expect(new Headers(init(r)?.headers).get('cache-control')).toBe('private, no-store');
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'integration.created', {
      actor: me,
      target: 'Partner ERP',
      detail: { id: 'int_new', via: 'app' },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('whsec_');
  });

  it('names no flows for one that starts no orders, whatever was ticked', async () => {
    await call({ intent: 'create', name: 'Pay', anyEvent: 'on', anyFlow: 'on' });
    expect(store.createIntegration).toHaveBeenCalledWith(
      { name: 'Pay', events: ['*'], startOrders: false, flows: [], channel: null },
      'ann@example.com',
    );
  });

  it('refuses one that may do nothing, before asking for a code', async () => {
    const r = await call({ intent: 'create', name: 'Idle' });
    expect(init(r)?.status).toBe(400);
    expect(body(r).error).toBe('Choose the events it may send, or let it start orders.');
    const nameless = await call({ intent: 'create', name: '  ', anyEvent: 'on' });
    expect(body(nameless).error).toContain('Give it a name');
    expect(stepUp).not.toHaveBeenCalled();
    expect(store.createIntegration).not.toHaveBeenCalled();
  });

  it('refuses a failed step-up, audits it and changes nothing', async () => {
    stepUp.mockResolvedValueOnce('Enter a current code from your authenticator app.');
    const r = await call({ intent: 'rotate', id: 'int_1', code: '000000' });
    expect(init(r)?.status).toBe(403);
    expect(store.rotateIntegration).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.step_up_failed', {
      actor: me,
      target: null,
      detail: {
        intent: 'integration.rotate',
        error: 'Enter a current code from your authenticator app.',
      },
    });
  });

  it('rotates a live one, and answers an unknown or revoked one with 404', async () => {
    const r = await call({ intent: 'rotate', id: 'int_1', code: '123456' });
    expect(body(r).secret).toMatchObject({ value: 'whsec_rotated' });
    expect(new Headers(init(r)?.headers).get('cache-control')).toBe('private, no-store');
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'integration.rotated', {
      actor: me,
      target: 'Payments',
      detail: { id: 'int_1', via: 'app' },
    });
    expect(init(await call({ intent: 'rotate', id: 'int_gone', code: '1' }))?.status).toBe(404);
  });
});

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
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: vi.fn(async () => []) }));

const round = (over: Record<string, unknown> = {}) => ({
  ok: true,
  done: true,
  orders: 100,
  customers: 0,
  documents: 1,
  messages: 2,
  inboundEmails: 0,
  carts: 0,
  taxCertificates: 0,
  addresses: 0,
  companyMembers: 0,
  purchaseOrders: 0,
  quotes: 0,
  shopperSignIns: 0,
  shopperSessions: 0,
  ucpLinks: 0,
  teamMember: false,
  ...over,
});
const engine = {
  eraseDataSubject: vi.fn(),
  exportDataSubject: vi.fn(async (email: string) => ({ email, orders: [{}], customers: [] })),
};
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));

const page = await import('~/routes/privacy');
const exporter = await import('~/routes/privacy-export');

const post = (url: string, fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return new Request(url, { method: 'POST', body: f });
};
const erase = (fields: Record<string, string>) =>
  page.action({
    request: post('https://app.test/privacy', fields),
    params: {},
    context: {},
  } as never);
const body = (r: unknown) => (r as { data: Record<string, unknown> }).data;
const init = (r: unknown) => (r as { init: ResponseInit }).init;
const EMAIL = 'Person@Example.com';

beforeEach(() => {
  me = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'admin' };
  vi.clearAllMocks();
});

describe('privacy requests from the admin', () => {
  it('refuses anyone below Admin, to read, export or erase', async () => {
    me = { ...me, role: 'operator' };
    await expect(
      page.loader({
        request: new Request('https://app.test/privacy'),
        params: {},
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(erase({ email: EMAIL, confirm: EMAIL })).rejects.toMatchObject({ status: 403 });
    await expect(
      exporter.action({
        request: post('https://app.test/privacy/export', { email: EMAIL }),
        params: {},
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(engine.eraseDataSubject).not.toHaveBeenCalled();
    expect(engine.exportDataSubject).not.toHaveBeenCalled();
  });

  it('erases nothing until the address is typed again, before asking for a code', async () => {
    const r = await erase({ email: EMAIL, confirm: 'someone@else.com', code: '123456' });
    expect(init(r).status).toBe(400);
    expect(body(r)).toMatchObject({ kind: 'error' });
    expect(stepUp).not.toHaveBeenCalled();
    expect(engine.eraseDataSubject).not.toHaveBeenCalled();
  });

  it('refuses a failed step-up, audits it and erases nothing', async () => {
    stepUp.mockResolvedValueOnce('Enter a current code from your authenticator app.');
    const r = await erase({ email: EMAIL, confirm: 'person@example.com', code: '000000' });
    expect(init(r).status).toBe(403);
    expect(engine.eraseDataSubject).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.step_up_failed', {
      actor: me,
      target: null,
      detail: {
        intent: 'personal_data.erase',
        error: 'Enter a current code from your authenticator app.',
      },
    });
  });

  it('erases round after round until done, auditing each by a hash, never the address', async () => {
    engine.eraseDataSubject
      .mockResolvedValueOnce(round({ done: false }))
      .mockResolvedValueOnce(round({ done: true, orders: 3, customers: 1, teamMember: true }));
    const r = await erase({ email: EMAIL, confirm: 'person@example.com', code: '123456' });
    expect(engine.eraseDataSubject).toHaveBeenCalledTimes(2);
    expect(body(r)).toMatchObject({
      kind: 'erased',
      erased: { done: true, teamMember: true, counts: { orders: 103, customers: 1, messages: 4 } },
    });
    expect(new Headers(init(r).headers).get('cache-control')).toBe('private, no-store');
    const erased = audit.mock.calls.filter((c) => c[1] === 'personal_data.erased');
    expect(erased).toHaveLength(2);
    expect(erased[0]![2].target).toMatch(/^subject:[0-9a-f]{16}$/);
    expect(JSON.stringify(audit.mock.calls).toLowerCase()).not.toContain('person@example.com');
  });

  it('erases nothing while an order runs, and names the orders', async () => {
    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: false,
      reason: 'active_orders',
      orders: ['ord_a', 'ord_b'],
    });
    const r = await erase({ email: EMAIL, confirm: 'person@example.com', code: '123456' });
    expect(body(r)).toEqual({ kind: 'running', running: ['ord_a', 'ord_b'] });
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'personal_data.erased',
      expect.anything(),
    );
  });

  it('stops after its rounds, partly erased, so the admin runs it again', async () => {
    engine.eraseDataSubject.mockResolvedValue(round({ done: false }));
    const r = await erase({ email: EMAIL, confirm: 'person@example.com', code: '123456' });
    expect(engine.eraseDataSubject).toHaveBeenCalledTimes(20);
    expect(body(r)).toMatchObject({ kind: 'erased', erased: { done: false } });
  });

  it('downloads an export as a file never stored, audited by a hash', async () => {
    const res = (await exporter.action({
      request: post('https://app.test/privacy/export', { email: EMAIL }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ email: EMAIL });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'personal_data.exported', {
      actor: me,
      target: expect.stringMatching(/^subject:/),
      detail: { orders: 1, customers: 0, via: 'app' },
    });
  });
});

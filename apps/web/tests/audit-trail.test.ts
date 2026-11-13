import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** The hash chain in memory; `failing` makes the next append throw, as a D1 outage would. */
const { InMemoryAuditAnchors, InMemoryAuditLog } = await import(
  '@commerceworker/test-kit/commerce'
);
let log = new InMemoryAuditLog();
let anchors = new InMemoryAuditAnchors();
let failing = false;
vi.mock('~/lib/wire.server', () => ({
  auditAnchors: () => anchors,
  auditLog: () =>
    failing
      ? {
          append: async () => {
            throw new Error('D1 unavailable');
          },
        }
      : log,
}));

const { audit, listAudit, verifyAudit } = await import('~/lib/audit.server');
const { anchorAudit } = await import('@commerceworker/application/commerce');

const request = new Request('https://app.test/team', {
  headers: { 'cf-connecting-ip': '198.51.100.4' },
});
const ada = { kind: 'user' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };

afterEach(() => {
  log = new InMemoryAuditLog();
  anchors = new InMemoryAuditAnchors();
  failing = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the audit trail', () => {
  it('seals each event onto the one before, with who, where and the detail', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // listAudit newest-first sorts on the event's millisecond; two events in the same
    // millisecond tie, so each gets its own clock reading.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    await audit(request, 'team.user_added', {
      actor: ada,
      target: 'ann@example.com',
      detail: { role: 'viewer' },
    });
    vi.setSystemTime(1_700_000_001_000);
    await audit(request, 'flow.published', { actor: ada, target: 'f_web' });
    const [first, second] = log.events;
    expect(second?.prevHash).toBe(first?.hash);
    const [newest] = await listAudit();
    expect(newest).toMatchObject({ action: 'flow.published', ip: '198.51.100.4', target: 'f_web' });
    expect((await listAudit({ group: 'team' }))[0]?.detail).toEqual({ role: 'viewer' });
    // Logged as one JSON line, for Logpush.
    expect(vi.mocked(console.log).mock.calls.map((c) => JSON.parse(String(c[0])).type)).toEqual([
      'audit_event',
      'audit_event',
    ]);
  });

  it('never throws when the write fails, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    failing = true;
    await expect(audit(request, 'auth.sign_in', { actor: ada })).resolves.toBeUndefined();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      type: 'audit_write_failed',
      action: 'auth.sign_in',
    });
  });

  it('verifies the chain, from the start or after an event, and finds a tampered one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const target of ['a', 'b', 'c'])
      await audit(request, 'flow.saved', { actor: ada, target });
    expect(await verifyAudit()).toMatchObject({ ok: true });
    const [first, second] = log.events;
    expect(await verifyAudit(first!.seq)).toMatchObject({ ok: true });
    expect(await verifyAudit(first!.seq + 99)).toMatchObject({ ok: false, checked: 0 });
    Object.assign(second!, { target: 'tampered' });
    expect(await verifyAudit()).toMatchObject({ ok: false });
  });

  it('checks the chain against the newest anchor and finds one rewritten and re-hashed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const target of ['a', 'b', 'c'])
      await audit(request, 'flow.saved', { actor: ada, target });
    await anchorAudit({ audit: log, anchors }, Date.now());
    expect(await verifyAudit()).toMatchObject({ ok: true, checked: 3 });

    // Rewrite event 1 and seal the chain again from it: every hash is consistent, but not the
    // one the anchor recorded.
    const { auditRow, sealAuditRow } = await import('@commerceworker/core');
    const forged = new InMemoryAuditLog();
    for (const e of log.events) {
      const row = auditRow(e.id, e.action, { target: e.seq === 1 ? 'forged' : e.target }, e.at);
      await forged.append((h) => sealAuditRow(row, h));
    }
    log = forged;
    expect(await verifyAudit()).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: expect.stringContaining('anchor'),
    });
  });
});

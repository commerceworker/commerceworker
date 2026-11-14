import { InMemoryAdminAuditLog } from '@commerceworker/test-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditRow, sealAuditRow } from '~/lib/audit-chain';

let log = new InMemoryAdminAuditLog();
vi.mock('~/lib/wire.server', () => ({ adminAuditLog: () => log }));
const { audit, listAudit, verifyAudit } = await import('~/lib/audit.server');
const request = new Request('https://studio.example.com/team', {
  headers: { 'cf-connecting-ip': '203.0.113.7' },
});
beforeEach(() => {
  log = new InMemoryAdminAuditLog();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('audit service through the storage port', () => {
  it('seals the event, logs it and parses its detail for readers', async () => {
    await audit(request, 'auth.sign_in', {
      actor: { id: 'ada', kind: 'user', name: 'Ada', email: 'ada@example.com' },
      detail: { method: 'sso' },
    });
    const rows = await listAudit();
    expect(rows[0]).toMatchObject({
      actor: 'ada@example.com',
      actorId: 'ada',
      actorKind: 'user',
      ip: '203.0.113.7',
      seq: 1,
      detail: { method: 'sso' },
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"type":"audit_event"'));
    expect(await verifyAudit()).toMatchObject({ ok: true, checked: 1 });
  });
  it('logs a write failure without failing the action being recorded', async () => {
    vi.spyOn(log, 'append').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(audit(request, 'auth.sign_in')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"type":"audit_write_failed"'),
    );
    expect(log.events).toHaveLength(0);
  });
  it('verifies from an anchor and reports a missing anchor or changed content', async () => {
    for (const id of ['one', 'two', 'three'])
      await log.append((head) => sealAuditRow(auditRow(id, 'auth.sign_in', {}, 1000), head));
    expect(await verifyAudit(1)).toMatchObject({ ok: true, checked: 2 });
    expect(await verifyAudit(999)).toEqual({
      ok: false,
      checked: 0,
      brokenAt: 999,
      reason: 'no event 999',
    });
    log.events[1]!.target = 'edited';
    expect(await verifyAudit()).toMatchObject({ ok: false, checked: 1, brokenAt: 2 });
  });
  it('limits page sizes before reaching storage', async () => {
    const read = vi.spyOn(log, 'list');
    await listAudit({ limit: 0 });
    expect(read).toHaveBeenLastCalledWith({ limit: 1 });
    await listAudit({ limit: 1000 });
    expect(read).toHaveBeenLastCalledWith({ limit: 500 });
  });
});

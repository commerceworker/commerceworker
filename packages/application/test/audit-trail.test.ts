import { auditRow, sealAuditRow } from '@commerceworker/core';
import { InMemoryAuditLog } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { listAuditEvents, VERIFY_BATCH, verifyAuditTrail } from '../src/commerce';

async function trail(
  count: number,
  action = (i: number) => (i % 2 ? 'flow.saved' : 'team.user_added'),
) {
  const audit = new InMemoryAuditLog();
  for (let i = 1; i <= count; i++) {
    const row = auditRow(
      `aud_${i}`,
      action(i),
      { target: `t${i}`, detail: i === 1 ? { via: 'api' } : null },
      1000 + i,
    );
    await audit.append((head) => sealAuditRow(row, head));
  }
  return audit;
}

describe('listAuditEvents', () => {
  it('lists newest first, filters by group and parses the detail', async () => {
    const audit = await trail(4);
    const all = await listAuditEvents({ audit });
    expect(all.map((e) => e.id)).toEqual(['aud_4', 'aud_3', 'aud_2', 'aud_1']);
    expect(all.at(-1)?.detail).toEqual({ via: 'api' });
    expect(all[0]?.detail).toBeNull();
    const flows = await listAuditEvents({ audit }, { group: 'flow' });
    expect(flows.map((e) => e.id)).toEqual(['aud_3', 'aud_1']);
  });

  it('pages back with before and forward, oldest first, with after', async () => {
    const audit = await trail(4);
    expect((await listAuditEvents({ audit }, { before: 1003 })).map((e) => e.id)).toEqual([
      'aud_2',
      'aud_1',
    ]);
    expect((await listAuditEvents({ audit }, { after: 2 })).map((e) => e.seq)).toEqual([3, 4]);
  });

  it('keeps the limit to 1 through 500', async () => {
    const audit = await trail(3);
    expect(await listAuditEvents({ audit }, { limit: 0 })).toHaveLength(1);
    expect(await listAuditEvents({ audit }, { limit: -5 })).toHaveLength(1);
    expect(await listAuditEvents({ audit }, { limit: 2 })).toHaveLength(2);
    const seen: number[] = [];
    const spy = {
      ...audit,
      list: async (f: { limit: number }) => {
        seen.push(f.limit);
        return [];
      },
    } as unknown as InMemoryAuditLog;
    await listAuditEvents({ audit: spy }, { limit: 9999 });
    await listAuditEvents({ audit: spy });
    expect(seen).toEqual([500, 100]);
  });
});

describe('verifyAuditTrail', () => {
  it('passes an intact chain, whole or from a seq', async () => {
    const audit = await trail(5);
    expect(await verifyAuditTrail({ audit })).toMatchObject({ ok: true, checked: 5 });
    expect(await verifyAuditTrail({ audit }, 3)).toMatchObject({ ok: true, checked: 2 });
  });

  it('says where a changed event broke the chain', async () => {
    const audit = await trail(5);
    audit.events[2] = { ...audit.events[2]!, target: 'rewritten' };
    expect(await verifyAuditTrail({ audit })).toEqual({
      ok: false,
      checked: 2,
      brokenAt: 3,
      reason: 'its contents changed',
    });
  });

  it('refuses a seq that is not there', async () => {
    const audit = await trail(2);
    expect(await verifyAuditTrail({ audit }, 40)).toEqual({
      ok: false,
      checked: 0,
      brokenAt: 40,
      reason: 'no event 40',
    });
  });

  it('checks a batch at a time and gives the seq to continue from', async () => {
    const audit = await trail(VERIFY_BATCH + 3, () => 'order.started');
    const first = await verifyAuditTrail({ audit });
    expect(first).toMatchObject({ ok: true, checked: VERIFY_BATCH, next: VERIFY_BATCH });
    const rest = await verifyAuditTrail({ audit }, first.next);
    expect(rest).toMatchObject({ ok: true, checked: 3 });
    expect(rest.next).toBeUndefined();
  });
});

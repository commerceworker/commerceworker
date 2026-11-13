import { auditArchiveKey, auditRow, RETENTION, sealAuditRow } from '@commerceworker/core';
import type { AuditRow, CartRuntime } from '@commerceworker/ports/commerce';
import {
  InMemoryAuditArchive,
  InMemoryAuditLog,
  InMemoryRetentionStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_BATCH,
  archiveAudit,
  auditCopiedThrough,
  copyAudit,
  expireAddresses,
  expireMembers,
  expirePersonalData,
  indexCartBuyers,
  pruneExpired,
  purgeEndedCarts,
} from '../src/commerce';

const DAY = 86_400_000;
const now = 1_000 * DAY;

function archive() {
  const objects = new Map<string, AuditRow[]>();
  return {
    objects,
    has: async (key: string) => objects.has(key),
    copies: async () => [],
    put: async (key: string, rows: readonly AuditRow[]) => {
      if (objects.has(key)) throw new Error('locked');
      objects.set(key, [...rows]);
    },
  };
}

describe('the retention sweep', () => {
  it('archives audit events past the retention, then deletes them, keeping the chain unbroken', async () => {
    const retention = new InMemoryRetentionStore({
      audit: [
        { id: 'u1', at: 1, seq: null },
        { id: 'c1', at: 2, seq: 1 },
        { id: 'c2', at: now, seq: 2 },
        { id: 'c3', at: 3, seq: 3 },
      ],
    });
    const a = archive();
    expect(await archiveAudit({ retention, archive: a }, now, 400)).toBe(2);
    expect([...a.objects.keys()]).toEqual([
      auditArchiveKey({ at: 1, id: 'u1' }, 1),
      auditArchiveKey({ at: 2, id: 'c1' }, 1),
    ]);
    // c3 is old but after c2, which isn't: it stays until c2 goes, so the chain stays whole.
    expect((await retention.chainedAudit(10)).map((r) => r.id)).toEqual(['c2', 'c3']);
    expect(await archiveAudit({ retention, archive: a }, now, 400)).toBe(0);
  });

  it('only deletes a batch whose object a sweep that stopped already wrote', async () => {
    const rows = Array.from({ length: ARCHIVE_BATCH + 1 }, (_, i) => ({
      id: `u${String(i).padStart(5, '0')}`,
      at: 1,
      seq: null,
    }));
    const retention = new InMemoryRetentionStore({ audit: rows });
    const a = archive();
    await a.put(auditArchiveKey(rows[0]!, ARCHIVE_BATCH), rows.slice(0, ARCHIVE_BATCH));
    expect(await archiveAudit({ retention, archive: a }, now, 400)).toBe(ARCHIVE_BATCH + 1);
    expect(a.objects.size).toBe(2);
  });

  it('purges ended carts and indexes the buyers of carts that never named one', async () => {
    const retention = new InMemoryRetentionStore({
      carts: [
        { id: 'old', status: 'submitted', updatedAt: 0, pluginId: null, buyerId: null },
        { id: 'ext', status: 'open', updatedAt: now, pluginId: 'shop', buyerId: null },
        { id: 'empty', status: 'open', updatedAt: now, pluginId: 'shop', buyerId: null },
        { id: 'broken', status: 'open', updatedAt: now, pluginId: 'shop', buyerId: null },
      ],
    });
    const purged: string[] = [];
    const carts: CartRuntime = {
      purge: async (id) => {
        purged.push(id);
        return { purged: true };
      },
      reindex: async (id) => {
        if (id === 'broken') throw new Error('agent down');
        if (id === 'empty') return false;
        await retention.markBuyerless(id); // stands in for the agent writing its row
        return true;
      },
    };
    expect(await purgeEndedCarts({ retention, carts }, now, RETENTION)).toBe(1);
    expect(purged).toEqual(['old']);
    const erased: string[] = [];
    expect(
      await indexCartBuyers({ retention, carts }, async (id) => {
        erased.push(id);
      }),
    ).toBe(1);
    expect(await retention.cartBuyer('empty')).toBe('');
    expect(await retention.cartBuyer('broken')).toBeNull();
    expect(erased).toEqual([]);
  });

  it('hands the orders past the personal data retention to the erasure', async () => {
    const retention = new InMemoryRetentionStore({
      orders: [
        { id: 'o1', title: 'Old', status: 'completed', updatedAt: 0 },
        { id: 'o2', title: 'New', status: 'completed', updatedAt: now },
      ],
    });
    const r = await expirePersonalData({ retention }, now, 30, async (due) => ({
      orders: due.length,
      refused: [],
    }));
    expect(r).toEqual({ orders: 1, refused: [] });
  });

  it('prunes each table past its own retention, keeping pending deliveries and ordered checkouts', async () => {
    const retention = new InMemoryRetentionStore({
      rows: [
        { table: 'sessions', id: 's_old', at: now - 1 },
        { table: 'sessions', id: 's_live', at: now + 1 },
        { table: 'webhookDeliveries', id: 'w_old', at: now - 91 * DAY },
        { table: 'webhookDeliveries', id: 'w_pending', at: now - 91 * DAY, pending: true },
        { table: 'nodeRuns', id: 'n_recent', at: now - 10 * DAY },
        { table: 'abandonedCheckouts', id: 'c_old', at: now - 400 * DAY },
        { table: 'abandonedCheckouts', id: 'c_ordered', at: now - 400 * DAY, orderId: 'o1' },
      ],
    });
    expect(await pruneExpired({ retention }, now, RETENTION)).toMatchObject({
      sessions: 1,
      webhookDeliveries: 1,
      nodeRuns: 0,
      abandonedCheckouts: 1,
    });
  });

  it('deletes addresses last used more than the given days ago', async () => {
    const retention = new InMemoryRetentionStore({
      addresses: [
        { id: 'a_old', customerId: 'c1', lastUsedAt: now - 31 * DAY },
        { id: 'a_edge', customerId: 'c1', lastUsedAt: now - 30 * DAY },
        { id: 'a_new', customerId: 'c2', lastUsedAt: now - DAY },
      ],
    });
    expect(await expireAddresses({ retention }, now, 30)).toBe(1);
    expect(await expireAddresses({ retention }, now, 30)).toBe(0);
  });

  it('blanks members removed more than the given days ago, and no active one', async () => {
    const m = (id: string, status: string, age: number) => ({
      id,
      name: id,
      email: `${id}@x.test`,
      status,
      updatedAt: now - age * DAY,
    });
    const retention = new InMemoryRetentionStore({
      members: [m('old', 'removed', 31), m('recent', 'removed', 1), m('live', 'active', 400)],
    });
    expect(await expireMembers({ retention }, now, 30)).toBe(1);
    expect(await expireMembers({ retention }, now, 30)).toBe(0);
  });
});

describe('the daily audit copy', () => {
  async function chain(ids: string[], log = new InMemoryAuditLog()) {
    for (const id of ids)
      await log.append((h) => sealAuditRow(auditRow(id, 'flow.saved', { target: id }, now), h));
    return log;
  }

  it('copies what no copy holds, once, and leaves the events where they are', async () => {
    const audit = await chain(['a1', 'a2', 'a3']);
    const archive = new InMemoryAuditArchive();
    expect(await copyAudit({ audit, archive })).toBe(3);
    expect(archive.objects.size).toBe(1);
    expect(await copyAudit({ audit, archive })).toBe(0);
    await chain(['a4', 'a5'], audit);
    expect(await copyAudit({ audit, archive })).toBe(2);
    expect((await archive.copies()).map((c) => [c.from, c.to])).toEqual([
      [1, 3],
      [4, 5],
    ]);
    expect(audit.events).toHaveLength(5);
  });

  it('copies the events written after a restore, which reuse the lost events’ seqs', async () => {
    const audit = await chain(['a1', 'a2', 'a3']);
    const archive = new InMemoryAuditArchive();
    await copyAudit({ audit, archive });
    // A restore to just after event 1: 2 and 3 are gone, and new events take their seqs.
    audit.events.splice(1);
    await chain(['b2', 'b3'], audit);
    expect(await auditCopiedThrough({ audit, archive })).toBe(0);
    expect(await copyAudit({ audit, archive })).toBe(3);
    // The lost events stay in R2 under their own key, beside the new ones.
    const keys = [...archive.objects.values()].map((rows) => rows.map((r) => r.id).join());
    expect(keys).toEqual(expect.arrayContaining(['a1,a2,a3', 'a1,b2,b3']));
  });

  it('lets the retention step delete copied events without writing them again', async () => {
    const audit = await chain(['a1', 'a2']);
    const archive = new InMemoryAuditArchive();
    await copyAudit({ audit, archive });
    const retention = new InMemoryRetentionStore({
      audit: [
        { id: 'a1', at: 1, seq: 1 },
        { id: 'a2', at: 2, seq: 2 },
        { id: 'a3', at: 3, seq: 3 },
      ],
    });
    const before = archive.objects.size;
    // Through seq 2 is copied; seq 3 isn't, so its batch is still written first.
    expect(await archiveAudit({ retention, archive }, now, 400, 2)).toBe(3);
    expect(archive.objects.size).toBe(before + 1);
    const copied = new InMemoryRetentionStore({ audit: [{ id: 'a1', at: 1, seq: 1 }] });
    expect(await archiveAudit({ retention: copied, archive }, now, 400, 1)).toBe(1);
    expect(archive.objects.size).toBe(before + 1);
  });
});

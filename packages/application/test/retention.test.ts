import { auditArchiveKey, RETENTION } from '@commerceworker/core';
import type { AuditRow, CartRuntime } from '@commerceworker/ports/commerce';
import { InMemoryRetentionStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_BATCH,
  archiveAudit,
  expirePersonalData,
  indexCartBuyers,
  purgeEndedCarts,
} from '../src/commerce';

const DAY = 86_400_000;
const now = 1_000 * DAY;

function archive() {
  const objects = new Map<string, AuditRow[]>();
  return {
    objects,
    has: async (key: string) => objects.has(key),
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
});

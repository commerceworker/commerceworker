/**
 * The inventory port (`InventoryStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors. Every change is recorded in the `stock_movements` ledger and applied in the
 * same batch (one D1 transaction), each guarded so it applies at most once; the contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { OrderLine, StockLine } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { InventoryStore, StockLevel, StockStatus } from '@commerceworker/ports/commerce';
import { and, asc, eq, inArray, lte, or, type SQL, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { createDb } from './index';
import { contains } from './match';
import { locationStock, products, reservations, shipments, stockMovements } from './schema';

type Kind = 'hold' | 'restock' | 'release' | 'consume';

type StockMove = {
  m: { id: string; orderId: string; sku: string; kind: Kind; qty: number; locationId?: string };
  first?: BatchItem<'sqlite'>;
  guard?: SQL;
};

/** D1 binds at most 100 parameters per statement: SKU lists are read in runs under that. */
const SKUS_PER_QUERY = 90;

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** What a movement does to a stock row (central or a store's). */
function stockChange(kind: Kind, qty: number, t: { stock: SQLiteColumn; reserved: SQLiteColumn }) {
  switch (kind) {
    case 'hold':
      return { reserved: sql`${t.reserved} + ${qty}` };
    case 'restock':
      return { stock: sql`${t.stock} + ${qty}` };
    case 'release':
      return { reserved: sql`max(0, ${t.reserved} - ${qty})` };
    case 'consume':
      return { stock: sql`${t.stock} - ${qty}`, reserved: sql`max(0, ${t.reserved} - ${qty})` };
  }
}

export function d1InventoryStore(d1: D1Database, clock: Clock): InventoryStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();

  /**
   * One inventory change's statements: record it in the ledger and apply it, only if it hasn't
   * been applied yet. They run in one transaction, so a crash can't leave the ledger and the stock
   * row disagreeing, and a retry with the same id changes nothing. `first` runs before them (the
   * reservation row it belongs to); `guard`, checked after it, must hold for the change to apply
   * and be marked applied. A `locationId` moves a store's stock instead of central stock.
   */
  function moveStatements({ m, first, guard }: StockMove): BatchItem<'sqlite'>[] {
    const pending = and(
      sql`exists (select 1 from ${stockMovements} where ${and(eq(stockMovements.id, m.id), eq(stockMovements.applied, false))})`,
      guard,
    );
    const record = d
      .insert(stockMovements)
      .values({ ...m, locationId: m.locationId ?? null, createdAt: now() })
      .onConflictDoNothing();
    const apply = m.locationId
      ? d
          .update(locationStock)
          .set(stockChange(m.kind, m.qty, locationStock))
          .where(
            and(eq(locationStock.locationId, m.locationId), eq(locationStock.sku, m.sku), pending),
          )
      : d
          .update(products)
          .set(stockChange(m.kind, m.qty, products))
          .where(and(eq(products.sku, m.sku), pending));
    const mark = d
      .update(stockMovements)
      .set({ applied: true })
      .where(and(eq(stockMovements.id, m.id), guard));
    return first ? [first, record, apply, mark] : [record, apply, mark];
  }

  /**
   * Records inventory changes in the ledger and applies them, in one batch: one D1 transaction,
   * whose statements run in order, so a line's guard sees the lines before it.
   */
  async function moveStocks(moves: StockMove[]) {
    if (!moves.length) return;
    const [head, ...rest] = moves.flatMap(moveStatements);
    await d.batch([head!, ...rest]);
  }

  /**
   * Moves every held reservation for the order to `status` and applies it to stock in the same
   * batch. Each row's movement applies only while the row is the one that made the move, so a
   * cancel racing a rollback, or a release racing a consume, changes stock once.
   */
  async function settle(orderId: string, status: 'released' | 'consumed') {
    const held = await d
      .select()
      .from(reservations)
      .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
    if (!held.length) return 0;
    const kind = status === 'released' ? 'release' : 'consume';
    const ids = held.map((r) => `${kind}_${r.id}`);
    await moveStocks(
      held.map((r, i) => ({
        m: {
          id: ids[i]!,
          orderId,
          sku: r.sku,
          kind,
          qty: r.qty,
          locationId: r.locationId ?? undefined,
        },
        first: d
          .update(reservations)
          .set({ status })
          .where(and(eq(reservations.id, r.id), eq(reservations.status, 'held'))),
        guard: sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, status))})`,
      })),
    );
    const applied = await d
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(inArray(stockMovements.id, ids), eq(stockMovements.applied, true)));
    return applied.length;
  }

  const store: InventoryStore = {
    async levels(skus, locationId) {
      const out = new Map<string, StockLevel>();
      for (const run of chunk([...new Set(skus)], SKUS_PER_QUERY)) {
        const rows = locationId
          ? await d
              .select()
              .from(locationStock)
              .where(and(eq(locationStock.locationId, locationId), inArray(locationStock.sku, run)))
          : await d.select().from(products).where(inArray(products.sku, run));
        for (const r of rows) out.set(r.sku, { stock: r.stock, reserved: r.reserved });
      }
      return out;
    },

    async availability(skus) {
      const out = new Map<string, StockStatus>();
      for (const run of chunk([...new Set(skus)], SKUS_PER_QUERY)) {
        const rows = await d
          .select({
            sku: products.sku,
            stock: products.stock,
            reserved: products.reserved,
            kind: products.kind,
          })
          .from(products)
          .where(inArray(products.sku, run));
        for (const r of rows)
          out.set(
            r.sku,
            r.kind === 'digital' || r.stock - r.reserved > 0 ? 'in_stock' : 'out_of_stock',
          );
      }
      return out;
    },

    async reserve(order, stepKey, options = {}) {
      const locationOf = (l: OrderLine) => l.locationId ?? order.fulfillment?.locationId;
      const idFor = (i: number, sku: string) =>
        `res_${order.id}_${stepKey}_${i}_${sku}`.replace(/[^\w-]/g, '_');
      const prefix = idFor(0, '').slice(0, -2);
      const held = await d
        .select()
        .from(reservations)
        .where(and(eq(reservations.orderId, order.id), eq(reservations.status, 'held')));
      // Stock held by an earlier step (another loop run): the order already has it.
      const earlier = held.filter((r) => !r.id.startsWith(prefix));
      if (earlier.length) return { reservationIds: earlier.map((r) => r.id), short: [] };
      // Lines this step already held before it was retried count as available.
      const mine = new Set(held.map((r) => r.id));

      // Lines that hold stock, with their index in the order (digital goods hold none).
      const kinds = new Map<string, string>();
      for (const run of chunk([...new Set(order.lines.map((l) => l.sku))], SKUS_PER_QUERY)) {
        for (const p of await d
          .select({ sku: products.sku, kind: products.kind })
          .from(products)
          .where(inArray(products.sku, run)))
          kinds.set(p.sku, p.kind);
      }
      const lines = [...order.lines.entries()].filter(([, l]) => kinds.get(l.sku) !== 'digital');
      const locs = [...new Set(lines.map(([, l]) => locationOf(l)))];
      const free = new Map(
        await Promise.all(
          locs.map(async (loc) => {
            const levels = await store.levels(
              lines.filter(([, l]) => locationOf(l) === loc).map(([, l]) => l.sku),
              loc,
            );
            return [
              loc,
              new Map([...levels].map(([sku, v]) => [sku, v.stock - v.reserved])),
            ] as const;
          }),
        ),
      );
      const short = lines
        .filter(([i, l]) => {
          if (mine.has(idFor(i, l.sku))) return false;
          return options.forceShort || (free.get(locationOf(l))?.get(l.sku) ?? 0) < l.qty;
        })
        .map(([, l]) => l.sku);

      const reservationIds: string[] = [];
      const moves: StockMove[] = [];
      for (const [i, line] of lines) {
        if (short.includes(line.sku)) continue;
        // Keyed by order, step and line, so neither another order nor a repeated SKU collides.
        const id = idFor(i, line.sku);
        const locationId = locationOf(line);
        // The reservation row is written only while the stock is still free, so two orders racing
        // for the last units can't both hold them. The hold applies only if the row exists.
        const row = {
          id: sql`${id}`.as('id'),
          orderId: sql`${order.id}`.as('order_id'),
          sku: sql`${line.sku}`.as('sku'),
          qty: sql`${line.qty}`.as('qty'),
          status: sql`'held'`.as('status'),
          createdAt: sql`${now()}`.as('created_at'),
          locationId: sql`${locationId ?? null}`.as('location_id'),
        };
        const stillFree = locationId
          ? d
              .select(row)
              .from(locationStock)
              .where(
                and(
                  eq(locationStock.locationId, locationId),
                  eq(locationStock.sku, line.sku),
                  sql`${locationStock.stock} - ${locationStock.reserved} >= ${line.qty}`,
                ),
              )
          : d
              .select(row)
              .from(products)
              .where(
                and(
                  eq(products.sku, line.sku),
                  sql`${products.stock} - ${products.reserved} >= ${line.qty}`,
                ),
              );
        moves.push({
          m: { id, orderId: order.id, sku: line.sku, kind: 'hold', qty: line.qty, locationId },
          first: d.insert(reservations).select(stillFree).onConflictDoNothing(),
          guard: sql`exists (select 1 from ${reservations} where ${eq(reservations.id, id)})`,
        });
        reservationIds.push(id);
      }
      if (!reservationIds.length) return { reservationIds, short };
      // One batch (one transaction) for every line; each line's statements keep their own guard.
      await moveStocks(moves);
      // Lines another order took between the read above and the hold are short after all.
      const got = new Set(
        (
          await d
            .select({ id: reservations.id })
            .from(reservations)
            .where(inArray(reservations.id, reservationIds))
        ).map((r) => r.id),
      );
      for (const [i, line] of lines) {
        const id = idFor(i, line.sku);
        if (reservationIds.includes(id) && !got.has(id)) short.push(line.sku);
      }
      return { reservationIds: reservationIds.filter((id) => got.has(id)), short };
    },

    release: (orderId) => settle(orderId, 'released'),

    consume: (orderId) => settle(orderId, 'consumed'),

    async restoreShipped(orderId) {
      const live = await d
        .select({ id: shipments.id })
        .from(shipments)
        .where(
          and(
            eq(shipments.orderId, orderId),
            inArray(shipments.status, ['label_created', 'ready_for_pickup', 'collected']),
          ),
        )
        .limit(1);
      if (live.length) return 0;
      const consumed = await d
        .select()
        .from(reservations)
        .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'consumed')));
      await moveStocks(
        consumed.map((r) => ({
          m: {
            id: `unconsume_${r.id}`,
            orderId,
            sku: r.sku,
            kind: 'restock',
            qty: r.qty,
            locationId: r.locationId ?? undefined,
          },
          first: d
            .update(reservations)
            .set({ status: 'restored' })
            .where(and(eq(reservations.id, r.id), eq(reservations.status, 'consumed'))),
          guard: sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, 'restored'))})`,
        })),
      );
      return consumed.length;
    },

    async belowReorderPoint() {
      return d
        .select()
        .from(products)
        .where(sql`${products.stock} - ${products.reserved} <= ${products.reorderPoint}`);
    },

    async stockList(f) {
      const available = sql<number>`(${products.stock} - ${products.reserved})`;
      return d
        .select({
          sku: products.sku,
          name: products.name,
          stock: products.stock,
          reserved: products.reserved,
          available,
          reorderPoint: products.reorderPoint,
          supplier: products.supplier,
        })
        .from(products)
        .where(
          and(
            f.q ? or(contains(products.sku, f.q), contains(products.name, f.q)) : undefined,
            f.belowReorder ? lte(available, products.reorderPoint) : undefined,
          ),
        )
        .orderBy(asc(products.sku))
        .limit(f.limit);
    },

    async restock(orderId, stepKey, lines: readonly StockLine[]) {
      await moveStocks(
        lines.map((l, i) => ({
          m: {
            id: `stk_${orderId}_${stepKey}_${i}_${l.sku}`.replace(/[^\w-]/g, '_'),
            orderId,
            sku: l.sku,
            kind: 'restock',
            qty: l.qty,
          },
        })),
      );
    },
  };
  return store;
}

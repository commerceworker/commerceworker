/**
 * The purchase orders port (`PurchaseOrderStore`, @commerceworker/ports/commerce) on D1:
 * `purchase_orders` and `purchase_order_lines`. Every read is bound by its scope in the statement
 * itself, so a company-scoped caller can't read another's rows; a status move is one `UPDATE …
 * WHERE id = ? AND status = ?`, so of a submit and a cancel racing from `draft` one wins. A draft's
 * edit is one batch whose every statement names the draft status, so it can't land on a PO
 * submitted a moment before, and its lines are replaced with its header or not at all. A create
 * is one batch too (the header and every line); the unique indexes on the PO number and the order
 * refuse a second. Line writes are chunked under D1's 100 bound parameters per statement. Lists
 * are keyset paged newest first, a page and its total in one round trip. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type {
  PoCursor,
  PoShipTo,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderRow,
} from '@commerceworker/core';
import type {
  PurchaseOrderPage,
  PurchaseOrderScope,
  PurchaseOrderStore,
} from '@commerceworker/ports/commerce';
import { and, count, desc, eq, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { createDb } from './index';
import { contains } from './match';
import { purchaseOrderLines, purchaseOrders } from './schema';

/** A line row binds this many parameters, and the guard in front of the chunk binds two more. */
const LINE_PARAMS = 6;
const LINE_CHUNK = 14;

/** `column = scope's company`, or nothing for every company. */
const bound = (column: SQLWrapper, scope: PurchaseOrderScope): SQL | undefined =>
  'all' in scope ? undefined : eq(column, scope.companyId);

type Row = typeof purchaseOrders.$inferSelect;

const parseShipTo = (raw: string | null): PoShipTo | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PoShipTo;
  } catch {
    return null;
  }
};

const poOf = (r: Row): PurchaseOrder => ({
  ...(r as Omit<Row, 'shipTo'>),
  status: r.status as PurchaseOrder['status'],
  source: r.source as PurchaseOrder['source'],
  shipTo: parseShipTo(r.shipTo),
});

const lineCount = sql<number>`(select count(*) from ${purchaseOrderLines} where ${purchaseOrderLines.poId} = ${purchaseOrders.id})`;

/** A unique index refused the write; Drizzle wraps the driver's error as its `cause`. */
const isUnique = (err: unknown): boolean =>
  err instanceof Error && (/UNIQUE constraint failed/i.test(err.message) || isUnique(err.cause));

export function d1PurchaseOrderStore(d1: D1Database): PurchaseOrderStore {
  const d = createDb(d1);

  /** The line inserts for `lines`, each chunk written only while `guard` (a draft in scope) holds. */
  const lineStatements = (
    poId: string,
    lines: readonly PurchaseOrderLine[],
    guard: { sql: string; binds: unknown[] } | null,
  ) => {
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < lines.length; i += LINE_CHUNK) {
      const chunk = lines.slice(i, i + LINE_CHUNK);
      const values = chunk.map(() => `(${Array(LINE_PARAMS).fill('?').join(', ')})`).join(', ');
      const binds = chunk.flatMap((l, j) => [poId, i + j, l.sku, l.name, l.qty, l.unitPrice]);
      out.push(
        d1
          .prepare(
            guard
              ? `INSERT INTO purchase_order_lines (po_id, position, sku, name, qty, unit_price)
                 SELECT column1, column2, column3, column4, column5, column6 FROM (VALUES ${values})
                 WHERE ${guard.sql}`
              : `INSERT INTO purchase_order_lines (po_id, position, sku, name, qty, unit_price)
                 VALUES ${values}`,
          )
          .bind(...binds, ...(guard?.binds ?? [])),
      );
    }
    return out;
  };

  return {
    async list(scope, f, paging) {
      // Naming another company doesn't widen a scope: there is nothing to read.
      if (!('all' in scope) && f.companyId && f.companyId !== scope.companyId)
        return { rows: [], total: 0, next: null };
      const needle = f.search?.trim();
      const where = and(
        bound(purchaseOrders.companyId, scope),
        f.companyId ? eq(purchaseOrders.companyId, f.companyId) : undefined,
        f.status ? eq(purchaseOrders.status, f.status) : undefined,
        f.buyerId ? eq(purchaseOrders.buyerId, f.buyerId) : undefined,
        needle ? contains(purchaseOrders.poNumber, needle) : undefined,
        f.from !== undefined ? sql`${purchaseOrders.createdAt} >= ${f.from}` : undefined,
        f.to !== undefined ? sql`${purchaseOrders.createdAt} <= ${f.to}` : undefined,
      );
      const after: PoCursor | undefined = paging.after;
      const [total, rows] = await d.batch([
        d.select({ n: count() }).from(purchaseOrders).where(where),
        d
          .select({ po: purchaseOrders, lineCount })
          .from(purchaseOrders)
          .where(
            and(
              where,
              after
                ? sql`(${purchaseOrders.createdAt}, ${purchaseOrders.id}) < (${after.at}, ${after.id})`
                : undefined,
            ),
          )
          .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
          .limit(paging.limit + 1),
      ]);
      const shown = rows
        .slice(0, paging.limit)
        .map((r): PurchaseOrderRow => ({ ...poOf(r.po), lineCount: r.lineCount }));
      const last = shown.at(-1);
      const page: PurchaseOrderPage = {
        rows: shown,
        total: total[0]?.n ?? 0,
        next: rows.length > paging.limit && last ? { at: last.createdAt, id: last.id } : null,
      };
      return page;
    },

    async get(scope, id) {
      const [head, lines] = await d.batch([
        d
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.id, id), bound(purchaseOrders.companyId, scope)))
          .limit(1),
        d
          .select()
          .from(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.poId, id),
              // The header read names the scope; a line of a PO the scope can't see is never asked for.
              'all' in scope
                ? undefined
                : sql`${purchaseOrderLines.poId} in (select id from ${purchaseOrders} where ${purchaseOrders.companyId} = ${scope.companyId})`,
            ),
          )
          .orderBy(purchaseOrderLines.position),
      ]);
      const po = head[0];
      if (!po) return undefined;
      return {
        ...poOf(po),
        lines: lines.map((l) => ({
          sku: l.sku,
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
        })),
      };
    },

    async byNumber(scope, companyId, poNumber) {
      const row = await d
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.companyId, companyId),
            bound(purchaseOrders.companyId, scope),
            sql`lower(${purchaseOrders.poNumber}) = ${poNumber.toLowerCase()}`,
            sql`${purchaseOrders.status} <> 'cancelled'`,
          ),
        )
        .limit(1)
        .get();
      return row && poOf(row);
    },

    async byOrder(orderId) {
      const row = await d
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.orderId, orderId))
        .limit(1)
        .get();
      return row && poOf(row);
    },

    async create(po, lines) {
      try {
        await d1.batch([
          d1
            .prepare(
              `INSERT INTO purchase_orders
                 (id, company_id, buyer_id, po_number, status, currency, ship_to, notes, quote_id,
                  order_id, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              po.id,
              po.companyId,
              po.buyerId,
              po.poNumber,
              po.status,
              po.currency,
              po.shipTo ? JSON.stringify(po.shipTo) : null,
              po.notes,
              po.quoteId,
              po.orderId,
              po.source,
              po.createdAt,
              po.updatedAt,
            ),
          ...lineStatements(po.id, lines, null),
        ]);
        return { ok: true };
      } catch (err) {
        if (!isUnique(err)) throw err;
        // The batch rolled back whole. Which index refused it: this id, or this number.
        const taken = await d
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, po.id))
          .get();
        return { ok: false, conflict: taken ? 'id' : 'number' };
      }
    },

    async updateDraft(scope, id, patch, at) {
      const sets: string[] = [];
      const binds: unknown[] = [];
      const set = (column: string, value: unknown) => {
        sets.push(`${column} = ?`);
        binds.push(value);
      };
      if (patch.poNumber !== undefined) set('po_number', patch.poNumber);
      if (patch.buyerId !== undefined) set('buyer_id', patch.buyerId);
      if (patch.currency !== undefined) set('currency', patch.currency);
      if (patch.shipTo !== undefined)
        set('ship_to', patch.shipTo ? JSON.stringify(patch.shipTo) : null);
      if (patch.notes !== undefined) set('notes', patch.notes);
      if (patch.quoteId !== undefined) set('quote_id', patch.quoteId);
      set('updated_at', at);
      // Every statement is held to the same draft in the same scope, so a PO that was submitted
      // (or isn't this company's) takes none of them.
      const scoped = 'all' in scope ? '' : ' AND company_id = ?';
      const scopeBind = 'all' in scope ? [] : [scope.companyId];
      const guard = {
        sql: `EXISTS (SELECT 1 FROM purchase_orders WHERE id = ? AND status = 'draft'${scoped})`,
        binds: [id, ...scopeBind],
      };
      try {
        const [head] = await d1.batch([
          d1
            .prepare(
              `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ? AND status = 'draft'${scoped}`,
            )
            .bind(...binds, id, ...scopeBind),
          ...(patch.lines
            ? [
                d1
                  .prepare(`DELETE FROM purchase_order_lines WHERE po_id = ? AND ${guard.sql}`)
                  .bind(id, ...guard.binds),
                ...lineStatements(id, patch.lines, guard),
              ]
            : []),
        ]);
        return head && head.meta.changes > 0 ? { ok: true } : { ok: false, conflict: 'missing' };
      } catch (err) {
        if (!isUnique(err)) throw err;
        return { ok: false, conflict: 'number' };
      }
    },

    async transition(scope, id, from, to, at) {
      const res = await d
        .update(purchaseOrders)
        .set({ status: to, updatedAt: at })
        .where(
          and(
            eq(purchaseOrders.id, id),
            eq(purchaseOrders.status, from),
            bound(purchaseOrders.companyId, scope),
          ),
        )
        .returning({ id: purchaseOrders.id });
      return res.length > 0;
    },

    async linkOrder(scope, id, orderId, at) {
      try {
        const res = await d
          .update(purchaseOrders)
          .set({ orderId, updatedAt: at })
          .where(
            and(
              eq(purchaseOrders.id, id),
              bound(purchaseOrders.companyId, scope),
              sql`(${purchaseOrders.orderId} is null or ${purchaseOrders.orderId} = ${orderId})`,
            ),
          )
          .returning({ id: purchaseOrders.id });
        return res.length > 0;
      } catch (err) {
        // The order already belongs to another PO.
        if (isUnique(err)) return false;
        throw err;
      }
    },
  };
}

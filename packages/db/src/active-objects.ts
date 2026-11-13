/**
 * The live orders and carts the nightly Durable Object copy walks (`ActiveObjects`,
 * @commerceworker/ports/commerce) on D1: an order that hasn't reached a terminal status, a cart
 * that isn't final and hasn't been purged. A keyset page by id, so a run that stops resumes.
 */
import { FINAL_CART_STATUSES, TERMINAL_ORDER_STATUSES } from '@commerceworker/core';
import type { ActiveObjects } from '@commerceworker/ports/commerce';
import { and, asc, gt, isNull, notInArray } from 'drizzle-orm';
import { createDb } from './index';
import { carts, orders } from './schema';

export function d1ActiveObjects(d1: D1Database): ActiveObjects {
  const d = createDb(d1);
  return {
    async page(cls, after, limit) {
      // One more than asked for says whether another page follows.
      const rows =
        cls === 'OrderAgent'
          ? await d
              .select({ id: orders.id })
              .from(orders)
              .where(and(gt(orders.id, after), notInArray(orders.status, TERMINAL_ORDER_STATUSES)))
              .orderBy(asc(orders.id))
              .limit(limit + 1)
          : await d
              .select({ id: carts.id })
              .from(carts)
              .where(
                and(
                  gt(carts.id, after),
                  notInArray(carts.status, [...FINAL_CART_STATUSES]),
                  isNull(carts.purgedAt),
                ),
              )
              .orderBy(asc(carts.id))
              .limit(limit + 1);
      const names = rows.slice(0, limit).map((r) => r.id);
      return { names, next: names.at(-1) ?? after, more: rows.length > limit };
    },
  };
}

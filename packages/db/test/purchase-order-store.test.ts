import { env } from 'cloudflare:workers';
import { describePurchaseOrderStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1PurchaseOrderStore } from '../src/purchase-order-store';
import { purchaseOrderLines, purchaseOrders } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describePurchaseOrderStoreContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(purchaseOrderLines).where(like(purchaseOrderLines.poId, 'poct_%'));
  await db.delete(purchaseOrders).where(like(purchaseOrders.id, 'poct_%'));
  return d1PurchaseOrderStore(DB);
});

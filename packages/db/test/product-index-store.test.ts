import { env } from 'cloudflare:workers';
import {
  describeProductIndexStoreContract,
  type ProductIndexFixture,
} from '@commerceworker/test-kit/commerce';
import { createDb } from '../src/index';
import { d1ProductIndexStore } from '../src/product-index-store';
import { productIndexLease, products, productVectors } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the whole catalog this file's database holds. */
async function seed(f: ProductIndexFixture) {
  const db = createDb(DB);
  await db.delete(productVectors);
  await db.delete(productIndexLease);
  await db.delete(products);
  for (const p of f.products ?? []) await db.insert(products).values({ ...p, price: 1, cost: 1 });
  for (const v of f.vectors ?? []) await db.insert(productVectors).values({ ...v, indexedAt: 0 });
}

describeProductIndexStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1ProductIndexStore(DB);
});

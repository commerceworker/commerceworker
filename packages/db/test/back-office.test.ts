import { env } from 'cloudflare:workers';
import {
  type BackOfficeFixture,
  describeBackOfficeContract,
} from '@commerceworker/test-kit/commerce';
import { d1BackOffice } from '../src/back-office';
import { createDb } from '../src/index';
import {
  companies,
  contractPrices,
  customers,
  fxRates,
  locationStock,
  locations,
  priceRules,
  priceSources,
  products,
  sellers,
} from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only catalog, customers, sellers, stores and pricing this database holds. */
async function seed(f: BackOfficeFixture) {
  const db = createDb(DB);
  // Rules before their sources, stock before its stores.
  for (const t of [
    priceRules,
    contractPrices,
    locationStock,
    priceSources,
    locations,
    sellers,
    products,
    companies,
    customers,
    fxRates,
  ])
    await db.delete(t);
  const put = async <T>(xs: T[] | undefined, write: (x: T) => Promise<unknown>) => {
    for (const x of xs ?? []) await write(x);
  };
  await put(f.products, (x) => db.insert(products).values(x));
  await put(f.customers, (x) => db.insert(customers).values(x));
  await put(f.companies, (x) =>
    db.insert(companies).values({ ...x, legalName: x.customerId, createdAt: 1, updatedAt: 1 }),
  );
  await put(f.sellers, (x) => db.insert(sellers).values(x));
  await put(f.locations, (x) => db.insert(locations).values(x));
  await put(f.stock, (x) => db.insert(locationStock).values(x));
  await put(f.sources, (x) => db.insert(priceSources).values(x));
  await put(f.rules, (x) => db.insert(priceRules).values(x));
  await put(f.contracts, (x) => db.insert(contractPrices).values(x));
  await put(f.rates, (x) => db.insert(fxRates).values(x));
}

describeBackOfficeContract('D1', async (fixture) => {
  await seed(fixture);
  return d1BackOffice(DB);
});

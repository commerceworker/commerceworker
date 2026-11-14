import { describeCatalogOrdersContract, InMemoryCatalogOrders } from '../src/commerce';

describeCatalogOrdersContract('in memory', async () => {
  const store = new InMemoryCatalogOrders();
  return { store, read: async (sku) => store.rows.get(sku) };
});

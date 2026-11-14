import { d1CatalogOrders } from '@commerceworker/db/catalog-orders';

export const catalogOrders = (env: Env) => d1CatalogOrders(env.DB);

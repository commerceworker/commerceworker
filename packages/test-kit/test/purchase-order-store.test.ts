import { describePurchaseOrderStoreContract, InMemoryPurchaseOrderStore } from '../src/commerce';

describePurchaseOrderStoreContract('in memory', async () => new InMemoryPurchaseOrderStore());

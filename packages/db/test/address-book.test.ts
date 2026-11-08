import { env } from 'cloudflare:workers';
import {
  type AddressBookFixture,
  describeAddressBookContract,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1AddressBook } from '../src/address-book';
import { createDb } from '../src/index';
import { customerAddresses, orders } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

async function seed(f: AddressBookFixture) {
  const db = createDb(DB);
  await db.delete(customerAddresses).where(like(customerAddresses.customerId, 'ab_%'));
  await db.delete(orders).where(like(orders.id, 'ab_%'));
  for (const o of f.pending ?? [])
    await db.insert(orders).values({
      id: o.id,
      model: 'b2b',
      status: 'completed',
      flowId: 'ab_flow',
      flowVersion: 1,
      customerId: o.customerId,
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
      erasedAt: o.erasedAt,
      addressPending: 1,
    });
}

describeAddressBookContract('D1', async (fixture) => {
  await seed(fixture);
  return d1AddressBook(DB);
});

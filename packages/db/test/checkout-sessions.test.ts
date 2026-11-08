import { env } from 'cloudflare:workers';
import { describeCheckoutSessionsContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1CheckoutSessions } from '../src/checkout-sessions';
import { createDb } from '../src/index';
import { checkoutSessions } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describeCheckoutSessionsContract('D1', async () => {
  await createDb(DB).delete(checkoutSessions).where(like(checkoutSessions.id, 'csc_%'));
  return d1CheckoutSessions(DB);
});

/**
 * The places a customer's orders ship to (`customer_addresses`), for the customer page: the
 * address use-cases (@commerceworker/application/commerce) bound to this deployment. An order adds
 * its ship-to when it starts; orders started before the table are added by the daily sweep
 * (`backfillAddresses`); erasure and the personal data retention sweep remove them.
 */
import * as uc from '@commerceworker/application/commerce';
import { type OrderState, personalDataRetentionDays } from '@commerceworker/core';
import { orderAgent } from './namespaces';
import { addressBook, pricingStore } from './wire';

/** Records the order's ship-to against its customer. Free text and unusable addresses aren't kept. */
export const rememberAddress = (
  env: Pick<Env, 'DB'>,
  order: { id: string; customerId?: string | null; shipTo: unknown; at: number },
) => uc.rememberAddress({ addresses: addressBook(env) }, order);

/**
 * Adds the ship-to of orders started before `customer_addresses` (marked `address_pending` by
 * migration 0063). Returns how many orders it cleared; once every mark is cleared this finds
 * nothing.
 */
export const backfillAddresses = (env: Env, now = Date.now()) =>
  uc.backfillAddresses(
    { addresses: addressBook(env), pricing: pricingStore(env) },
    async (id) => (await orderAgent(env, id).snapshot()) as OrderState,
    now,
    personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS),
  );

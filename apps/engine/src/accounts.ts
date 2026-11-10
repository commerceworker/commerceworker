/**
 * What a run reads of the order's company and buyer: `company.*` and `buyer.*` in a flow's
 * expressions (`accountContext` in core). Read once, inside a step, so a replay sees what the
 * first run did even if the company changed since.
 */
import {
  type AccountContext,
  accountContext,
  type Order,
  orderBuyerId,
} from '@commerceworker/core';
import { companyDirectory, pricingStore } from './wire';

export async function loadAccount(
  env: Pick<Env, 'DB'>,
  order: Pick<Order, 'customerId' | 'meta'>,
): Promise<AccountContext> {
  if (!order.customerId) return accountContext(undefined, undefined, undefined);
  const [customer, held] = await Promise.all([
    pricingStore(env).customer(order.customerId),
    companyDirectory(env).access({ all: true }, order.customerId, orderBuyerId(order.meta)),
  ]);
  return accountContext(customer, held.company, held.buyer);
}

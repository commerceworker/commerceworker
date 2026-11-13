/**
 * The behaviour every `PaymentLedger` keeps: the in-memory ledger runs it in node and the D1
 * ledger in workerd (packages/db). Order and customer ids start `pc_`, which the D1 runner clears;
 * the clock moves on between writes, so rows read oldest first in both.
 */
import {
  type NewPayment,
  PaymentClaimedError,
  type PaymentLedger,
} from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { PaymentLedgerFixture } from './payment-ledger';

export const PAYMENT_LEDGER_FIXTURE: PaymentLedgerFixture = {
  customers: [
    {
      id: 'pc_ada',
      name: 'Ada',
      email: 'ada@example.com',
      stripeCustomerId: null,
      paymentMethodId: null,
    },
  ],
};

const auth = (id: string, over: Partial<NewPayment> = {}): NewPayment => ({
  id,
  orderId: 'pc_order',
  kind: 'authorization:card',
  amount: 100,
  status: 'authorized',
  provider: 'stripe',
  externalId: `pi_${id}`,
  currency: 'USD',
  ...over,
});

export function describePaymentLedgerContract(
  name: string,
  make: (fixture: PaymentLedgerFixture) => Promise<PaymentLedger>,
) {
  describe(`${name}: the payments ledger contract`, () => {
    const fresh = () => make(PAYMENT_LEDGER_FIXTURE);

    it('records a row once: a retry gets what the first stored', async () => {
      const l = await fresh();
      const first = await l.record(auth('pc_a1'));
      expect(first).toMatchObject({
        id: 'pc_a1',
        status: 'authorized',
        ref: null,
        currency: 'USD',
      });
      expect(await l.record(auth('pc_a1', { status: 'declined', amount: 5 }))).toEqual(first);
      expect(await l.find('pc_a1')).toEqual(first);
      expect(await l.find('pc_none')).toBeUndefined();
    });

    it("reads an order's rows oldest first, by ids and by processor id", async () => {
      const l = await fresh();
      await l.record(auth('pc_b2'));
      await l.record(
        auth('pc_b1', { kind: 'charge', status: 'succeeded', externalId: 'pi_shared' }),
      );
      await l.record(auth('pc_b3', { orderId: 'pc_other', externalId: 'pi_shared' }));
      expect((await l.forOrder('pc_order')).map((r) => r.id)).toEqual(['pc_b2', 'pc_b1']);
      expect((await l.findMany(['pc_b3', 'pc_b1', 'pc_x'])).map((r) => r.id)).toEqual([
        'pc_b1',
        'pc_b3',
      ]);
      expect((await l.forExternalId('pi_shared')).map((r) => r.orderId)).toEqual([
        'pc_order',
        'pc_other',
      ]);
    });

    it('voids an authorization once, and only while it is open', async () => {
      const l = await fresh();
      await l.record(auth('pc_v1'));
      expect(await l.voidAuthorization('pc_v1')).toBe(true);
      expect(await l.voidAuthorization('pc_v1')).toBe(false);
      await l.record(auth('pc_v2', { orderId: 'pc_o2', externalId: 'pi_gone' }));
      expect(await l.voidIntent('pi_gone')).toEqual(['pc_o2']);
      expect(await l.voidIntent('pi_gone')).toEqual([]);
    });

    it('captures an open authorization once; a voided one captures nothing', async () => {
      const l = await fresh();
      await l.record(auth('pc_c1'));
      const capture: NewPayment = {
        id: 'pc_cap1',
        orderId: 'pc_order',
        kind: 'capture',
        amount: 80,
        status: 'succeeded',
        ref: 'pc_c1',
        provider: 'stripe',
        externalId: 'pi_pc_c1',
        currency: 'USD',
      };
      expect(await l.capture('pc_c1', capture)).toMatchObject({ id: 'pc_cap1', amount: 80 });
      expect(await l.find('pc_c1')).toMatchObject({ status: 'captured', ref: 'pc_cap1' });
      expect(await l.capture('pc_c1', { ...capture, amount: 1 })).toMatchObject({ amount: 80 });
      expect(await l.voidAuthorization('pc_c1')).toBe(false);

      await l.record(auth('pc_c2'));
      await l.voidAuthorization('pc_c2');
      expect(await l.capture('pc_c2', { ...capture, id: 'pc_cap2', ref: 'pc_c2' })).toBeUndefined();
    });

    it('lets one authorization and one refund claim a processor id, and refuses a second', async () => {
      const l = await fresh();
      await l.record(auth('pc_k1', { externalId: 'pi_claimed' }));
      await expect(
        l.record(auth('pc_k2', { orderId: 'pc_other', externalId: 'pi_claimed' })),
      ).rejects.toBeInstanceOf(PaymentClaimedError);
      expect(await l.find('pc_k2')).toBeUndefined();
      // The same row again is a retry, not a claim.
      expect(await l.record(auth('pc_k1', { externalId: 'pi_claimed' }))).toMatchObject({
        id: 'pc_k1',
      });
      // A decline, a capture and a charge name an intent without claiming it.
      await l.record(auth('pc_k3', { externalId: 'pi_claimed', status: 'declined' }));
      await l.record(
        auth('pc_k4', { kind: 'capture', status: 'succeeded', externalId: 'pi_claimed' }),
      );
      const refund = (id: string) =>
        auth(id, { kind: 'refund', status: 'succeeded', externalId: 're_claimed' });
      await l.record(refund('pc_k5'));
      await expect(l.record(refund('pc_k6'))).rejects.toBeInstanceOf(PaymentClaimedError);
    });

    it("saves a customer's card and settles on one processor customer", async () => {
      const l = await fresh();
      expect(await l.customer('pc_nobody')).toBeUndefined();
      expect(await l.claimStripeCustomer('pc_ada', 'cus_first')).toBe('cus_first');
      expect(await l.claimStripeCustomer('pc_ada', 'cus_second')).toBe('cus_first');
      await l.saveCard('pc_ada', { paymentMethodId: 'pm_1' });
      expect(await l.customer('pc_ada')).toEqual({
        id: 'pc_ada',
        name: 'Ada',
        email: 'ada@example.com',
        stripeCustomerId: 'cus_first',
        paymentMethodId: 'pm_1',
      });
      await l.saveCard('pc_ada', { paymentMethodId: 'pm_2', stripeCustomerId: 'cus_new' });
      expect(await l.customer('pc_ada')).toMatchObject({
        stripeCustomerId: 'cus_new',
        paymentMethodId: 'pm_2',
      });
    });
  });
}

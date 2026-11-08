/**
 * The behaviour every `MarketplaceStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Each case seeds a fresh store; order and seller ids are
 * distinctive so a backend holding other rows can't satisfy an assertion by accident.
 */
import { FIRST_PARTY } from '@commerceworker/core';
import { type MarketplaceStore, payoutId } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { MarketplaceFixture } from './marketplace-store';

const seller = (id: string, over: Partial<{ autoAccept: boolean; active: boolean }> = {}) => ({
  id,
  name: id.replace('mc_', 'Seller '),
  email: `${id}@example.com`,
  commissionPct: 0.1,
  autoAccept: false,
  active: true,
  ...over,
});

export const MARKETPLACE_FIXTURE: MarketplaceFixture = {
  sellers: [
    seller('mc_acme'),
    seller('mc_bolt', { autoAccept: true }),
    seller('mc_gone', { active: false }),
  ],
};

const line = (sku: string, unitPrice: number) => ({ sku, qty: 1, unitPrice });

export function describeMarketplaceStoreContract(
  name: string,
  make: (fixture: MarketplaceFixture) => Promise<MarketplaceStore>,
) {
  describe(`${name}: the marketplace store contract`, () => {
    const fresh = () => make(MARKETPLACE_FIXTURE);
    const open = (s: MarketplaceStore, orderId: string) =>
      s.openSellerOrders(orderId, [
        { sellerId: 'mc_acme', status: 'pending', lines: [line('MC-A', 40)], subtotal: 40 },
        { sellerId: 'mc_bolt', status: 'accepted', lines: [line('MC-B', 60)], subtotal: 60 },
        { sellerId: FIRST_PARTY, status: 'accepted', lines: [line('MC-F', 10)], subtotal: 10 },
      ]);
    const statuses = async (s: MarketplaceStore, orderId: string) =>
      (await s.parts(orderId)).map((p) => [p.sellerId, p.status]);

    it('reads sellers by id, including inactive ones, and nothing for an unknown id', async () => {
      const s = await fresh();
      const got = await s.sellers(['mc_acme', 'mc_gone', 'mc_nobody', 'mc_acme']);
      expect(got.map((x) => [x.id, x.active]).sort()).toEqual([
        ['mc_acme', true],
        ['mc_gone', false],
      ]);
    });

    it('opens one part per seller, once, and names the first party Marketplace', async () => {
      const s = await fresh();
      await open(s, 'mc_order');
      await s.openSellerOrders('mc_order', [
        { sellerId: 'mc_acme', status: 'accepted', lines: [], subtotal: 0 },
      ]);
      expect(await s.parts('mc_order')).toEqual([
        {
          sellerId: FIRST_PARTY,
          name: 'Marketplace',
          status: 'accepted',
          subtotal: 10,
          reason: null,
        },
        { sellerId: 'mc_acme', name: 'Seller acme', status: 'pending', subtotal: 40, reason: null },
        {
          sellerId: 'mc_bolt',
          name: 'Seller bolt',
          status: 'accepted',
          subtotal: 60,
          reason: null,
        },
      ]);
    });

    it('decides only a pending part, so a replay changes nothing', async () => {
      const s = await fresh();
      await open(s, 'mc_decide');
      await s.decide('mc_decide', 'mc_acme', 'rejected', 'Out of stock');
      await s.decide('mc_decide', 'mc_acme', 'accepted');
      await s.decide('mc_decide', 'mc_bolt', 'rejected');
      const acme = (await s.parts('mc_decide')).find((p) => p.sellerId === 'mc_acme');
      expect(acme).toMatchObject({ status: 'rejected', reason: 'Out of stock' });
      expect(await statuses(s, 'mc_decide')).toContainEqual(['mc_bolt', 'accepted']);
    });

    it('expires the parts still pending', async () => {
      const s = await fresh();
      await open(s, 'mc_expire');
      expect(await s.expire('mc_expire', 'No response')).toBe(1);
      expect(await s.expire('mc_expire', 'No response')).toBe(0);
      const acme = (await s.parts('mc_expire')).find((p) => p.sellerId === 'mc_acme');
      expect(acme).toMatchObject({ status: 'rejected', reason: 'No response' });
    });

    it('cancels pending and accepted parts once, leaving rejected ones', async () => {
      const s = await fresh();
      await open(s, 'mc_cancel');
      await s.decide('mc_cancel', 'mc_acme', 'rejected');
      expect(await s.cancel('mc_cancel')).toBe(2);
      expect(await s.cancel('mc_cancel')).toBe(0);
      expect(await statuses(s, 'mc_cancel')).toEqual([
        [FIRST_PARTY, 'cancelled'],
        ['mc_acme', 'rejected'],
        ['mc_bolt', 'cancelled'],
      ]);
    });

    it('tells the sellers still to answer, else those who accepted', async () => {
      const s = await fresh();
      await open(s, 'mc_tell');
      expect(await s.contacts('mc_tell')).toEqual([
        { id: 'mc_acme', email: 'mc_acme@example.com' },
      ]);
      await s.decide('mc_tell', 'mc_acme', 'rejected');
      expect(await s.contacts('mc_tell')).toEqual([
        { id: 'mc_bolt', email: 'mc_bolt@example.com' },
      ]);
    });

    it('lists accepted third-party parts with their commission', async () => {
      const s = await fresh();
      await open(s, 'mc_accepted');
      await s.decide('mc_accepted', 'mc_acme', 'accepted');
      expect(await s.acceptedParts('mc_accepted')).toEqual([
        { sellerId: 'mc_acme', subtotal: 40, commissionPct: 0.1 },
        { sellerId: 'mc_bolt', subtotal: 60, commissionPct: 0.1 },
      ]);
    });

    it('schedules each payout once and reverses scheduled ones once', async () => {
      const s = await fresh();
      const row = {
        id: payoutId('mc_pay', 'payout#1', 'mc_bolt'),
        orderId: 'mc_pay',
        sellerId: 'mc_bolt',
        gross: 60,
        commission: 6,
        refunded: 0,
        net: 54,
        status: 'scheduled',
      };
      expect(row.id).toBe('pout_mc_pay_payout_1_mc_bolt');
      await s.schedulePayouts([row]);
      await s.schedulePayouts([{ ...row, net: 1 }]);
      expect(await s.payouts('mc_pay')).toEqual([row]);
      expect(await s.reversePayouts('mc_pay')).toBe(1);
      expect(await s.reversePayouts('mc_pay')).toBe(0);
      expect((await s.payouts('mc_pay'))[0]?.status).toBe('reversed');
    });
  });
}

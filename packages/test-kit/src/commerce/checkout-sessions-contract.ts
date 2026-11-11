/**
 * The behaviour every `CheckoutSessionStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Session ids start `csc_`, which the D1 runner clears.
 */
import type { CheckoutSession } from '@commerceworker/core';
import type { CheckoutSessionStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const session = (id: string, over: Partial<CheckoutSession> = {}): CheckoutSession =>
  ({
    id,
    ownerId: 'platform_a',
    status: 'incomplete',
    currency: 'USD',
    lines: [],
    buyer: {},
    fulfillment: 'ship',
    shipTo: null,
    shippingOption: null,
    quote: null,
    issues: [],
    orderId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 9_000,
    version: 1,
    ...over,
  }) as CheckoutSession;

export function describeCheckoutSessionsContract(
  name: string,
  make: () => Promise<CheckoutSessionStore>,
) {
  describe(`${name}: the checkout sessions contract`, () => {
    it("reads a platform's own session, and another's as missing", async () => {
      const s = await make();
      await s.create(session('csc_1'));
      expect(await s.load('platform_a', 'csc_1')).toEqual(session('csc_1'));
      expect(await s.load('platform_b', 'csc_1')).toBeNull();
      expect(await s.load('platform_a', 'csc_none')).toBeNull();
    });

    it('writes only over the version it read', async () => {
      const s = await make();
      await s.create(session('csc_2'));
      const next = session('csc_2', { status: 'ready_for_complete', version: 2, updatedAt: 2_000 });
      expect(await s.save(next, 1)).toBe(true);
      expect(await s.save(session('csc_2', { status: 'canceled', version: 2 }), 1)).toBe(false);
      expect(await s.load('platform_a', 'csc_2')).toMatchObject({
        status: 'ready_for_complete',
        version: 2,
      });
    });

    it('hands a session to a new owner once, and only while it is open and unexpired', async () => {
      const s = await make();
      await s.create(session('csc_4', { ownerId: 'start:a' }));
      expect(await s.ownerOf('csc_4')).toBe('start:a');
      expect(await s.ownerOf('csc_none')).toBeNull();
      // Not its owner: nothing moves.
      expect(await s.transfer('csc_4', 'start:b', 'cookie:1', 2_000)).toBeNull();
      expect(await s.transfer('csc_none', 'start:a', 'cookie:1', 2_000)).toBeNull();
      expect(await s.transfer('csc_4', 'start:a', 'cookie:1', 2_000)).toMatchObject({
        id: 'csc_4',
        ownerId: 'cookie:1',
      });
      // Used: a second redemption finds it no longer the start link's.
      expect(await s.transfer('csc_4', 'start:a', 'cookie:2', 2_000)).toBeNull();
      expect(await s.ownerOf('csc_4')).toBe('cookie:1');
      // The old owner reads nothing now; the new one reads the session with its own owner.
      expect(await s.load('start:a', 'csc_4')).toBeNull();
      expect(await s.load('cookie:1', 'csc_4')).toMatchObject({ ownerId: 'cookie:1' });
      expect(await s.save(session('csc_4', { ownerId: 'cookie:1', version: 2 }), 1)).toBe(true);
    });

    it('does not hand over an expired or finished session', async () => {
      const s = await make();
      await s.create(session('csc_5', { ownerId: 'start:a' }));
      expect(await s.transfer('csc_5', 'start:a', 'cookie:1', 9_000)).toBeNull();
      await s.create(session('csc_6', { ownerId: 'start:a', status: 'canceled' }));
      expect(await s.transfer('csc_6', 'start:a', 'cookie:1', 2_000)).toBeNull();
      expect(await s.ownerOf('csc_6')).toBe('start:a');
    });

    it('finds the session that placed an order', async () => {
      const s = await make();
      await s.create(session('csc_3'));
      await s.save(session('csc_3', { status: 'completed', orderId: 'csc_ord', version: 2 }), 1);
      expect(await s.forOrder('csc_ord')).toMatchObject({ id: 'csc_3', status: 'completed' });
      expect(await s.forOrder('csc_none')).toBeNull();
    });
  });
}

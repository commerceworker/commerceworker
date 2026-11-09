import { EMPTY_ORDER_STATE, erasedCustomerEmail, type OrderState } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryAddressBook,
  InMemoryPricingStore,
  PRICING_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it, vi } from 'vitest';
import { backfillAddresses, rememberAddress } from '../src/commerce';

const DAY = 86_400_000;
const NOW = 400 * DAY;
const shipTo = {
  name: 'Ada',
  line1: '1 Main St',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  country: 'US',
};
const [live, other] = PRICING_FIXTURE.customers!;
const erased = { ...other!, email: erasedCustomerEmail(other!.id) };

describe("remembering a customer's addresses", () => {
  it('keeps a real ship-to for a customer, and nothing for a guest or free text', async () => {
    const addresses = new InMemoryAddressBook();
    await rememberAddress({ addresses }, { id: 'o1', customerId: live!.id, shipTo, at: 5 });
    await rememberAddress({ addresses }, { id: 'o2', customerId: null, shipTo, at: 6 });
    await rememberAddress(
      { addresses },
      { id: 'o3', customerId: live!.id, shipTo: 'leave it at the door', at: 7 },
    );
    const kept = await addresses.addresses(live!.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ line1: '1 Main St', orders: 1, lastOrderId: 'o1' });
  });

  it("adds older orders' ship-tos from their state, skipping erased or too-old ones, and clears each", async () => {
    const pending = [
      { id: 'ob1', customerId: live!.id, createdAt: NOW - DAY, erasedAt: null },
      { id: 'ob2', customerId: erased.id, createdAt: NOW - DAY, erasedAt: null },
      { id: 'ob3', customerId: live!.id, createdAt: NOW - DAY, erasedAt: 9 },
      { id: 'ob4', customerId: live!.id, createdAt: NOW - 60 * DAY, erasedAt: null },
      { id: 'ob5', customerId: null, createdAt: NOW, erasedAt: null },
    ];
    const ports = {
      addresses: new InMemoryAddressBook({ pending }),
      pricing: new InMemoryPricingStore(
        { ...PRICING_FIXTURE, customers: [live!, erased] },
        new FixedClock(),
      ),
    };
    const snapshot = vi.fn(
      async (): Promise<OrderState> => ({
        ...EMPTY_ORDER_STATE,
        order: { meta: { shipTo } } as unknown as OrderState['order'],
      }),
    );
    expect(await backfillAddresses(ports, snapshot, NOW, 30)).toBe(5);
    // Only the live customer's recent, unerased order was read and kept, dated when it started.
    expect(snapshot.mock.calls.map((c) => c[0])).toEqual(['ob1']);
    expect(await ports.addresses.addresses(live!.id)).toMatchObject([
      { lastOrderId: 'ob1', firstUsedAt: NOW - DAY },
    ]);
    expect(await ports.addresses.addresses(erased.id)).toEqual([]);
    expect(await ports.addresses.pendingBackfill(10)).toEqual([]);
    expect(await backfillAddresses(ports, snapshot, NOW, 30)).toBe(0);
  });

  it('leaves an order that cannot answer for the next sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ports = {
      addresses: new InMemoryAddressBook({
        pending: [{ id: 'ob1', customerId: live!.id, createdAt: NOW, erasedAt: null }],
      }),
      pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock()),
    };
    const down = async (): Promise<OrderState> => {
      throw new Error('agent down');
    };
    expect(await backfillAddresses(ports, down, NOW, null)).toBe(0);
    expect(await ports.addresses.pendingBackfill(10)).toHaveLength(1);
  });
});

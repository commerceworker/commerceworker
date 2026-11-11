import { describe, expect, it } from 'vitest';
import type { CheckoutSession } from '../src';
import {
  HOSTED_HASH,
  HOSTED_ID,
  hostedCall,
  hostedGuestId,
  hostedHash,
  hostedOwner,
  hostedPatchSchema,
  hostedPatchWithLinesSchema,
  hostedStartOwner,
  hostedStartPath,
  hostedView,
  readStorefrontSettings,
  STOREFRONT_OFF,
  signGuestActor,
  verifyGuestActor,
  verifyRpcActor,
} from '../src';

describe('hosted checkout ownership', () => {
  it('hashes to lowercase hex SHA-256, and keeps a start token apart from a cookie secret', async () => {
    expect(await hostedHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const h = await hostedHash('same');
    expect(h).toMatch(HOSTED_HASH);
    // A used start token's hash is never a cookie's owner, whatever was hashed.
    expect(hostedOwner(h)).not.toBe(hostedStartOwner(h));
    expect(hostedOwner(h).startsWith('hosted:')).toBe(true);
    expect(hostedStartOwner(h).startsWith('hosted-start:')).toBe(true);
  });

  it('names a session id, a call and a buyer from the checkout id alone', () => {
    expect(hostedCall('chk_1')).toBe('checkout:chk_1');
    expect(hostedGuestId('chk_1')).toBe('guest:checkout:chk_1');
    expect(hostedStartPath('chk_1', 'tok')).toBe('/checkout/start/chk_1/tok');
    for (const ok of ['chk_abc123', 'chk_a-b_c'] as const) expect(HOSTED_ID.test(ok)).toBe(true);
    for (const bad of ['', 'chk_', 'cart_1', 'chk_../x', 'chk_a b', `chk_${'a'.repeat(65)}`])
      expect(HOSTED_ID.test(bad), bad).toBe(false);
  });

  it('signs a buyer for one checkout under the storefront key, and no staff key vouches for it', async () => {
    const actor = { kind: 'guest' as const, id: hostedGuestId('chk_1'), name: 'Buyer' };
    const signed = await signGuestActor('sf-key', actor, hostedCall('chk_1'));
    expect(await verifyGuestActor(['sf-key'], signed, hostedCall('chk_1'))).toEqual(actor);
    expect(await verifyGuestActor(['sf-key'], signed, hostedCall('chk_2'))).toBeNull();
    expect(await verifyGuestActor(['other-key'], signed, hostedCall('chk_1'))).toBeNull();
    expect(await verifyRpcActor(['sf-key'], signed, hostedCall('chk_1'))).toBeNull();
  });

  it('shows a buyer only what it lists: no owner, customer, payment or other internals', () => {
    const s = {
      id: 'chk_1',
      ownerId: 'hosted:abc',
      customerId: 'cus_1',
      payment: { intentId: 'pi_secret', state: 'held' },
      secretInternal: 1,
      status: 'incomplete',
      currency: 'USD',
      lines: [{ id: 'li_1', sku: 'A', qty: 1, unitPrice: 5, internal: 'x' }],
      buyer: { email: 'a@example.com' },
      fulfillment: 'ship',
      shipTo: null,
      shippingOption: null,
      quote: null,
      issues: [],
      orderId: null,
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      version: 4,
    } as unknown as CheckoutSession;
    const v = hostedView(s);
    expect(Object.keys(v).sort()).toEqual(
      [
        'buyer',
        'currency',
        'expiresAt',
        'fulfillment',
        'id',
        'issues',
        'lines',
        'orderId',
        'pickupLocationId',
        'pickupStores',
        'promoCodes',
        'quote',
        'shipTo',
        'shippingOption',
        'status',
        'version',
      ].sort(),
    );
    expect(JSON.stringify(v)).not.toMatch(/hosted:|cus_1|pi_secret|internal|createdAt/);
    expect(v.lines[0]).toMatchObject({ id: 'li_1', sku: 'A', qty: 1, unitPrice: 5 });
    // A copy: changing it changes nothing stored.
    v.buyer.email = 'x';
    expect(s.buyer.email).toBe('a@example.com');
  });
});

describe('what a buyer may change', () => {
  it('takes the buyer, ship-to, option, fulfillment, store and codes, and nothing else', () => {
    expect(
      hostedPatchSchema.safeParse({
        buyer: { email: ' a@example.com ', firstName: 'A' },
        shipTo: { line1: '1 Main', country: 'US' },
        shippingOption: null,
        fulfillment: 'pickup',
        pickupLocationId: 'loc_1',
        promoCodes: ['SAVE'],
      }),
    ).toMatchObject({ success: true, data: { buyer: { email: 'a@example.com' } } });
    expect(hostedPatchSchema.safeParse({}).success).toBe(true);
    for (const bad of [
      { lines: [{ sku: 'A', qty: 1 }] },
      { quote: {} },
      { total: 0 },
      { ownerId: 'x' },
      { status: 'completed' },
      { buyer: { email: 'a@example.com', price: 1 } },
      { shipTo: { line1: 'x', tax: 0 } },
      { fulfillment: 'digital' },
      { promoCodes: Array.from({ length: 11 }, (_, i) => `C${i}`) },
      { buyer: { email: 'x'.repeat(300) } },
      { buyer: { email: 'not an email' } },
      { buyer: { email: '' } },
    ])
      expect(hostedPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('takes lines too only through the wider schema, and a line has no price', () => {
    const lines = [{ id: 'li_1', sku: 'A', qty: 2 }];
    expect(hostedPatchWithLinesSchema.safeParse({ lines }).success).toBe(true);
    for (const line of [
      { sku: 'A', qty: 1, unitPrice: 1 },
      { sku: 'A', qty: 0 },
      { sku: 'A', qty: 10_001 },
      { sku: '', qty: 1 },
    ])
      expect(hostedPatchWithLinesSchema.safeParse({ lines: [line] }).success).toBe(false);
    expect(hostedPatchWithLinesSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(hostedPatchWithLinesSchema.safeParse({ quote: {} }).success).toBe(false);
    expect(hostedPatchWithLinesSchema.safeParse({ buyer: { email: 'nope' } }).success).toBe(false);
  });
});

describe('the storefront setting', () => {
  it('is off until an admin turns it on, and off again when it does not parse', () => {
    expect(readStorefrontSettings(null)).toEqual(STOREFRONT_OFF);
    expect(STOREFRONT_OFF).toEqual({
      checkout: { enabled: false, checkoutFlowId: null, editLines: false },
    });
    expect(readStorefrontSettings('{}')).toEqual(STOREFRONT_OFF);
    expect(readStorefrontSettings('not json')).toEqual(STOREFRONT_OFF);
    expect(readStorefrontSettings('{"checkout":{"enabled":"yes"}}')).toEqual(STOREFRONT_OFF);
    expect(
      readStorefrontSettings('{"checkout":{"enabled":true,"checkoutFlowId":"tpl-x"}}'),
    ).toEqual({ checkout: { enabled: true, checkoutFlowId: 'tpl-x', editLines: false } });
  });
});

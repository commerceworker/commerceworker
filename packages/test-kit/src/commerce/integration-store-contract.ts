/**
 * The behaviour every `IntegrationStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Ids start `in_`.
 */
import type { IntegrationStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { IntegrationFixture } from './integration-store';

export const INTEGRATION_FIXTURE: IntegrationFixture = {
  integrations: [
    { id: 'in_erp', name: 'ERP', secret: 'sealed-erp', createdAt: 1, channel: 'edi' },
    { id: 'in_old', name: 'Old', secret: 'sealed-old', createdAt: 2, revokedAt: 3 },
  ],
};

export function describeIntegrationStoreContract(
  name: string,
  make: (fixture: IntegrationFixture) => Promise<IntegrationStore>,
) {
  describe(`${name}: the integration store contract`, () => {
    const fresh = () => make(INTEGRATION_FIXTURE);
    const mine = <T extends { id: string }>(xs: T[]) => xs.filter((x) => x.id.startsWith('in_'));

    it('adds an integration and lists every one newest first, never with a secret', async () => {
      const s = await fresh();
      await s.add({
        id: 'in_shop',
        name: 'Shop',
        secret: 'sealed-shop',
        events: '["order.start"]',
        startOrders: true,
        flows: '["f_web"]',
        channel: null,
        createdAt: 5,
        createdBy: 'ada@example.com',
      });
      const listed = mine(await s.list(10));
      expect(listed.map((x) => x.id)).toEqual(['in_shop', 'in_old', 'in_erp']);
      expect(listed[0]).toEqual({
        id: 'in_shop',
        name: 'Shop',
        events: '["order.start"]',
        startOrders: true,
        flows: '["f_web"]',
        channel: null,
        createdAt: 5,
        createdBy: 'ada@example.com',
        lastUsedAt: null,
        revokedAt: null,
        previousExpiresAt: null,
      });
      expect(JSON.stringify(listed)).not.toContain('sealed-');
    });

    it('reads a live integration with its secrets, and none once revoked', async () => {
      const s = await fresh();
      expect(await s.active('in_erp')).toMatchObject({
        secret: 'sealed-erp',
        previousSecret: null,
        channel: 'edi',
      });
      expect(await s.active('in_old')).toBeUndefined();
      expect(await s.active('in_none')).toBeUndefined();
      await s.touch('in_erp', 9);
      expect((await s.active('in_erp'))?.lastUsedAt).toBe(9);
    });

    it('rotates a live secret, the current one working until the grace ends', async () => {
      const s = await fresh();
      expect(await s.rotate('in_erp', 'sealed-next', 99)).toMatchObject({
        id: 'in_erp',
        previousExpiresAt: 99,
      });
      expect(await s.active('in_erp')).toMatchObject({
        secret: 'sealed-next',
        previousSecret: 'sealed-erp',
      });
      expect(await s.rotate('in_old', 'x', 1)).toBeUndefined();
      expect(await s.rotate('in_none', 'x', 1)).toBeUndefined();
    });

    it('revokes once, both secrets with it', async () => {
      const s = await fresh();
      await s.rotate('in_erp', 'sealed-next', 99);
      expect(await s.revoke('in_erp', 50)).toMatchObject({
        revokedAt: 50,
        previousExpiresAt: null,
      });
      expect(await s.revoke('in_erp', 60)).toBeUndefined();
      expect(await s.active('in_erp')).toBeUndefined();
      expect(mine(await s.list(10)).find((x) => x.id === 'in_erp')?.revokedAt).toBe(50);
    });
  });
}

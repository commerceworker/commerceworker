import { secretContext } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
/** Sealing, as a reversible marker, so opening is checked against the context it was sealed for. */
vi.mock('~/lib/data-key.server', () => ({
  sealSecret: async (secret: string, context: string) => `sealed(${context}):${secret}`,
  openSecret: async (sealed: string, context: string) => {
    const prefix = `sealed(${context}):`;
    if (!sealed.startsWith(prefix)) throw new Error('sealed for another row');
    return sealed.slice(prefix.length);
  },
}));

const { InMemoryIntegrationStore, InMemoryOrderRecords } = await import(
  '@commerceworker/test-kit/commerce'
);
let store = new InMemoryIntegrationStore();
let orders = new InMemoryOrderRecords();
vi.mock('~/lib/wire.server', () => ({
  integrationStore: () => store,
  orderRecords: () => orders,
}));

const {
  createIntegration,
  findIntegration,
  listIntegrations,
  orderChannel,
  revokeIntegration,
  rotateIntegration,
} = await import('~/lib/integrations.server');

const input = { name: 'ERP', events: ['order.start'], startOrders: true, flows: ['f_web'] };

beforeEach(() => {
  store = new InMemoryIntegrationStore();
  orders = new InMemoryOrderRecords({ orders: ['ord_1'], channels: { ord_1: 'edi' } });
});

describe('integrations', () => {
  it('hands the secret over once and never lists it; a signature opens it again', async () => {
    const { integration, secret } = await createIntegration(input as never, 'ada@example.com');
    expect(integration).toMatchObject({
      name: 'ERP',
      events: ['order.start'],
      startOrders: true,
      flows: ['f_web'],
      channel: null,
      previousExpiresAt: null,
    });
    expect(JSON.stringify(await listIntegrations())).not.toContain(secret);
    expect((await store.active(integration.id))?.secret).toBe(
      `sealed(${secretContext.integration(integration.id)}):${secret}`,
    );
    expect(await findIntegration(integration.id)).toMatchObject({
      secret,
      previousSecret: null,
      events: ['order.start'],
    });
  });

  it('rotates with the old secret still working, and revokes both, once', async () => {
    const { integration, secret: first } = await createIntegration(input as never, 'ada');
    const rotated = await rotateIntegration(integration.id);
    expect(rotated?.integration.previousExpiresAt).toEqual(expect.any(Number));
    expect(await findIntegration(integration.id)).toMatchObject({
      secret: rotated?.secret,
      previousSecret: first,
    });
    expect(await revokeIntegration(integration.id)).toMatchObject({
      revokedAt: expect.any(Number),
    });
    expect(await revokeIntegration(integration.id)).toBeNull();
    expect(await findIntegration(integration.id)).toBeNull();
    expect(await rotateIntegration(integration.id)).toBeNull();
    expect(await rotateIntegration('int_none')).toBeNull();
  });

  it("reads an order's channel, and none for an unknown order", async () => {
    expect(await orderChannel('ord_1')).toBe('edi');
    expect(await orderChannel('ord_none')).toBeNull();
  });
});

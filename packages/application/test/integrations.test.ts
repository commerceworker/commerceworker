import { InMemoryIntegrationStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  getIntegration,
  listIntegrations,
  revokeIntegration,
  revokeIntegrationProblem,
} from '../src/commerce';

const now = Date.UTC(2026, 10, 9);
const row = (id: string, createdAt: number, more: object = {}) => ({
  id,
  name: `Name ${id}`,
  secret: 'sealed-current',
  previousSecret: 'sealed-previous',
  events: JSON.stringify(['payment.received']),
  flows: JSON.stringify(['tpl-b2b-order']),
  startOrders: true,
  channel: 'web',
  createdAt,
  ...more,
});

describe('listIntegrations', () => {
  it('lists newest first with the scope parsed, and never a secret', async () => {
    const integrations = new InMemoryIntegrationStore({
      integrations: [row('int_old', 1), row('int_new', 2)],
    });
    const list = await listIntegrations({ integrations }, now);
    expect(list.map((i) => i.id)).toEqual(['int_new', 'int_old']);
    expect(list[0]).toMatchObject({
      events: ['payment.received'],
      flows: ['tpl-b2b-order'],
      startOrders: true,
      channel: 'web',
    });
    expect(JSON.stringify(list)).not.toMatch(/secret|sealed/i);
  });

  it('shows previousExpiresAt only while it is still ahead of now', async () => {
    const integrations = new InMemoryIntegrationStore({
      integrations: [
        row('int_open', 1, { previousExpiresAt: now + 1000 }),
        row('int_ended', 2, { previousExpiresAt: now - 1000 }),
        row('int_none', 3),
      ],
    });
    const byId = Object.fromEntries(
      (await listIntegrations({ integrations }, now)).map((i) => [i.id, i.previousExpiresAt]),
    );
    expect(byId).toEqual({ int_open: now + 1000, int_ended: null, int_none: null });
  });
});

describe('revokeIntegration', () => {
  it('revokes once, naming the integration in the audit event, and keeps the row', async () => {
    const integrations = new InMemoryIntegrationStore({ integrations: [row('int_a', 1)] });
    const r = await revokeIntegration({ integrations }, 'int_a', now);
    expect(r).toMatchObject({
      ok: true,
      integration: { id: 'int_a', revokedAt: now },
      audit: { action: 'integration.revoked', target: 'Name int_a', detail: { id: 'int_a' } },
    });
    expect(JSON.stringify(r)).not.toMatch(/secret|sealed/i);
    // The row stays for the audit log, revoked, and its secrets no longer work.
    expect(await getIntegration({ integrations }, 'int_a', now)).toMatchObject({ revokedAt: now });
    expect(await integrations.active('int_a')).toBeUndefined();
  });

  it('refuses an unknown or already revoked integration, and says which', async () => {
    const integrations = new InMemoryIntegrationStore({ integrations: [row('int_a', 1)] });
    await revokeIntegration({ integrations }, 'int_a', now);
    expect(await revokeIntegration({ integrations }, 'int_a', now + 1)).toEqual({
      ok: false,
      error: 'Name int_a is already revoked.',
    });
    expect(await revokeIntegration({ integrations }, 'int_none', now)).toEqual({
      ok: false,
      error: 'No integration int_none.',
    });
    // The first revoke's time stands.
    expect(await getIntegration({ integrations }, 'int_a', now)).toMatchObject({ revokedAt: now });
    expect(await revokeIntegrationProblem({ integrations }, 'int_a', now)).toBe(
      'Name int_a is already revoked.',
    );
  });
});

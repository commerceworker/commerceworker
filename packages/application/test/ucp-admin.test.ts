import { storefrontOrderFlow, UCP_OFF, UCP_SETTINGS_KEY } from '@commerceworker/core';
import {
  InMemoryFlowStore,
  InMemoryUcpStore,
  InMemoryWorkspaceStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  changeUcpSettings,
  checkoutFlowRefusal,
  getUcpAdmin,
  getUcpPlatform,
  planUcpSettings,
  readUcpAdminSettings,
  revokeUcpPlatform,
} from '../src/commerce';

const now = Date.UTC(2026, 10, 9);

/** A checkout flow that takes cards, one that never authorizes, and one that was never published. */
async function setup(settings?: object) {
  const flows = new InMemoryFlowStore();
  const store = storefrontOrderFlow();
  await flows.publish({ ...store, id: 'tpl-checkout' } as never);
  await flows.publish({ ...store, id: 'tpl-no-card', nodes: [], edges: [] } as never);
  await flows.saveDraft({ ...store, id: 'tpl-draft' } as never);
  const workspace = new InMemoryWorkspaceStore({
    settings: settings ? { [UCP_SETTINGS_KEY]: JSON.stringify(settings) } : {},
  });
  const ucp = new InMemoryUcpStore({
    platforms: [
      { id: 'ucp_a', name: 'Shopper', keyHash: 'hash-a', createdAt: 2 },
      { id: 'ucp_b', name: 'Other', keyHash: 'hash-b', createdAt: 1 },
    ],
  });
  return { flows, workspace, ucp };
}

describe('agentic checkout’s settings', () => {
  it('are off until set, and read from the store each time', async () => {
    const ports = await setup();
    expect(await readUcpAdminSettings(ports)).toEqual(UCP_OFF);
    await ports.workspace.setSetting(
      UCP_SETTINGS_KEY,
      JSON.stringify({ checkoutFlowId: 'tpl-checkout' }),
      'ann',
    );
    expect((await readUcpAdminSettings(ports)).checkoutFlowId).toBe('tpl-checkout');
  });

  it('shows the settings with the platforms, and never a key', async () => {
    const ports = await setup({ checkoutFlowId: 'tpl-checkout' });
    const admin = await getUcpAdmin(ports);
    expect(admin.settings.checkoutFlowId).toBe('tpl-checkout');
    expect(admin.platforms.map((p) => p.id)).toEqual(['ucp_a', 'ucp_b']);
    expect(JSON.stringify(admin)).not.toMatch(/hash-|keyHash/);
  });

  it('saves them once the flow takes cards, and names the flow they switch in the audit event', async () => {
    const ports = await setup();
    const next = { checkoutFlowId: 'tpl-checkout', links: [], orderUrl: null, productUrl: null };
    const r = await changeUcpSettings(ports, next, 'ann@example.com');
    expect(r).toEqual({
      ok: true,
      settings: next,
      audit: { action: 'ucp.settings', detail: { from: null, to: 'tpl-checkout' } },
    });
    expect(await readUcpAdminSettings(ports)).toEqual(next);
    expect(await ports.workspace.settingRecord(UCP_SETTINGS_KEY)).toMatchObject({
      updatedBy: 'ann@example.com',
    });
    // Turning it off needs no flow, and records where from.
    const off = await changeUcpSettings(ports, UCP_OFF, 'ann@example.com');
    expect(off).toMatchObject({ audit: { detail: { from: 'tpl-checkout', to: null } } });
    expect(await readUcpAdminSettings(ports)).toEqual(UCP_OFF);
  });

  it('refuses a flow that is unknown, unpublished or never holds a card, and writes nothing', async () => {
    const ports = await setup({ checkoutFlowId: 'tpl-checkout' });
    for (const [flowId, why] of [
      ['tpl-nope', 'No published flow tpl-nope'],
      ['tpl-draft', 'No published flow tpl-draft'],
      ['tpl-no-card', 'The checkout flow must authorize the payment (commerce.authorize_payment).'],
    ] as const) {
      const next = { checkoutFlowId: flowId, links: [], orderUrl: null, productUrl: null };
      expect(await checkoutFlowRefusal(ports, flowId)).toBe(why);
      expect(await planUcpSettings(ports, next)).toMatchObject({ refusal: why });
      expect(await changeUcpSettings(ports, next, 'ann')).toEqual({ ok: false, error: why });
    }
    expect((await readUcpAdminSettings(ports)).checkoutFlowId).toBe('tpl-checkout');
  });
});

describe('revokeUcpPlatform', () => {
  it('revokes once, naming the platform in the audit event, and keeps the row', async () => {
    const ports = await setup();
    expect(await revokeUcpPlatform(ports, 'ucp_a', now)).toEqual({
      ok: true,
      audit: { action: 'ucp.platform_revoked', target: 'Shopper', detail: { id: 'ucp_a' } },
    });
    expect(await getUcpPlatform(ports, 'ucp_a')).toMatchObject({ revokedAt: now });
    // Its key no longer lets it in; the other platform is untouched.
    expect(await ports.ucp.livePlatform('hash-a')).toBeUndefined();
    expect(await ports.ucp.livePlatform('hash-b')).toMatchObject({ id: 'ucp_b' });
  });

  it('refuses an unknown or already revoked platform, and says which', async () => {
    const ports = await setup();
    await revokeUcpPlatform(ports, 'ucp_a', now);
    expect(await revokeUcpPlatform(ports, 'ucp_a', now + 1)).toEqual({
      ok: false,
      error: 'Shopper is already revoked.',
    });
    expect(await revokeUcpPlatform(ports, 'ucp_none', now)).toEqual({
      ok: false,
      error: 'No platform ucp_none.',
    });
    expect(await getUcpPlatform(ports, 'ucp_a')).toMatchObject({ revokedAt: now });
  });
});

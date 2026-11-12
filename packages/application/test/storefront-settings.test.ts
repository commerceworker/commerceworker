import {
  STOREFRONT_OFF,
  STOREFRONT_SETTINGS_KEY,
  storefrontOrderFlow,
  UCP_SETTINGS_KEY,
} from '@commerceworker/core';
import { InMemoryFlowStore, InMemoryWorkspaceStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  changeStorefrontSettings,
  planStorefrontSettings,
  readStorefrontAdminSettings,
} from '../src/commerce';

/** A flow that takes cards, one that never authorizes, and one that was never published. */
async function setup(ucpFlow?: string) {
  const flows = new InMemoryFlowStore();
  const store = storefrontOrderFlow();
  await flows.publish({ ...store, id: 'tpl-card' } as never);
  await flows.publish({ ...store, id: 'tpl-no-card', nodes: [], edges: [] } as never);
  await flows.saveDraft({ ...store, id: 'tpl-draft' } as never);
  const workspace = new InMemoryWorkspaceStore({
    settings: ucpFlow ? { [UCP_SETTINGS_KEY]: JSON.stringify({ checkoutFlowId: ucpFlow }) } : {},
  });
  return { flows, workspace };
}

const on = (checkoutFlowId: string | null, editLines = false, storeName: string | null = null) => ({
  storeName,
  checkout: { enabled: true, checkoutFlowId, editLines },
});

describe('hosted checkout’s settings', () => {
  it('are off until set, and read from the store each time', async () => {
    const ports = await setup();
    expect(await readStorefrontAdminSettings(ports)).toEqual(STOREFRONT_OFF);
    await ports.workspace.setSetting(
      STOREFRONT_SETTINGS_KEY,
      JSON.stringify(on('tpl-card', true)),
      'ann',
    );
    expect(await readStorefrontAdminSettings(ports)).toEqual(on('tpl-card', true));
    // A row that doesn't parse reads as off, never as on.
    await ports.workspace.setSetting(
      STOREFRONT_SETTINGS_KEY,
      '{"checkout":{"enabled":"yes"}}',
      'ann',
    );
    expect(await readStorefrontAdminSettings(ports)).toEqual(STOREFRONT_OFF);
  });

  it('turn on for a flow that takes cards, and audit what was switched', async () => {
    const ports = await setup();
    const r = await changeStorefrontSettings(ports, on('tpl-card', true), 'ann@example.com');
    expect(r).toEqual({
      ok: true,
      settings: on('tpl-card', true),
      audit: {
        action: 'checkout.settings',
        detail: {
          enabled: true,
          flow: 'tpl-card',
          fromFlow: null,
          editLines: true,
          wasEnabled: false,
          storeName: null,
          fromStoreName: null,
        },
      },
    });
    expect(await readStorefrontAdminSettings(ports)).toEqual(on('tpl-card', true));
    expect(await ports.workspace.settingRecord(STOREFRONT_SETTINGS_KEY)).toMatchObject({
      updatedBy: 'ann@example.com',
    });
    // Off needs no flow, and records that it was on.
    const off = await changeStorefrontSettings(ports, STOREFRONT_OFF, 'ann@example.com');
    expect(off).toMatchObject({
      ok: true,
      audit: { detail: { enabled: false, wasEnabled: true, fromFlow: 'tpl-card' } },
    });
    expect(await readStorefrontAdminSettings(ports)).toEqual(STOREFRONT_OFF);
  });

  it('keep the store name beside the switches, and audit what it was', async () => {
    const ports = await setup();
    const named = on('tpl-card', false, 'Acme Supply');
    expect(await changeStorefrontSettings(ports, named, 'ann')).toMatchObject({
      ok: true,
      audit: { detail: { storeName: 'Acme Supply', fromStoreName: null } },
    });
    expect(await readStorefrontAdminSettings(ports)).toEqual(named);
    // Left out, the name is kept (and audited as unchanged); null clears it; a string sets it.
    const { storeName: _left, ...without } = on('tpl-card', true);
    expect(await planStorefrontSettings(ports, without)).toMatchObject({
      next: { storeName: 'Acme Supply' },
    });
    expect(await changeStorefrontSettings(ports, without, 'ann')).toMatchObject({
      ok: true,
      settings: { storeName: 'Acme Supply' },
      audit: { detail: { storeName: 'Acme Supply', fromStoreName: 'Acme Supply' } },
    });
    expect((await readStorefrontAdminSettings(ports)).storeName).toBe('Acme Supply');
    // Renaming is audited from the old name; clearing it goes back to a nameless storefront.
    expect(
      await changeStorefrontSettings(ports, on('tpl-card', false, 'Acme & Sons'), 'ann'),
    ).toMatchObject({
      audit: { detail: { storeName: 'Acme & Sons', fromStoreName: 'Acme Supply' } },
    });
    await changeStorefrontSettings(ports, on('tpl-card'), 'ann');
    expect((await readStorefrontAdminSettings(ports)).storeName).toBeNull();
    // An explicit null clears it, where a left-out name did not.
    // A refused change (no card on the flow) leaves the name alone too.
    await changeStorefrontSettings(ports, named, 'ann');
    expect(
      await changeStorefrontSettings(ports, on('tpl-no-card', false, 'Other'), 'ann'),
    ).toMatchObject({ ok: false });
    expect((await readStorefrontAdminSettings(ports)).storeName).toBe('Acme Supply');
  });

  it('refuse a flow that is unknown, unpublished or never holds a card, and write nothing', async () => {
    const ports = await setup();
    for (const [flowId, why] of [
      ['tpl-nope', 'No published flow tpl-nope'],
      ['tpl-draft', 'No published flow tpl-draft'],
      ['tpl-no-card', 'The checkout flow must authorize the payment (commerce.authorize_payment).'],
    ] as const) {
      expect(await planStorefrontSettings(ports, on(flowId))).toMatchObject({ refusal: why });
      expect(await changeStorefrontSettings(ports, on(flowId), 'ann')).toEqual({
        ok: false,
        error: why,
      });
    }
    expect(await readStorefrontAdminSettings(ports)).toEqual(STOREFRONT_OFF);
  });

  it('price by agentic checkout’s flow when none is chosen, which must take cards too', async () => {
    // None chosen and none for agentic checkout: nothing to price with.
    const none = await setup();
    expect(await changeStorefrontSettings(none, on(null), 'ann')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Choose a checkout flow/),
    });
    // Agentic checkout's flow takes a card: on.
    const card = await setup('tpl-card');
    expect(await planStorefrontSettings(card, on(null))).toMatchObject({
      flowId: 'tpl-card',
      refusal: null,
    });
    expect(await changeStorefrontSettings(card, on(null), 'ann')).toMatchObject({ ok: true });
    // Its flow can't take a card: refused as a chosen one would be.
    const bad = await setup('tpl-no-card');
    expect(await changeStorefrontSettings(bad, on(null), 'ann')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must authorize the payment/),
    });
  });

  it('keep a flow chosen while off without checking it, and check it when turned on', async () => {
    const ports = await setup();
    const parked = {
      checkout: { enabled: false, checkoutFlowId: 'tpl-no-card', editLines: false },
    };
    expect(await changeStorefrontSettings(ports, parked, 'ann')).toMatchObject({ ok: true });
    expect(await changeStorefrontSettings(ports, on('tpl-no-card'), 'ann')).toMatchObject({
      ok: false,
    });
  });
});

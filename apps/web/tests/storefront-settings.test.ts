import { storefrontOrderFlow } from '@commerceworker/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const kit = await import('@commerceworker/test-kit/commerce');
const stores = { workspace: new kit.InMemoryWorkspaceStore(), flows: new kit.InMemoryFlowStore() };
vi.mock('~/lib/wire.server', () => ({
  workspaceStore: () => stores.workspace,
  flowStore: () => stores.flows,
}));

const { StorefrontSettingsForm, saveStorefrontSettings, storefrontInput } = await import(
  '../app/components/storefront-settings'
);
const { AssistantProvider } = await import('../app/lib/assistant');
const { setStorefrontSettings, storefrontAdmin } = await import('../app/lib/storefront.server');

const render = (Component: () => React.ReactNode) => {
  const Stub = createRoutesStub([{ path: '/team', Component }]);
  return renderToString(createElement(Stub, { initialEntries: ['/team'] }));
};

const flows = [
  { id: 'tpl-card', name: 'Storefront order' },
  { id: 'tpl-b2b', name: 'B2B order' },
];
const form = (settings: Parameters<typeof StorefrontSettingsForm>[0]['settings']) =>
  render(() =>
    createElement(
      AssistantProvider,
      null,
      createElement(StorefrontSettingsForm, { settings, flows }),
    ),
  );

describe('the hosted checkout section of the settings page', () => {
  it('shows hosted checkout off, with no Save until something changes', () => {
    const html = form({ checkout: { enabled: false, checkoutFlowId: null, editLines: false } });
    expect(html).toContain('Hosted checkout');
    expect(html).toContain('Turn on hosted checkout');
    expect(html).toContain('Let buyers change the lines');
    // Both flows are offered, and "the flow agentic checkout uses" is the chosen one.
    expect(html).toContain('Storefront order');
    expect(html).toContain('B2B order');
    expect(html).toMatch(
      /<option[^>]*value=""[^>]*selected=""[^>]*>The flow agentic checkout uses/,
    );
    expect(html).not.toMatch(/id="hosted-enabled"[^>]*checked/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
  });

  it('shows what is saved: on, its flow, and whether buyers may change lines', () => {
    const html = form({
      checkout: { enabled: true, checkoutFlowId: 'tpl-b2b', editLines: true },
    });
    expect(html).toMatch(/id="hosted-enabled"[^>]*checked/);
    expect(html).toMatch(/id="hosted-edit-lines"[^>]*checked/);
    expect(html).toMatch(/<option[^>]*value="tpl-b2b"[^>]*selected=""[^>]*>B2B order/);
  });

  it('sends the tool what the form holds, the agentic flow as null', () => {
    expect(storefrontInput({ enabled: true, flowId: '', editLines: false })).toEqual({
      checkout: { enabled: true, checkoutFlowId: null, editLines: false },
    });
    expect(storefrontInput({ enabled: false, flowId: 'tpl-card', editLines: true })).toEqual({
      checkout: { enabled: false, checkoutFlowId: 'tpl-card', editLines: true },
    });
  });
});

describe('saving the settings', () => {
  beforeEach(async () => {
    stores.workspace = new kit.InMemoryWorkspaceStore();
    stores.flows = new kit.InMemoryFlowStore();
    await stores.flows.seed([
      { ...storefrontOrderFlow(), id: 'tpl-card' },
      { ...storefrontOrderFlow(), id: 'tpl-no-card', nodes: [], edges: [] },
    ] as never);
  });

  it('is off until saved, and turned on for a flow that takes cards', async () => {
    expect(await storefrontAdmin()).toEqual({
      checkout: { enabled: false, checkoutFlowId: null, editLines: false },
    });
    const next = { checkout: { enabled: true, checkoutFlowId: 'tpl-card', editLines: true } };
    expect(await setStorefrontSettings(next, 'ann@example.com')).toMatchObject({ ok: true });
    expect(await storefrontAdmin()).toEqual(next);
  });

  it('refuses a flow that cannot take a card when turning it on, and saves nothing', async () => {
    const next = { checkout: { enabled: true, checkoutFlowId: 'tpl-no-card', editLines: false } };
    expect(await setStorefrontSettings(next, 'ann')).toEqual({
      ok: false,
      error: 'The checkout flow must authorize the payment (commerce.authorize_payment).',
    });
    expect((await storefrontAdmin()).checkout.enabled).toBe(false);
  });
});

describe('Save', () => {
  const form = { enabled: true, flowId: 'tpl-card', editLines: false };
  const input = { checkout: { enabled: true, checkoutFlowId: 'tpl-card', editLines: false } };

  it('asks the assistant to set it, with the form’s choices, and says it saved', async () => {
    const act = vi.fn(async () => ({ done: 'Saved hosted checkout' }));
    expect(await saveStorefrontSettings(act, form)).toEqual({ saved: true });
    expect(act).toHaveBeenCalledOnce();
    expect(act).toHaveBeenCalledWith('set_storefront_settings', input);
  });

  it('leaves the settings as they were when the card is declined, or the call is refused', async () => {
    expect(
      await saveStorefrontSettings(
        vi.fn(async () => ({ declined: true })),
        form,
      ),
    ).toEqual({
      saved: false,
    });
    const blocked = vi.fn(async () => {
      throw new Error('The checkout flow must authorize the payment (commerce.authorize_payment).');
    });
    expect(await saveStorefrontSettings(blocked, form)).toEqual({
      saved: false,
      error: 'The checkout flow must authorize the payment (commerce.authorize_payment).',
    });
    // Nothing was written by either: the settings are still off.
    expect((await storefrontAdmin()).checkout.enabled).toBe(false);
  });
});

describe('a flow that is saved but no longer published', () => {
  it('stays in the list, marked, and is the chosen one', () => {
    const html = form({
      checkout: { enabled: true, checkoutFlowId: 'tpl-gone', editLines: false },
    });
    expect(html).toMatch(
      /<option[^>]*value="tpl-gone"[^>]*selected=""[^>]*>tpl-gone(<!-- -->)? \(not published\)/,
    );
  });
});

describe('the section’s descriptions', () => {
  it('are tied to the controls they describe', () => {
    const html = form({ checkout: { enabled: false, checkoutFlowId: null, editLines: false } });
    for (const [control, hint] of [
      ['hosted-enabled', 'hosted-enabled-hint'],
      ['hosted-flow', 'hosted-flow-hint'],
      ['hosted-edit-lines', 'hosted-edit-lines-hint'],
    ] as const) {
      expect(html).toMatch(
        new RegExp(
          `id="${control}"[^>]*aria-describedby="${hint}"|aria-describedby="${hint}"[^>]*id="${control}"`,
        ),
      );
      expect(html).toContain(`id="${hint}"`);
    }
    expect(html).toContain(
      'Outside test mode the page takes details only; buyers can’t pay on it yet.',
    );
    expect(html).toContain('When it is off, the links you made stop working');
  });
});

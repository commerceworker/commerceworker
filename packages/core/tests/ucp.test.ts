import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  businessProfile,
  CATALOG_LOOKUP_CAPABILITY,
  CATALOG_SEARCH_CAPABILITY,
  CHECKOUT_CAPABILITY,
  CHECKOUT_TTL_MS,
  type CheckoutSession,
  checkoutPatch,
  contentDigest,
  DISCOUNT_CAPABILITY,
  digestMatches,
  discountView,
  FULFILLMENT_CAPABILITY,
  importSigningKey,
  importVerifyKey,
  missingInfo,
  negotiate,
  ORDER_CAPABILITY,
  type Order,
  orderPermalink,
  parseDictionary,
  parsePlatformProfile,
  pickupLineIssues,
  protocolIssues,
  publicJwk,
  readUcpSettings,
  selectedInstrument,
  serializeDictionary,
  signMessage,
  toUcpCheckout,
  toUcpOrder,
  UCP_OFF,
  UCP_VERSION,
  type UcpCapability,
  type UcpPaymentHandler,
  ucpAgentProfile,
  ucpCheckoutInput,
  ucpCompleteInput,
  ucpErrorResponse,
  ucpSettingsSchema,
  verifyMessage,
} from '../src';

// ── The published schemas (tests/fixtures/ucp), for checking what we serve ──

const ROOT = join(__dirname, 'fixtures/ucp/schemas');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.json') ? [p] : [];
  });
const schemas = files(ROOT).map((p) => JSON.parse(readFileSync(p, 'utf8')) as { $id: string });

function conformsTo(ref: string, value: unknown) {
  const v = new Validator({ $ref: `https://ucp.dev/schemas/${ref}` }, '2020-12', false);
  for (const s of schemas) v.addSchema(s as never, s.$id);
  const r = v.validate(value);
  return r.valid ? [] : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}

const ORIGIN = 'https://shop.example';

const handler: UcpPaymentHandler = {
  name: 'com.commerceworker.stripe',
  id: 'stripe',
  version: UCP_VERSION,
  spec: 'https://docs.commerceworker.com/reference/ucp/',
  schema: 'https://commerceworker.com/ucp/handlers/stripe.json',
  available_instruments: [{ type: 'card' }],
  config: { publishable_key: 'pk_test_123' },
};

const all = new Map<UcpCapability, string>([
  [CHECKOUT_CAPABILITY, UCP_VERSION],
  [FULFILLMENT_CAPABILITY, UCP_VERSION],
  [ORDER_CAPABILITY, UCP_VERSION],
]);

const platformDoc = (caps: Record<string, unknown>, version = UCP_VERSION) => ({
  ucp: {
    version,
    services: {},
    payment_handlers: {},
    capabilities: caps,
  },
});

describe('schema fixtures', () => {
  it('reject what the schemas do not allow', () => {
    expect(conformsTo('shopping/order.json', {}).length).toBeGreaterThan(0);
    expect(
      conformsTo('shopping/checkout.json', {
        ...toUcpCheckout(session(), view),
        status: 'paid',
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('structured fields', () => {
  it('reads UCP-Agent and refuses what is not a dictionary of strings', () => {
    expect(ucpAgentProfile('profile="https://agent.example/p.json"')).toBe(
      'https://agent.example/p.json',
    );
    expect(ucpAgentProfile('profile="http://agent.example/p.json"')).toBeNull();
    expect(ucpAgentProfile('profile=https://agent.example')).toBeNull();
    expect(ucpAgentProfile('profile="https://a.example", ')).toBeNull();
    expect(ucpAgentProfile(null)).toBeNull();
  });

  it('round-trips inner lists with parameters', () => {
    const header =
      'sig1=("@method" "@authority" "content-digest");created=1700000000;keyid="k-1", sig2=:AQID:';
    const dict = parseDictionary(header)!;
    expect(serializeDictionary(dict)).toBe(header);
  });
});

describe('message signatures', () => {
  it('signs a webhook that verifies with the published key, and fails once altered', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] };
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'k-1' };
    const published = publicJwk(jwk as never);
    expect(published).toMatchObject({ kid: 'k-1', kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(published).not.toHaveProperty('d');

    const body = JSON.stringify({ id: 'ord_1' });
    const headers = new Headers({
      'content-type': 'application/json',
      'content-digest': await contentDigest(body),
      'ucp-agent': `profile="${ORIGIN}/.well-known/ucp"`,
    });
    const msg = { method: 'POST', url: 'https://agent.example/hooks/orders', headers };
    const components = [
      '@method',
      '@authority',
      '@path',
      'content-digest',
      'content-type',
      'ucp-agent',
    ];
    const sig = await signMessage(msg, components, await importSigningKey(jwk as never), 'k-1');
    headers.set('signature-input', sig.signatureInput);
    headers.set('signature', sig.signature);

    const key = await importVerifyKey(published);
    const keyFor = async (id: string) => (id === 'k-1' ? key : null);
    expect(await verifyMessage(msg, keyFor, ['content-digest'])).toMatchObject({ ok: true });
    expect(await digestMatches(headers.get('content-digest'), body)).toBe(true);
    expect(await digestMatches(headers.get('content-digest'), `${body} `)).toBe(false);

    const moved = { ...msg, url: 'https://agent.example/hooks/other' };
    expect(await verifyMessage(moved, keyFor)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    expect(await verifyMessage(msg, async () => null)).toMatchObject({ ok: false });
    expect(await verifyMessage(msg, keyFor, ['idempotency-key'])).toMatchObject({ ok: false });
  });
});

describe('profiles and negotiation', () => {
  it('publishes a business profile the schema accepts', () => {
    const profile = businessProfile(
      ORIGIN,
      [handler],
      [{ kid: 'k-1', kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256', use: 'sig' }],
    );
    expect(conformsTo('profile.json#/$defs/business_schema', profile)).toEqual([]);
    expect(profile.ucp.services['dev.ucp.shopping'].map((s) => s.endpoint)).toEqual([
      `${ORIGIN}/ucp/v1`,
      `${ORIGIN}/ucp/mcp`,
    ]);
  });

  it('activates what both sides list and prunes an orphaned extension', () => {
    const entry = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
    const p = parsePlatformProfile(
      platformDoc({
        [FULFILLMENT_CAPABILITY]: [{ ...entry, extends: CHECKOUT_CAPABILITY }],
        [ORDER_CAPABILITY]: [{ ...entry, config: { webhook_url: 'https://agent.example/hooks' } }],
      }),
    );
    if ('problem' in p) throw new Error(p.problem);
    expect(p.webhookUrl).toBe('https://agent.example/hooks');
    const n = negotiate(p);
    expect(n.ok && [...n.capabilities.keys()]).toEqual([ORDER_CAPABILITY]);
  });

  it('lists the discount extension on checkout and activates it only beside checkout', () => {
    const profile = businessProfile(ORIGIN, [handler], []);
    expect(profile.ucp.capabilities[DISCOUNT_CAPABILITY]).toEqual([
      expect.objectContaining({
        version: UCP_VERSION,
        extends: CHECKOUT_CAPABILITY,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/discount.json`,
      }),
    ]);
    const entry = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
    const negotiated = (caps: Record<string, unknown>) => {
      const p = parsePlatformProfile(platformDoc(caps));
      if ('problem' in p) throw new Error(p.problem);
      const n = negotiate(p);
      return n.ok ? [...n.capabilities.keys()] : n.code;
    };
    expect(
      negotiated({
        [CHECKOUT_CAPABILITY]: [entry],
        [DISCOUNT_CAPABILITY]: [{ ...entry, extends: CHECKOUT_CAPABILITY }],
      }),
    ).toEqual([CHECKOUT_CAPABILITY, DISCOUNT_CAPABILITY]);
    // Without checkout the extension has no parent, and nothing else is shared.
    expect(
      negotiated({ [DISCOUNT_CAPABILITY]: [{ ...entry, extends: CHECKOUT_CAPABILITY }] }),
    ).toBe('capabilities_incompatible');
  });

  it('lists the catalog capabilities, each with the schema its service spec points at', () => {
    const profile = businessProfile(ORIGIN, [handler], []);
    expect(profile.ucp.capabilities[CATALOG_SEARCH_CAPABILITY]).toEqual([
      expect.objectContaining({
        version: UCP_VERSION,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`,
      }),
    ]);
    expect(profile.ucp.capabilities[CATALOG_LOOKUP_CAPABILITY]).toEqual([
      expect.objectContaining({
        version: UCP_VERSION,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`,
      }),
    ]);
    // Neither extends checkout: a platform can negotiate them alone.
    expect(JSON.stringify(profile.ucp.capabilities[CATALOG_SEARCH_CAPABILITY])).not.toContain(
      'extends',
    );
    // The names are the ones the vendored capability schemas declare.
    const named = (id: string) =>
      (schemas as { $id: string; name?: string }[]).find((s) => s.$id.endsWith(id))?.name;
    expect(named('/shopping/catalog_search.json')).toBe(CATALOG_SEARCH_CAPABILITY);
    expect(named('/shopping/catalog_lookup.json')).toBe(CATALOG_LOOKUP_CAPABILITY);
    expect(conformsTo('profile.json#/$defs/business_schema', profile)).toEqual([]);
  });

  it('activates the catalog capabilities a platform lists, on their own, and no others', () => {
    const entry = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
    const negotiated = (caps: Record<string, unknown>) => {
      const p = parsePlatformProfile(platformDoc(caps));
      if ('problem' in p) throw new Error(p.problem);
      const n = negotiate(p);
      return n.ok ? [...n.capabilities.keys()] : n.code;
    };
    expect(negotiated({ [CATALOG_SEARCH_CAPABILITY]: [entry] })).toEqual([
      CATALOG_SEARCH_CAPABILITY,
    ]);
    expect(
      negotiated({
        [CHECKOUT_CAPABILITY]: [entry],
        [CATALOG_LOOKUP_CAPABILITY]: [entry],
      }),
    ).toEqual([CHECKOUT_CAPABILITY, CATALOG_LOOKUP_CAPABILITY]);
    // A platform on an older version of the catalog capability shares nothing.
    expect(negotiated({ [CATALOG_SEARCH_CAPABILITY]: [{ ...entry, version: '2026-01-11' }] })).toBe(
      'capabilities_incompatible',
    );
  });

  it('refuses a newer protocol and an empty intersection', () => {
    const newer = parsePlatformProfile(platformDoc({}, '2099-01-01'));
    if ('problem' in newer) throw new Error(newer.problem);
    expect(negotiate(newer)).toMatchObject({ ok: false, code: 'version_unsupported' });
    const old = parsePlatformProfile(
      platformDoc({ [CHECKOUT_CAPABILITY]: [{ version: '2026-01-11' }] }),
    );
    if ('problem' in old) throw new Error(old.problem);
    expect(negotiate(old)).toMatchObject({ ok: false, code: 'capabilities_incompatible' });
  });

  it('explains a profile it cannot use', () => {
    expect(parsePlatformProfile('nope')).toHaveProperty('problem');
    expect(parsePlatformProfile({ ucp: { version: 'today' } })).toHaveProperty('problem');
  });
});

describe('settings', () => {
  it('reads stored settings and falls back to off', () => {
    expect(readUcpSettings(undefined)).toEqual(UCP_OFF);
    expect(readUcpSettings('{not json')).toEqual(UCP_OFF);
    const s = readUcpSettings(
      JSON.stringify({
        checkoutFlowId: 'tpl-storefront-order',
        orderUrl: 'https://shop.example/o/{id}',
      }),
    );
    expect(s.links).toEqual([]);
    expect(orderPermalink(s, ORIGIN, 'ord_1')).toBe('https://shop.example/o/ord_1');
    expect(orderPermalink(UCP_OFF, ORIGIN, 'ord_1')).toBe(`${ORIGIN}/orders/ord_1`);
    // Settings saved before catalog search had no product page: none.
    expect(s.productUrl).toBeNull();
  });

  it('takes a product page template only as an https URL with {slug} or {key}', () => {
    const parse = (productUrl: unknown) =>
      ucpSettingsSchema.safeParse({ checkoutFlowId: null, productUrl }).success;
    expect(parse('https://shop.example/p/{slug}')).toBe(true);
    expect(parse('https://shop.example/p?key={key}')).toBe(true);
    expect(parse(null)).toBe(true);
    for (const bad of [
      'https://shop.example/p',
      'http://shop.example/p/{slug}',
      'javascript:alert({key})',
      '{slug}',
      `https://shop.example/${'x'.repeat(500)}/{slug}`,
    ])
      expect(parse(bad)).toBe(false);
  });
});

const session = (s: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_1',
  ownerId: 'ucp_1',
  status: 'ready_for_complete',
  currency: 'USD',
  lines: [
    { id: 'li_1', sku: 'TEE-M', qty: 2 },
    { id: 'li_2', sku: 'EBOOK', qty: 1 },
  ],
  buyer: { email: 'ada@example.com', firstName: 'Ada' },
  fulfillment: 'ship',
  shipTo: {
    name: 'Ada Lovelace',
    line1: '1 Main St',
    city: 'Austin',
    postalCode: '78701',
    country: 'US',
  },
  shippingOption: 'standard',
  quote: {
    currency: 'USD',
    lines: [
      { id: 'li_1', sku: 'TEE-M', title: 'Tee', qty: 2, unitPrice: 19.99, ships: true },
      { id: 'li_2', sku: 'EBOOK', title: 'Ebook', qty: 1, unitPrice: 9.5, ships: false },
    ],
    subtotal: 49.48,
    shipping: 6,
    tax: 4.44,
    total: 59.92,
    shippingOptions: [
      { id: 'standard', title: 'Standard', carrier: 'ups', amount: 6, minDays: 3, maxDays: 5 },
      { id: 'express', title: 'Express', carrier: 'fedex', amount: 15, minDays: 1, maxDays: 2 },
    ],
    shippingOption: 'standard',
    ships: true,
  },
  issues: [],
  orderId: null,
  createdAt: 0,
  updatedAt: 0,
  expiresAt: CHECKOUT_TTL_MS,
  version: 3,
  ...s,
});

const view = {
  capabilities: all,
  handlers: [handler],
  settings: {
    ...UCP_OFF,
    links: [{ type: 'privacy_policy', url: 'https://shop.example/privacy' }],
  },
};

describe('checkout', () => {
  it('reads a create request, ship-to and option included', () => {
    const req = ucpCheckoutInput.parse({
      line_items: [{ item: { id: 'TEE-M' }, quantity: 2 }],
      buyer: { email: 'ada@example.com', first_name: 'Ada' },
      fulfillment: {
        methods: [
          {
            type: 'shipping',
            destinations: [
              {
                street_address: '1 Main St',
                address_locality: 'Austin',
                postal_code: '78701',
                address_country: 'US',
                first_name: 'Ada',
                last_name: 'Lovelace',
              },
            ],
            groups: [{ selected_option_id: 'express' }],
          },
        ],
      },
    });
    expect(checkoutPatch(req)).toEqual({
      lines: [{ id: undefined, sku: 'TEE-M', qty: 2 }],
      buyer: { email: 'ada@example.com', firstName: 'Ada' },
      shipTo: {
        name: 'Ada Lovelace',
        line1: '1 Main St',
        city: 'Austin',
        postalCode: '78701',
        country: 'US',
      },
      shippingOption: 'express',
    });
  });

  it('keeps the held ship-to when an update names it by id, and clears what an update leaves out', () => {
    const current = session();
    const keep = checkoutPatch(
      ucpCheckoutInput.parse({
        line_items: [{ id: 'li_1', item: { id: 'TEE-M' }, quantity: 1 }],
        fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
      }),
      current,
    );
    expect(keep.shipTo).toEqual(current.shipTo);
    expect(keep.buyer).toEqual({});
    expect(keep.shippingOption).toBeNull();
    const none = checkoutPatch(
      ucpCheckoutInput.parse({ line_items: [{ item: { id: 'TEE-M' }, quantity: 1 }] }),
      current,
    );
    expect(none.shipTo).toBeNull();
  });

  it('refuses requests the schema would not allow', () => {
    expect(ucpCheckoutInput.safeParse({ line_items: [] }).success).toBe(false);
    expect(
      ucpCheckoutInput.safeParse({ line_items: [{ item: { id: 'A' }, quantity: 0 }] }).success,
    ).toBe(false);
  });

  it('serves a checkout the schema (with fulfillment) accepts, in minor units', () => {
    const c = toUcpCheckout(session(), view);
    expect(conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    expect(c.line_items[0]).toMatchObject({ item: { id: 'TEE-M', price: 1999 }, quantity: 2 });
    expect(c.totals).toEqual([
      { type: 'subtotal', display_text: 'Subtotal', amount: 4948 },
      { type: 'fulfillment', display_text: 'Shipping', amount: 600 },
      { type: 'tax', display_text: 'Tax', amount: 444 },
      { type: 'total', display_text: 'Total', amount: 5992 },
    ]);
    const method = c.fulfillment!.methods[0]!;
    expect(method.line_item_ids).toEqual(['li_1']);
    expect(method.groups[0]!.selected_option_id).toBe('standard');
    expect(method.destinations[0]).toMatchObject({ id: 'dest_1', street_address: '1 Main St' });
    expect(c.ucp.capabilities).toEqual({
      [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }],
      [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION }],
    });
    expect(c.ucp.payment_handlers).toEqual({
      'com.commerceworker.stripe': [
        {
          id: 'stripe',
          version: UCP_VERSION,
          spec: handler.spec,
          schema: handler.schema,
          available_instruments: [{ type: 'card' }],
          config: { publishable_key: 'pk_test_123' },
        },
      ],
    });
  });

  it('serves an incomplete and a completed checkout the schema accepts', () => {
    const incomplete = toUcpCheckout(
      session({
        status: 'incomplete',
        quote: null,
        issues: [
          {
            kind: 'error',
            code: 'item_unavailable',
            content: 'No such item',
            path: '$.line_items[0]',
            severity: 'recoverable',
          },
        ],
      }),
      view,
    );
    expect(conformsTo('shopping/checkout.json', incomplete)).toEqual([]);
    expect(incomplete.messages).toEqual([
      {
        type: 'error',
        code: 'item_unavailable',
        content: 'No such item',
        path: '$.line_items[0]',
        severity: 'recoverable',
      },
    ]);
    const done = toUcpCheckout(session({ status: 'completed', orderId: 'ord_1' }), {
      ...view,
      permalink: 'https://shop.example/orders/ord_1',
    });
    expect(conformsTo('shopping/checkout.json', done)).toEqual([]);
    expect(done.order).toEqual({ id: 'ord_1', permalink_url: 'https://shop.example/orders/ord_1' });
    expect(done).not.toHaveProperty('expires_at');
  });

  it('leaves fulfillment out when the platform did not negotiate it, and says why it cannot ship', () => {
    const caps = new Map<UcpCapability, string>([[CHECKOUT_CAPABILITY, UCP_VERSION]]);
    expect(toUcpCheckout(session(), { ...view, capabilities: caps })).not.toHaveProperty(
      'fulfillment',
    );
    expect(protocolIssues(session(), caps)[0]).toMatchObject({ code: 'fulfillment_required' });
    expect(protocolIssues(session(), all)).toEqual([]);
  });

  it('picks the selected instrument at completion', () => {
    const one = ucpCompleteInput.parse({
      payment: { instruments: [{ id: 'i1', handler_id: 'stripe', type: 'card' }] },
    });
    expect(selectedInstrument(one)?.id).toBe('i1');
    const two = ucpCompleteInput.parse({
      payment: {
        instruments: [
          { id: 'i1', handler_id: 'stripe', type: 'card' },
          { id: 'i2', handler_id: 'stripe', type: 'card', selected: true },
        ],
      },
    });
    expect(selectedInstrument(two)?.id).toBe('i2');
  });

  it('serves an error response the schema accepts', () => {
    const r = ucpErrorResponse([
      { kind: 'error', code: 'not_found', content: 'No such checkout', severity: 'unrecoverable' },
    ]);
    expect(conformsTo('common/types/error_response.json', r)).toEqual([]);
  });
});

describe('order', () => {
  const order: Order = {
    id: 'ord_1',
    model: 'b2c',
    channel: 'agent',
    currency: 'USD',
    lines: [
      { sku: 'TEE-M', name: 'Tee', qty: 2, unitPrice: 19.99 },
      { sku: 'EBOOK', name: 'Ebook', qty: 1, unitPrice: 9.5 },
    ],
    meta: {},
    createdAt: 0,
    subtotal: 49.48,
    shipping: 6,
    tax: 4.44,
    total: 59.92,
  };
  const facts = {
    order,
    status: 'running' as const,
    checkoutId: 'chk_1',
    checkoutLines: session().lines,
    physical: new Set(['TEE-M']),
    shipTo: session().shipTo,
    shipments: [],
    refunds: [],
    updatedAt: 1_000,
    permalink: 'https://shop.example/orders/ord_1',
  };

  it('serves a placed order the schema accepts', () => {
    const o = toUcpOrder(facts, all);
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.line_items.map((l) => [l.id, l.status])).toEqual([
      ['li_1', 'processing'],
      ['li_2', 'processing'],
    ]);
    expect(o.ucp.capabilities).toEqual({ [ORDER_CAPABILITY]: [{ version: UCP_VERSION }] });
  });

  it('turns shipments into events and refunds into negative adjustments', () => {
    const o = toUcpOrder(
      {
        ...facts,
        status: 'completed',
        shipments: [
          {
            id: 'shp_1',
            carrier: 'ups',
            tracking: 'UPS123',
            status: 'label_created',
            createdAt: 500,
          },
          { id: 'shp_x', carrier: 'ups', tracking: 'UPS999', status: 'cancelled', createdAt: 600 },
        ],
        refunds: [{ id: 'ref_1', amount: 19.99, status: 'succeeded', createdAt: 900 }],
      },
      all,
    );
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.fulfillment.events).toEqual([
      {
        id: 'shp_1',
        occurred_at: new Date(500).toISOString(),
        type: 'shipped',
        line_items: [{ id: 'li_1', quantity: 2 }],
        tracking_number: 'UPS123',
        carrier: 'ups',
      },
    ]);
    expect(o.line_items.map((l) => l.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(o.adjustments).toEqual([
      expect.objectContaining({
        type: 'refund',
        status: 'completed',
        totals: [{ type: 'total', amount: -1999 }],
      }),
    ]);
  });

  it('removes every line of an order that ended unfulfilled', () => {
    const o = toUcpOrder({ ...facts, status: 'cancelled' }, all);
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.line_items.every((l) => l.status === 'removed' && l.quantity.total === 0)).toBe(true);
    expect(o.adjustments?.[0]).toMatchObject({
      type: 'cancellation',
      line_items: [
        { id: 'li_1', quantity: -2 },
        { id: 'li_2', quantity: -1 },
      ],
    });
  });
});

// ── Pickup ────────────────────────────────────────────────────────────────

const stores = [
  { id: 'loc_soho', name: 'SoHo store', postalCode: '10012' },
  { id: 'loc_brooklyn', name: 'Brooklyn store' },
];
const pickupView = view;
const pickupInput = (id: string | null = 'loc_soho') =>
  ucpCheckoutInput.parse({
    line_items: [{ item: { id: 'TEE-M' }, quantity: 2 }],
    fulfillment: {
      methods: [{ type: 'pickup', ...(id ? { selected_destination_id: id } : {}) }],
    },
  });
const collecting = () =>
  session({
    pickupStores: stores,
    fulfillment: 'pickup',
    pickupLocationId: 'loc_soho',
    shipTo: null,
    shippingOption: null,
    quote: {
      ...session().quote!,
      shipping: 0,
      shippingOptions: [],
      shippingOption: null,
      total: 53.92,
    },
  });

describe('pickup', () => {
  it('reads a chosen store as pickup and clears the ship-to and option, and shipping goes back on update', () => {
    expect(checkoutPatch(pickupInput(), undefined, all)).toMatchObject({
      fulfillment: 'pickup',
      pickupLocationId: 'loc_soho',
      shipTo: null,
      shippingOption: null,
    });
    // A pickup method with no store chosen is not a choice.
    expect(checkoutPatch(pickupInput(null), undefined, all)).toMatchObject({
      fulfillment: 'ship',
      pickupLocationId: null,
    });
    // Without the fulfillment extension a pickup is not read, and nothing changes.
    const bare = new Map<UcpCapability, string>([[CHECKOUT_CAPABILITY, UCP_VERSION]]);
    const p = checkoutPatch(pickupInput(), undefined, bare);
    expect(p).not.toHaveProperty('fulfillment');
    expect(p).not.toHaveProperty('pickupLocationId');
  });

  it('offers the stores as business locations the schema accepts, and what the buyer chose', () => {
    const c = toUcpCheckout(collecting(), pickupView);
    expect(conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    const method = c.fulfillment!.methods.find((m) => m.type === 'pickup')!;
    expect(method).toMatchObject({
      id: 'fm_pickup',
      line_item_ids: ['li_1'],
      selected_destination_id: 'loc_soho',
      destinations: [
        {
          id: 'loc_soho',
          type: 'business_location',
          name: 'SoHo store',
          address: { postal_code: '10012' },
        },
        { id: 'loc_brooklyn', type: 'business_location', name: 'Brooklyn store' },
      ],
    });
    expect(c.fulfillment!.methods.map((m) => m.type)).toEqual(['shipping', 'pickup']);
    expect(c.fulfillment!.available_methods).toEqual([
      { type: 'shipping', line_item_ids: ['li_1'] },
      expect.objectContaining({ type: 'pickup', line_item_ids: ['li_1'], fulfillable_on: 'now' }),
    ]);
    // Collecting costs nothing to ship.
    expect(c.totals.find((t) => t.type === 'fulfillment')).toMatchObject({
      display_text: 'Pickup',
      amount: 0,
    });
  });

  it('offers a store unselected until one is chosen, and the schema still accepts it', () => {
    const c = toUcpCheckout(session({ pickupStores: stores }), pickupView);
    expect(conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    expect(c.fulfillment!.methods.find((m) => m.type === 'pickup')).toMatchObject({
      selected_destination_id: null,
    });
  });

  it('offers no pickup when the flow has none, and shipping is as before', () => {
    const c = toUcpCheckout(session(), view);
    expect(c.fulfillment!.methods.map((m) => m.type)).toEqual(['shipping']);
    expect(c.fulfillment!.available_methods).toEqual([
      { type: 'shipping', line_item_ids: ['li_1'] },
    ]);
    // The schema refuses a pickup method whose destination is not a business location.
    const bad = {
      ...toUcpCheckout(session({ pickupStores: stores }), pickupView),
    };
    const m = bad.fulfillment!.methods.find((x) => x.type === 'pickup')!;
    m.destinations = [{ id: 'x', type: 'business_location' } as never];
    expect(
      conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', bad).length,
    ).toBeGreaterThan(0);
  });

  it('finds the pickup method by its id when an update leaves its type out', () => {
    const update = ucpCheckoutInput.parse({
      line_items: [{ id: 'li_1', item: { id: 'TEE-M' }, quantity: 2 }],
      fulfillment: { methods: [{ id: 'fm_pickup', selected_destination_id: 'loc_soho' }] },
    });
    expect(checkoutPatch(update, session(), all)).toMatchObject({
      fulfillment: 'pickup',
      pickupLocationId: 'loc_soho',
      shipTo: null,
    });
    // And an untyped method with the shipping id is still shipping.
    const ship = ucpCheckoutInput.parse({
      line_items: [{ id: 'li_1', item: { id: 'TEE-M' }, quantity: 2 }],
      fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
    });
    expect(checkoutPatch(ship, session(), all)).toMatchObject({ fulfillment: 'ship' });
  });

  it('keeps the chosen store listed when no store qualifies and once the checkout is done', () => {
    const none = toUcpCheckout(
      session({ fulfillment: 'pickup', pickupLocationId: 'loc_soho', pickupStores: [] }),
      pickupView,
    );
    expect(conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', none)).toEqual(
      [],
    );
    expect(none.fulfillment!.methods.find((m) => m.type === 'pickup')).toMatchObject({
      selected_destination_id: 'loc_soho',
      destinations: [],
    });
    const done = toUcpCheckout(
      { ...collecting(), status: 'completed', orderId: 'ord_1' },
      pickupView,
    );
    expect(done.fulfillment!.methods.find((m) => m.type === 'pickup')).toMatchObject({
      selected_destination_id: 'loc_soho',
    });
  });

  it('refuses a pickup method that leaves out a line that ships', () => {
    const named = (ids: string[]) =>
      ucpCheckoutInput.parse({
        line_items: [{ item: { id: 'TEE-M' }, quantity: 2 }],
        fulfillment: {
          methods: [{ type: 'pickup', line_item_ids: ids, selected_destination_id: 'loc_soho' }],
        },
      });
    expect(pickupLineIssues(named(['li_2']), collecting())).toEqual([
      expect.objectContaining({
        code: 'pickup_unavailable',
        content: expect.stringContaining('li_1'),
      }),
    ]);
    expect(pickupLineIssues(named(['li_1']), collecting())).toEqual([]);
    expect(pickupLineIssues(pickupInput(), collecting())).toEqual([]);
  });

  it('asks for no address or shipping option from a pickup', () => {
    expect(missingInfo(collecting()).map((i) => i.path)).toEqual([]);
    expect(
      missingInfo(session({ shipTo: null, shippingOption: null })).map((i) => i.path),
    ).toContain('$.fulfillment');
  });
});

// ── Discounts ─────────────────────────────────────────────────────────────

const withDiscount = new Map<UcpCapability, string>([...all, [DISCOUNT_CAPABILITY, UCP_VERSION]]);
const discountView_ = { ...view, capabilities: withDiscount };

/** SAVE10 (10% off) taken off both lines: 19.99 → 17.991 and 9.50 → 8.55. */
const discounted = (s: Partial<CheckoutSession> = {}) => {
  const base = session();
  return session({
    promoCodes: ['save10'],
    quote: {
      ...base.quote!,
      lines: [
        { ...base.quote!.lines[0]!, unitPrice: 17.991, listPrice: 19.99 },
        { ...base.quote!.lines[1]!, unitPrice: 8.55, listPrice: 9.5 },
      ],
      subtotal: 44.53,
      tax: 4,
      total: 54.53,
      discounts: {
        applied: [{ code: 'SAVE10', title: 'Ten percent off', kind: 'pct', amount: 4.95 }],
        refused: [{ code: 'NOPE', reason: "NOPE isn't a promotion." }],
      },
    },
    ...s,
  });
};

describe('discounts', () => {
  it('reads codes only when the extension is negotiated, and replaces the held ones', () => {
    const input = ucpCheckoutInput.parse({
      line_items: [{ item: { id: 'TEE-M' }, quantity: 1 }],
      discounts: { codes: ['save10', 'Welcome'] },
    });
    expect(checkoutPatch(input, undefined, withDiscount).promoCodes).toEqual(['save10', 'Welcome']);
    expect(checkoutPatch(input)).not.toHaveProperty('promoCodes');
    expect(checkoutPatch(input, undefined, all)).not.toHaveProperty('promoCodes');
    const none = ucpCheckoutInput.parse({ line_items: [{ item: { id: 'TEE-M' }, quantity: 1 }] });
    expect(checkoutPatch(none, discounted(), withDiscount).promoCodes).toEqual([]);
    expect(
      ucpCheckoutInput.safeParse({
        line_items: [{ item: { id: 'TEE-M' }, quantity: 1 }],
        discounts: { codes: ['A', 'B', 'C', 'D', 'E', 'F'] },
      }).success,
    ).toBe(false);
  });

  it('serves applied discounts the schema accepts, with totals that agree with them', () => {
    const c = toUcpCheckout(discounted(), discountView_);
    expect(conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    // The schema is what holds the shape: an applied discount with no title, or a positive
    // discount total, is refused.
    expect(
      conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', {
        ...c,
        discounts: { codes: [], applied: [{ amount: 1 }] },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', {
        ...c,
        totals: c.totals.map((t) => (t.type === 'discount' ? { ...t, amount: 495 } : t)),
      }).length,
    ).toBeGreaterThan(0);
    expect(c.ucp.capabilities).toHaveProperty([DISCOUNT_CAPABILITY]);
    expect(c.discounts).toEqual({
      codes: ['save10'],
      applied: [
        {
          code: 'SAVE10',
          title: 'Ten percent off',
          amount: 495,
          method: 'each',
          allocations: [
            { path: '$.line_items[0]', amount: 400 },
            { path: '$.line_items[1]', amount: 95 },
          ],
        },
      ],
    });
    expect(c.totals).toEqual([
      { type: 'subtotal', display_text: 'Subtotal', amount: 4948 },
      { type: 'discount', display_text: 'Discount', amount: -495 },
      { type: 'fulfillment', display_text: 'Shipping', amount: 600 },
      { type: 'tax', display_text: 'Tax', amount: 400 },
      { type: 'total', display_text: 'Total', amount: 5453 },
    ]);
    // The total is the sum of the entries, and the discount is the sum of what was applied.
    const sum = c.totals.filter((t) => t.type !== 'total').reduce((n, t) => n + t.amount, 0);
    expect(sum).toBe(c.totals.find((t) => t.type === 'total')!.amount);
    expect(c.discounts!.applied.reduce((n, a) => n + a.amount, 0)).toBe(495);
    // Each line shows its list price, its share of the discount, and the lines add up to the subtotal.
    expect(c.line_items[0]).toMatchObject({
      item: { price: 1999 },
      totals: [
        { type: 'subtotal', amount: 3998 },
        { type: 'discount', amount: -400 },
        { type: 'total', amount: 3598 },
      ],
    });
    expect(c.line_items.reduce((n, l) => n + l.totals[0]!.amount, 0)).toBe(4948);
  });

  it('reports a code the step refused at its place in the codes, and keeps it in codes', () => {
    const c = toUcpCheckout(
      discounted({ promoCodes: ['save10', 'nope', 'bad code'] }),
      discountView_,
    );
    expect(conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    expect(c.discounts!.codes).toEqual(['save10', 'nope', 'bad code']);
    expect(c.messages).toEqual([
      {
        type: 'warning',
        code: 'promotion',
        content: "NOPE isn't a promotion.",
        path: '$.discounts.codes[1]',
      },
      {
        type: 'warning',
        code: 'promotion',
        content: "bad code isn't a promotion.",
        path: '$.discounts.codes[2]',
      },
    ]);
    // The quote's own issue, at its own path, is replaced rather than repeated.
    const twice = toUcpCheckout(
      discounted({
        promoCodes: ['nope'],
        issues: [
          {
            kind: 'warning',
            code: 'promotion',
            content: "NOPE isn't a promotion.",
            path: '$.promoCodes',
          },
        ],
      }),
      discountView_,
    );
    expect(twice.messages).toHaveLength(1);
  });

  it('attributes a discount to lines only when one step result can be', () => {
    const base = discounted();
    const two = discountView({
      ...base,
      quote: {
        ...base.quote!,
        discounts: {
          applied: [
            { code: 'A', title: 'A', kind: 'pct', amount: 2.5 },
            { code: 'B', title: 'B', kind: 'amount', amount: 2.45 },
          ],
          refused: [],
        },
      },
    });
    expect(two.applied.map((a) => a.allocations)).toEqual([undefined, undefined]);
    expect(two.applied.map((a) => a.method)).toEqual(['each', 'across']);
    expect(two.lines.reduce((n, l) => n + l, 0)).toBe(two.items);
    const ship = discountView({
      ...base,
      quote: {
        ...base.quote!,
        discounts: {
          applied: [{ code: 'SHIP', title: 'Free shipping', kind: 'free_shipping', amount: 6 }],
          refused: [],
        },
      },
    });
    expect(ship.applied[0]).toEqual({
      code: 'SHIP',
      title: 'Free shipping',
      amount: 600,
      allocations: [{ path: '$.totals[?@.type == "fulfillment"]', amount: 600 }],
    });
    expect(ship.shipping).toBe(600);
  });

  it.each([
    ['7 lines of 0.15 at 10%', 7, 0.15, 0.135, 0.11],
    ['4 lines of 0.99 at 33%', 4, 0.99, 0.6633, 1.31],
  ])(
    'shares a discount across many lines without a negative share: %s',
    (_n, count, list, unit, off) => {
      const base = session();
      const ids = Array.from({ length: count }, (_, i) => `li_${i + 1}`);
      const many = session({
        promoCodes: ['SAVE'],
        lines: ids.map((id) => ({ id, sku: 'TEE-M', qty: 1 })),
        quote: {
          ...base.quote!,
          lines: ids.map((id) => ({
            id,
            sku: 'TEE-M',
            title: 'Tee',
            qty: 1,
            unitPrice: unit,
            listPrice: list,
            ships: true,
          })),
          subtotal: Math.round(count * unit * 100) / 100,
          discounts: {
            applied: [{ code: 'SAVE', title: 'Save', kind: 'pct', amount: off }],
            refused: [],
          },
        },
      });
      const c = toUcpCheckout(many, discountView_);
      expect(conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
      const applied = c.discounts!.applied[0]!;
      const shares = applied.allocations!.map((a) => a.amount);
      expect(shares.every((n) => n >= 0)).toBe(true);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(applied.amount);
      // Spread evenly: no share is more than one unit from another.
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      const lineOff = c.line_items.map(
        (l) => -(l.totals.find((t) => t.type === 'discount')?.amount ?? 0),
      );
      expect(lineOff.reduce((a, b) => a + b, 0)).toBe(applied.amount);
      expect(c.totals.find((t) => t.type === 'discount')!.amount).toBe(-applied.amount);
    },
  );

  it('leaves out free shipping that takes nothing off, and says why', () => {
    const base = discounted();
    const v = discountView({
      ...base,
      promoCodes: ['ship', 'save10'],
      quote: {
        ...base.quote!,
        discounts: {
          applied: [
            { code: 'SHIP', title: 'Free shipping', kind: 'free_shipping', amount: 0 },
            { code: 'SAVE10', title: 'Ten percent off', kind: 'pct', amount: 4.95 },
          ],
          refused: [],
        },
      },
    });
    expect(v.applied.map((a) => a.code)).toEqual(['SAVE10']);
    expect(v.shipping).toBe(0);
    expect(v.messages).toEqual([
      expect.objectContaining({
        kind: 'warning',
        code: 'promotion',
        path: '$.discounts.codes[0]',
        content: expect.stringContaining('takes nothing off'),
      }),
    ]);
  });

  it('tells each code it does not apply when the flow has no discount step', () => {
    const base = session();
    const c = toUcpCheckout(
      session({ promoCodes: ['A', 'B'], quote: { ...base.quote!, discounts: undefined } }),
      discountView_,
    );
    expect(c.messages).toEqual([
      expect.objectContaining({ path: '$.discounts.codes[0]', code: 'promotion' }),
      expect.objectContaining({ path: '$.discounts.codes[1]', code: 'promotion' }),
    ]);
    expect(c.discounts).toEqual({ codes: ['A', 'B'], applied: [] });
    expect(conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
  });

  it('serves a checkout as before when the extension was not negotiated', () => {
    const c = toUcpCheckout(discounted(), view);
    expect(c).not.toHaveProperty('discounts');
    expect(c.totals.map((t) => t.type)).toEqual(['subtotal', 'fulfillment', 'tax', 'total']);
    expect(c.totals[0]!.amount).toBe(4453);
    expect(c.line_items[0]!.item.price).toBe(1799);
    expect(c.ucp.capabilities).not.toHaveProperty([DISCOUNT_CAPABILITY]);
    expect(conformsTo('shopping/checkout.json', c)).toEqual([]);
  });

  it('shows a negotiated checkout with no codes as empty discounts', () => {
    const c = toUcpCheckout(session(), discountView_);
    expect(c.discounts).toEqual({ codes: [], applied: [] });
    expect(c.totals.map((t) => t.type)).toEqual(['subtotal', 'fulfillment', 'tax', 'total']);
    expect(conformsTo('shopping/discount.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
  });
});

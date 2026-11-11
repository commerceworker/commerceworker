import { OUTBOUND_EVENTS, TOOL_OUTPUTS } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { subscriptionInput } from '../app/lib/api-schemas';
import { openApiDocument } from '../app/lib/openapi';
import { REST_OPERATIONS } from '../app/lib/rest-operations';

describe('OpenAPI document', () => {
  const doc = openApiDocument('https://commerceworker.example');

  it('serialises, and generates every request body from its zod schema', () => {
    const json = JSON.parse(JSON.stringify(doc));
    expect(json.openapi).toBe('3.1.0');
    const start = json.paths['/api/v1/orders'].post.requestBody.content['application/json'].schema;
    expect(start.required).toEqual(expect.arrayContaining(['flowId', 'input']));
    expect(start.properties.input.properties.model.enum).toContain('marketplace');
    expect(start.properties.input.properties.channel.enum).toContain('pos');
    type Op = { requestBody?: { content: Record<string, { schema: unknown }> } };
    for (const [path, item] of Object.entries(json.paths) as [string, Record<string, Op>][])
      for (const op of Object.values(item))
        if (op.requestBody)
          for (const media of Object.values(op.requestBody.content))
            expect(media.schema, path).toHaveProperty('type');
  });

  it('describes an order with its shipping and totals', () => {
    const json = JSON.parse(JSON.stringify(doc));
    const start = json.paths['/api/v1/orders'].post.requestBody.content['application/json'].schema;
    expect(start.properties.input.properties.shippingOption.type).toBe('string');
    const order = json.components.schemas.Order;
    expect(order.required).toEqual(
      expect.arrayContaining(['id', 'subtotal', 'shipping', 'tax', 'total']),
    );
    expect(order.properties.shippingOption.type).toBe('string');
  });

  it('describes carts and generates a cart op body from the schema the route validates with', () => {
    const json = JSON.parse(JSON.stringify(doc));
    const op =
      json.paths['/api/v1/carts/{id}/ops'].post.requestBody.content['application/json'].schema;
    const kinds = (op.oneOf ?? op.anyOf).map(
      (s: { properties: { op: { const: string } } }) => s.properties.op.const,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'add',
        'set_qty',
        'set_qtys',
        'remove',
        'lock',
        'rename',
        'set_ship_to',
        'set_shipping_option',
      ]),
    );
    const create = json.paths['/api/v1/carts'].post.requestBody.content['application/json'].schema;
    expect(create.required).toEqual(expect.arrayContaining(['title', 'flowId']));
    // Who opened it is the caller, never the body.
    expect(create.properties).not.toHaveProperty('createdBy');
    expect(json.components.schemas.Cart.properties).not.toHaveProperty('external');
    expect(json.components.schemas.Cart.required).toEqual(
      expect.arrayContaining(['shipTo', 'shippingOption']),
    );
    const submit = json.paths['/api/v1/carts/{id}/submit'].post;
    expect(Object.keys(submit.responses)).toEqual(expect.arrayContaining(['409', '412']));
    expect(submit.parameters.map((x: { name: string }) => x.name)).toContain('If-Match');
    expect(submit.requestBody.required).toBe(false);
    expect(submit.requestBody.content['application/json'].schema.properties.version.type).toBe(
      'integer',
    );
  });

  it('documents every outbound event and leaves signed inbound events unauthenticated', () => {
    expect(Object.keys(doc.webhooks)).toEqual([...OUTBOUND_EVENTS]);
    const schemaOf = (event: string) =>
      doc.webhooks[event]!.post.requestBody.content['application/json'].schema.$ref;
    expect(schemaOf('order.shipped')).toBe('#/components/schemas/OrderEvent');
    expect(schemaOf('cart.submitted')).toBe('#/components/schemas/CartEvent');
    expect(doc.components.schemas.CartEvent.required).toContain('cartId');
    expect(doc.components.schemas.OrderEvent.properties.event.enum).not.toContain('cart.created');
    expect(doc.paths['/api/v1/webhooks/events'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/webhooks/orders'].post.security).toEqual([]);
    // Stripe and Shopify sign with their own headers; EDI comes from an operator token.
    expect(doc.paths['/api/v1/webhooks/stripe'].post.security).toEqual([]);
    expect(Object.keys(doc.paths['/api/v1/webhooks/stripe'].post.responses)).toEqual(
      expect.arrayContaining(['200', '400', '409', '503']),
    );
    expect(doc.paths['/api/v1/channels/shopify/orders'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/channels/edi/850'].post).not.toHaveProperty('security');
  });
});

describe('OpenAPI operations', () => {
  const errorRef = '#/components/schemas/Error';
  const json = JSON.parse(JSON.stringify(openApiDocument('https://commerceworker.example')));
  type Op = {
    operationId?: string;
    responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
  };
  const operations = (Object.entries(json.paths) as [string, Record<string, Op>][]).flatMap(
    ([route, item]) => Object.entries(item).map(([method, op]) => ({ route, method, op })),
  );

  it('names every operation, once, in snake_case', () => {
    const ids = operations.map(({ op }) => op.operationId);
    for (const [i, id] of ids.entries())
      expect(id, `${operations[i]!.method} ${operations[i]!.route}`).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a REST operation by its tool', () => {
    for (const rest of REST_OPERATIONS) {
      const op = json.paths[`/api/v1${rest.path}`][rest.method.toLowerCase()];
      expect(op.operationId).toBe(rest.tool);
    }
  });

  it('types every REST operation response as its tool output', () => {
    for (const rest of REST_OPERATIONS) {
      const op = json.paths[`/api/v1${rest.path}`][rest.method.toLowerCase()] as Op;
      const schema = op.responses['200']?.content?.['application/json']?.schema;
      expect(schema, rest.tool).toHaveProperty('type', 'object');
      expect(schema, rest.tool).toHaveProperty('properties');
    }
  });

  it('describes what a tool answers: a real tool output validates against its response schema', () => {
    // The shapes the engine's tools return for these (runRestOperation sends the tool's value as is).
    const attention = TOOL_OUTPUTS.needs_attention.parse({
      approvals: [{ id: 'a1', orderId: 'o1', title: 'Approve' }],
      failed: [],
      stalled: [],
      counts: { approvals: 1, failed: 0, stalled: 0 },
    });
    const schema = json.paths['/api/v1/attention'].get.responses['200'].content['application/json']
      .schema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(schema.required.sort()).toEqual(Object.keys(attention).sort());
    expect(schema.properties.approvals?.type).toBe('array');
    expect(TOOL_OUTPUTS.needs_attention.safeParse({ approvals: [] }).success).toBe(false);
  });

  it('describes the same refusals on every authenticated operation, and signed routes by signature', () => {
    for (const { route, method, op } of operations) {
      const signed = (json.paths[route][method] as { security?: unknown[] }).security?.length === 0;
      const codes = Object.keys(op.responses);
      expect(codes, `${method} ${route}`).toEqual(
        expect.arrayContaining(
          signed ? ['400', '401', '404', '429'] : ['400', '401', '403', '404', '429'],
        ),
      );
      for (const code of codes.filter((c) => /^4/.test(c))) {
        const schema = op.responses[code]?.content?.['application/json']?.schema;
        // Erasure's refusal names the orders in the way, not an `error`.
        if (route === '/api/v1/data-subjects/erase' && code === '409')
          expect(schema).toHaveProperty('required', ['ok', 'reason', 'orders']);
        else expect(schema, `${method} ${route} ${code}`).toEqual({ $ref: errorRef });
      }
    }
  });

  it('types the hand-written responses that have a zod schema', () => {
    const channel =
      json.paths['/api/v1/catalog/channels'].post.responses['200'].content['application/json']
        .schema;
    expect(channel.properties.channel.properties.defaultLocale.type).toBe('string');
    const ucp =
      json.paths['/api/v1/ucp/settings'].post.responses['200'].content['application/json'].schema;
    expect(ucp.properties.settings.properties.checkoutFlowId).toBeDefined();
  });
});

describe('webhook subscription input', () => {
  it('requires https except on localhost, and defaults to every event', () => {
    expect(subscriptionInput.parse({ url: 'https://hooks.example/x' }).events).toEqual(['*']);
    expect(subscriptionInput.safeParse({ url: 'http://localhost:8788/hook' }).success).toBe(true);
    expect(subscriptionInput.safeParse({ url: 'http://hooks.example/x' }).success).toBe(false);
    expect(
      subscriptionInput.safeParse({ url: 'https://hooks.example/x', events: ['order.lost'] })
        .success,
    ).toBe(false);
  });
});

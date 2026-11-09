/**
 * REST and MCP take the same operations alike: each REST body below names the fields its MCP tool
 * takes (less those REST reads from the path), with the same types and bounds. A difference is
 * allowed only where it is listed here with why; a field one side gains is a failure until the
 * other takes it too, or it is listed.
 */
import { cartOpSchema, REST_OPERATION_TOOLS, TOOL_INPUTS } from '@commerceworker/core';
import {
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogDiscardInput,
  catalogEditsInput,
  catalogProductsInput,
  catalogTypeInput,
} from '@commerceworker/core/product';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  cancelInput,
  createCartInput,
  decisionInput,
  orderEventInput,
  submitCartInput,
} from '../app/lib/api-schemas';
import { openApiDocument } from '../app/lib/openapi';
import {
  offeredOverRest,
  operationBody,
  pathFields,
  REST_OPERATIONS,
} from '../app/lib/rest-operations';

type Json = Record<string, unknown>;
/** A schema as a client sees it, without the descriptions MCP adds for a model. */
const shape = (s: z.ZodType): Json =>
  JSON.parse(
    JSON.stringify(z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }), (k, v) =>
      k === 'description' || k === '$schema' ? undefined : v,
    ),
  );
const props = (s: z.ZodType) => {
  const j = shape(s) as { properties?: Record<string, Json>; required?: string[] };
  return { properties: j.properties ?? {}, required: new Set(j.required ?? []) };
};

const PAIRS: {
  rest: string;
  tool: keyof typeof TOOL_INPUTS;
  body: z.ZodType;
  /** Fields REST takes from the path. */
  path: string[];
  /** Fields that differ on purpose, and why. */
  differs?: Record<string, string>;
}[] = [
  {
    rest: 'POST /orders/{id}/approvals/{nodeId}',
    tool: 'decide_approval',
    body: decisionInput,
    path: ['orderId', 'nodeId'],
  },
  {
    rest: 'POST /orders/{id}/cancel',
    tool: 'cancel_order',
    body: cancelInput,
    path: ['orderId'],
    differs: { reason: 'optional over REST (defaults to "Cancelled via API"); the assistant asks' },
  },
  {
    rest: 'POST /orders/{id}/events',
    tool: 'deliver_event',
    body: orderEventInput,
    path: ['orderId'],
    differs: {
      payload:
        'an integration sends nested JSON; a model is held to flat, short values a card shows',
      event: 'bounded to 100 characters over REST; the engine bounds it for MCP',
    },
  },
  {
    rest: 'POST /carts',
    tool: 'create_cart',
    body: createCartInput,
    path: [],
    differs: {
      customerId: 'REST takes null for "no customer"; MCP leaves it out',
    },
  },
  {
    rest: 'POST /carts/{id}/submit',
    tool: 'submit_cart',
    body: submitCartInput,
    path: ['cartId'],
    differs: { version: 'REST’s name for cartVersion, matching the cart’s ETag; both are taken' },
  },
  // The catalog's writes: the same zod objects, so any difference is a bug.
  {
    rest: 'POST /catalog/products',
    tool: 'put_catalog_products',
    body: catalogProductsInput,
    path: [],
  },
  {
    rest: 'POST /catalog/products/delete',
    tool: 'delete_catalog_products',
    body: catalogDeleteInput,
    path: [],
  },
  { rest: 'POST /catalog/types', tool: 'put_catalog_type', body: catalogTypeInput, path: [] },
  {
    rest: 'POST /catalog/channels',
    tool: 'put_catalog_channel',
    body: catalogChannelInput,
    path: [],
  },
  {
    rest: 'POST /catalog/categories',
    tool: 'put_catalog_categories',
    body: catalogCategoriesInput,
    path: [],
  },
  {
    rest: 'POST /catalog/categories/delete',
    tool: 'delete_catalog_categories',
    body: catalogCategoriesDeleteInput,
    path: [],
  },
  { rest: 'POST /catalog/edits', tool: 'stage_product_edits', body: catalogEditsInput, path: [] },
  {
    rest: 'POST /catalog/edits/discard',
    tool: 'discard_product_edits',
    body: catalogDiscardInput,
    path: ['what'],
  },
];

describe('REST and MCP take each operation alike', () => {
  for (const p of PAIRS)
    it(`${p.rest} ↔ ${p.tool}`, () => {
      const rest = props(p.body);
      const tool = props(TOOL_INPUTS[p.tool]);
      const differs = p.differs ?? {};
      const toolFields = Object.keys(tool.properties).filter((f) => !p.path.includes(f));
      for (const f of toolFields) {
        if (f in differs) continue;
        expect(rest.properties[f], `${p.rest} lacks ${f}`).toEqual(tool.properties[f]);
        expect(rest.required.has(f), `${f} required on one side only`).toBe(tool.required.has(f));
      }
      const extra = Object.keys(rest.properties).filter(
        (f) => !toolFields.includes(f) && !(f in differs),
      );
      expect(extra, `${p.rest} takes fields ${p.tool} doesn't`).toEqual([]);
      // A listed difference must still be one, or the list goes stale.
      for (const f of Object.keys(differs)) {
        const same =
          JSON.stringify(rest.properties[f]) === JSON.stringify(tool.properties[f]) &&
          rest.required.has(f) === tool.required.has(f);
        expect(same, `${f} no longer differs: drop it from the list`).toBe(false);
      }
    });

  it('a REST cart op is one of change_cart’s ops', () => {
    const ops = shape(TOOL_INPUTS.change_cart) as { properties: { ops: { items: Json } } };
    expect(shape(cartOpSchema)).toEqual(ops.properties.ops.items);
  });
});

describe('REST operations run their MCP tool', () => {
  const doc = openApiDocument('https://app.test') as {
    paths: Record<string, Record<string, Json>>;
  };

  for (const op of REST_OPERATIONS)
    it(`${op.method} ${op.path} ↔ ${op.tool}`, () => {
      expect(offeredOverRest(op.tool), `${op.tool} is the page's or panel's alone`).toBe(true);
      const tool = props(TOOL_INPUTS[op.tool]);
      for (const f of pathFields(op))
        expect(Object.keys(tool.properties), `{${f}} isn't a field of ${op.tool}`).toContain(f);
      // The body is the tool's input less the path's fields, so the two can't drift apart.
      const body = props(operationBody(op));
      for (const [f, schema] of Object.entries(body.properties))
        expect(schema).toEqual(tool.properties[f]);
      expect(Object.keys(body.properties).length + pathFields(op).length).toBe(
        Object.keys(tool.properties).length,
      );
      expect(
        doc.paths[`/api/v1${op.path}`]?.[op.method.toLowerCase()],
        'not in the OpenAPI document',
      ).toBeDefined();
    });

  it('routes exactly the tools the engine runs for REST, and no others', () => {
    expect([...new Set(REST_OPERATIONS.map((o) => o.tool))].sort()).toEqual(
      [...REST_OPERATION_TOOLS].sort(),
    );
  });

  it('names each operation once', () => {
    const keys = REST_OPERATIONS.map((o) => `${o.method} ${o.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

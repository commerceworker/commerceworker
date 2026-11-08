import type { ApiConfig } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const listing = {
  apiId: 'listing',
  name: 'Listing',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    {
      apiId: 'status',
      name: 'Status',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'soldTo',
      name: 'Sold to',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 2,
      rules: [{ action: 'hide', when: { field: 'status', operator: 'ne', value: 'sold' } }],
    },
    {
      apiId: 'price',
      name: 'Price',
      type: 'Number',
      localized: false,
      required: false,
      position: 3,
      rules: [{ action: 'disable', when: { field: 'status', operator: 'eq', value: 'sold' } }],
    },
  ],
};

function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: cma, body: body ? JSON.stringify(body) : undefined });
  return { send, ctx };
}

describe('conditional field rules over HTTP', () => {
  it('stores rules and judges entries by them', async () => {
    const { send } = setup();
    expect((await send(`${M}/content-types`, 'POST', listing)).status).toBe(201);
    await send(`${M}/content-types/listing/published`, 'POST');
    const got = (await (await send(`${M}/content-types/listing`, 'GET')).json()) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[2]?.rules).toEqual(listing.fields[2]?.rules);

    // Hidden while not sold: not required.
    const open = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'listing',
      fields: { title: { 'en-US': 'Flat' }, status: { 'en-US': 'open' }, price: {} },
    });
    expect(open.status).toBe(201);
    const created = (await open.json()) as { entry: { id: string } };

    // Sold: shown, so required; price disabled, so it keeps its stored (empty) value.
    const sold = await send(`${M}/entries/${created.entry.id}`, 'PUT', {
      fields: {
        title: { 'en-US': 'Flat' },
        status: { 'en-US': 'sold' },
        price: { 'en-US': 100 },
      },
    });
    expect(sold.status).toBe(422);
    const text = JSON.stringify(await sold.json());
    expect(text).toContain('Field is required');
    expect(text).toContain('read-only while its rules disable it');
  });

  it('answers a writer the same whether a disabled field it may not write is empty or filled', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai);
    const as =
      (headers: Record<string, string>) => (path: string, method: string, body?: unknown) =>
        app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const send = as(cma);
    await send(`${M}/content-types`, 'POST', listing);
    await send(`${M}/content-types/listing/published`, 'POST');
    // Two sold listings: one holds a price (set while open, kept as it sold), one never had one.
    const sold = async (price?: number) => {
      const made = (await (
        await send(`${M}/entries`, 'POST', {
          contentTypeApiId: 'listing',
          fields: {
            title: { 'en-US': 'Flat' },
            ...(price === undefined ? {} : { price: { 'en-US': price } }),
          },
        })
      ).json()) as { entry: { id: string }; fields: Record<string, unknown> };
      const res = await send(`${M}/entries/${made.entry.id}`, 'PUT', {
        fields: { ...made.fields, status: { 'en-US': 'sold' }, soldTo: { 'en-US': 'Ada' } },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return made.entry.id;
    };
    const filled = await sold(250_000);
    const empty = await sold();

    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Listing writer',
          scopes: ['content:write', 'preview:read'],
          contentGrants: [
            { contentTypeApiId: 'listing', actions: ['read', 'write'], readOnlyFields: ['price'] },
          ],
        }),
      })
    ).json()) as { id: string };
    const { token } = (await (
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      })
    ).json()) as { token: string };
    const writer = as({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

    const edit = {
      title: { 'en-US': 'Flat, renamed' },
      status: { 'en-US': 'sold' },
      soldTo: { 'en-US': 'Ada' },
    };
    for (const id of [filled, empty]) {
      const checked = await writer(`${M}/entries/validate`, 'POST', { entryId: id, fields: edit });
      expect(checked.status, await checked.clone().text()).toBe(200);
      const saved = await writer(`${M}/entries/${id}`, 'PUT', { fields: edit });
      expect(saved.status, await saved.clone().text()).toBe(200);
    }
    // The save kept the price the writer could not send, and added none where there was none.
    const priceOf = async (id: string) =>
      ((await (await send(`${M}/entries/${id}`, 'GET')).json()) as { fields: { price?: unknown } })
        .fields.price;
    expect(await priceOf(filled)).toEqual({ 'en-US': 250_000 });
    expect(await priceOf(empty)).toBeUndefined();
  });

  it('lets a writer save around a required field its role makes read-only', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai);
    const as =
      (headers: Record<string, string>) => (path: string, method: string, body?: unknown) =>
        app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const send = as(cma);
    await send(`${M}/content-types`, 'POST', {
      apiId: 'deal',
      name: 'Deal',
      displayField: 'title',
      fields: [
        { apiId: 'title', name: 'Title', type: 'Symbol', localized: false, position: 0 },
        {
          apiId: 'owner',
          name: 'Owner',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 1,
        },
      ],
    });
    await send(`${M}/content-types/deal/published`, 'POST');
    const made = (await (
      await send(`${M}/entries`, 'POST', {
        contentTypeApiId: 'deal',
        fields: { title: { 'en-US': 'A' }, owner: { 'en-US': 'Ada' } },
      })
    ).json()) as { entry: { id: string } };
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Deal writer',
          scopes: ['content:write', 'preview:read'],
          contentGrants: [
            { contentTypeApiId: 'deal', actions: ['read', 'write'], readOnlyFields: ['owner'] },
          ],
        }),
      })
    ).json()) as { id: string };
    const { token } = (await (
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      })
    ).json()) as { token: string };
    const writer = as({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

    const saved = await writer(`${M}/entries/${made.entry.id}`, 'PUT', {
      fields: { title: { 'en-US': 'B' } },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    // Read-only, not denied: the writer may read what the save kept.
    expect(((await saved.json()) as { fields: Record<string, unknown> }).fields).toEqual({
      title: { 'en-US': 'B' },
      owner: { 'en-US': 'Ada' },
    });
  });

  it('refuses a rule that reads no sibling, naming the field', async () => {
    const { send } = setup();
    const bad = {
      ...listing,
      fields: [
        listing.fields[0],
        {
          ...listing.fields[2],
          rules: [{ action: 'hide', when: { field: 'nope', operator: 'empty' } }],
        },
      ],
    };
    const res = await send(`${M}/content-types`, 'POST', bad);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('not a sibling field');
  });

  it('documents rules in the OpenAPI field schema', async () => {
    const { send } = setup();
    const spec = JSON.stringify(await (await send('/openapi.json', 'GET')).json());
    expect(spec).toContain('Hide or disable the field while a sibling matches');
    expect(spec).toContain('notEmpty');
  });
});

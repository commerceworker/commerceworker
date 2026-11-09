import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
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
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

const symbol = (apiId: string, position = 0, required = false) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required,
  position,
});

const variants = [
  { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 0, true)] },
  {
    apiId: 'cta',
    name: 'Call to action',
    fields: [
      symbol('label', 0, true),
      {
        apiId: 'target',
        name: 'Target',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  },
];

const promoType = (vs: readonly unknown[]) => ({
  apiId: 'promo',
  name: 'Promo',
  displayField: 'title',
  fields: [
    symbol('title', 0, true),
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      items: { type: 'Component', variants: vs },
    },
  ],
});

async function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: cma, body: body ? JSON.stringify(body) : undefined });

  for (const ct of [
    { apiId: 'note', name: 'Note', displayField: 'title', fields: [symbol('title', 0, true)] },
    promoType(variants),
  ]) {
    expect((await send(`${M}/content-types`, 'POST', ct)).status).toBe(201);
    await send(`${M}/content-types/${ct.apiId}/published`, 'POST');
  }
  const note = (await (
    await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Linked note' } },
    })
  ).json()) as { entry: { id: string } };
  await send(`${M}/entries/${note.entry.id}/published`, 'POST');
  return { app, send, noteId: note.entry.id };
}

describe('a blocks field over HTTP', () => {
  it('creates, publishes and delivers blocks, resolving a link inside one', async () => {
    const { app, send, noteId } = await setup();
    const created = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'promo',
      fields: {
        title: { 'en-US': 'Spring' },
        body: {
          'en-US': [
            { _type: 'hero', heading: 'Spring is here' },
            { _type: 'cta', label: 'Read', target: { id: noteId, linkType: 'Entry' } },
          ],
        },
      },
    });
    expect(created.status).toBe(201);
    const { entry } = (await created.json()) as {
      entry: { id: string; fields: { body: Record<string, { _key?: string }[]> } };
    };
    await send(`${M}/entries/${entry.id}/published`, 'POST');

    const delivered = await app.request(`${D}/entries/${entry.id}?locale=en-US&include=1`, {
      headers: cda,
    });
    expect(delivered.status).toBe(200);
    const body = ((await delivered.json()) as { fields: { body: Record<string, unknown>[] } })
      .fields.body;
    expect(body.map((b) => b._type)).toEqual(['hero', 'cta']);
    expect(body.every((b) => typeof b._key === 'string')).toBe(true);
    const target = body[1]?.target as { id: string; fields: { title: string } };
    expect(target.id).toBe(noteId);
    expect(target.fields.title).toBe('Linked note');

    // GraphQL types the same value as a union.
    const gql = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: { ...cda, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ promo(id: "${entry.id}") { body { __typename ... on PromoBodyCta { label } } } }`,
      }),
    });
    const result = (await gql.json()) as { data: { promo: { body: unknown[] } } };
    expect(result.data.promo.body).toEqual([
      { __typename: 'PromoBodyHero' },
      { __typename: 'PromoBodyCta', label: 'Read' },
    ]);
  });

  it('refuses a block of an unknown variant, naming the block', async () => {
    const { send } = await setup();
    const res = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'promo',
      fields: { title: { 'en-US': 'Bad' }, body: { 'en-US': [{ _type: 'quote' }] } },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('body[0]');
  });

  it('refuses removing a variant an entry uses, with 409', async () => {
    const { send } = await setup();
    await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'promo',
      fields: { title: { 'en-US': 'Uses cta' }, body: { 'en-US': [{ _type: 'cta', label: 'x' }] } },
    });
    const res = await send(`${M}/content-types`, 'POST', promoType(variants.slice(0, 1)));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; details: { variantsInUse: { variant: string }[] } };
    };
    expect(body.error.message).toContain('body: cta');
    expect(body.error.details.variantsInUse[0]?.variant).toBe('body: cta');
  });

  it('refuses removing a field an entry holds a value for, with 409 naming the entry', async () => {
    const { send } = await setup();
    const created = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'promo',
      fields: {
        title: { 'en-US': 'Has blocks' },
        body: { 'en-US': [{ _type: 'cta', label: 'x' }] },
      },
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    const { fields, ...rest } = promoType(variants);
    const res = await send(`${M}/content-types`, 'POST', {
      ...rest,
      fields: fields.filter((f) => f.apiId !== 'body'),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { fieldsInUse: { field: string; entries: string[] }[] } };
    };
    expect(body.error.code).toBe('conflict');
    expect(body.error.details.fieldsInUse).toEqual([{ field: 'body', entries: [entry.id] }]);
  });
});

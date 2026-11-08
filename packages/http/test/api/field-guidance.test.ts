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

const guided = {
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
      help: 'Lead with the neighbourhood.',
      placeholder: 'Sunny two-bed in Leith',
      description: 'The headline of the listing, shown in search results.',
    },
    {
      apiId: 'status',
      name: 'Status',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 1,
      validations: {
        in: [{ value: 'open', label: 'Open for viewings' }, 'let'],
        messages: { in: 'Pick a status from the list' },
      },
    },
    {
      apiId: 'zip',
      name: 'ZIP',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 2,
      validations: {
        regexp: { pattern: '^\\d{5}$' },
        messages: { regexp: 'Enter a five-digit ZIP code' },
      },
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

describe('field guidance over HTTP', () => {
  it('stores help, placeholder, description, labelled options and messages as written', async () => {
    const { send } = setup();
    expect((await send(`${M}/content-types`, 'POST', guided)).status).toBe(201);
    const got = (await (await send(`${M}/content-types/listing`, 'GET')).json()) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[0]).toMatchObject({
      help: 'Lead with the neighbourhood.',
      placeholder: 'Sunny two-bed in Leith',
      description: 'The headline of the listing, shown in search results.',
    });
    expect(got.fields[1]?.validations).toEqual(guided.fields[1]?.validations);
  });

  it('accepts an option by its value and reports a rule’s custom message', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', guided);
    await send(`${M}/content-types/listing/published`, 'POST');
    const ok = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'listing',
      fields: { title: { 'en-US': 'Flat' }, status: { 'en-US': 'open' } },
    });
    expect(ok.status).toBe(201);

    const bad = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'listing',
      fields: {
        title: { 'en-US': 'Flat' },
        // The label is not a stored value.
        status: { 'en-US': 'Open for viewings' },
        zip: { 'en-US': 'EH6' },
      },
    });
    expect(bad.status).toBe(422);
    const text = JSON.stringify(await bad.json());
    expect(text).toContain('Pick a status from the list');
    expect(text).toContain('Enter a five-digit ZIP code');
  });

  it('refuses guidance over its cap, and a message for a rule the field lacks', async () => {
    const { send } = setup();
    const withField = (extra: Record<string, unknown>) => ({
      ...guided,
      fields: [{ ...guided.fields[0], ...extra }],
    });
    const long = await send(`${M}/content-types`, 'POST', withField({ help: 'x'.repeat(501) }));
    expect(long.status).toBe(422);
    expect(JSON.stringify(await long.json())).toContain('help');
    const orphan = await send(
      `${M}/content-types`,
      'POST',
      withField({ validations: { messages: { size: 'Too long' } } }),
    );
    expect(orphan.status).toBe(422);
    expect(JSON.stringify(await orphan.json())).toContain('needs the size rule');
  });

  it('lets a definition stored before guidance was checked be saved again unchanged', async () => {
    const { send, ctx } = setup();
    // As main's loose route could have stored it: a null description, an oversize help, an
    // orphan message and a duplicate option.
    const legacyTitle = {
      ...guided.fields[0],
      description: null,
      help: 'x'.repeat(600),
      validations: { in: ['a', 'a'], messages: { size: 'No rule' } },
    };
    await ctx.store.contentTypes.save(
      { spaceId: 's1', environmentId: 'main' },
      {
        apiId: 'listing',
        name: 'Listing',
        displayField: 'title',
        fields: [legacyTitle as never],
        version: 1,
        status: 'draft',
      },
    );
    const res = await send(`${M}/content-types`, 'POST', {
      apiId: 'listing',
      name: 'Listings',
      displayField: 'title',
      fields: [legacyTitle],
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(((await res.json()) as { name: string }).name).toBe('Listings');
  });

  it('documents the attributes in the OpenAPI field schema', async () => {
    const { send } = setup();
    const spec = JSON.stringify(await (await send('/openapi.json', 'GET')).json());
    for (const text of [
      'How to fill the field',
      'An example shown in the empty input',
      'What the field means',
      'Error text a broken rule reports',
    ]) {
      expect(spec).toContain(text);
    }
  });
});

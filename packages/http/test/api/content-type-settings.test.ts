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
const M = '/spaces/s1/environments/main';

const sym = (apiId: string, position: number, extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
  ...extra,
});

const event = {
  apiId: 'event',
  name: 'Event',
  displayField: 'title',
  group: 'Programme',
  description: 'Something on the calendar.',
  icon: 'calendar',
  layout: {
    tabs: [
      { apiId: 'main', name: 'Main', groups: [{ fields: ['title', 'day'] }] },
      { apiId: 'contact', name: 'Contact', groups: [{ name: 'Organiser', fields: ['email'] }] },
    ],
  },
  fields: [
    sym('title', 0, { required: true }),
    sym('day', 1, {
      type: 'Date',
      format: 'date',
      validations: { dateRange: { min: '2026-01-01' } },
    }),
    sym('email', 2, { validations: { regexp: { preset: 'email' } } }),
    sym('poster', 3, {
      type: 'Link',
      linkType: 'Asset',
      validations: { assetMimeTypes: ['image/*'] },
    }),
  ],
};

function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: cma, body: body ? JSON.stringify(body) : undefined });
  return { send, ctx };
}

describe('content type details, layout and field settings over HTTP', () => {
  it('stores a type’s group, description, icon and layout, and a field’s format and settings', async () => {
    const { send } = setup();
    const res = await send(`${M}/content-types`, 'POST', event);
    expect(res.status, await res.clone().text()).toBe(201);
    const got = (await (await send(`${M}/content-types/event`, 'GET')).json()) as Record<
      string,
      unknown
    > & { fields: Record<string, unknown>[] };
    expect(got).toMatchObject({
      group: 'Programme',
      description: 'Something on the calendar.',
      icon: 'calendar',
      layout: event.layout,
    });
    expect(got.fields[1]).toMatchObject({ format: 'date' });
    // The preset was compiled to a pattern, and keeps its name.
    expect(got.fields[2]?.validations).toMatchObject({
      regexp: { preset: 'email', pattern: expect.any(String) },
    });
  });

  it('stores agent instructions, clears them with null and refuses too many', async () => {
    const { send } = setup();
    const path = `${M}/content-types`;
    const res = await send(path, 'POST', { ...event, agentInstructions: 'Stay factual.' });
    expect(res.status, await res.clone().text()).toBe(201);
    const read = async () =>
      (await (await send(`${path}/event`, 'GET')).json()) as Record<string, unknown>;
    expect((await read()).agentInstructions).toBe('Stay factual.');
    const tooMany = 'a'.repeat(4001);
    const refused = await send(path, 'POST', { ...event, agentInstructions: tooMany });
    expect(refused.status).toBe(422);
    await send(path, 'POST', { ...event, agentInstructions: null });
    expect(await read()).not.toHaveProperty('agentInstructions');
  });

  it('holds entries to the date format, the range and the preset', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', event);
    await send(`${M}/content-types/event/published`, 'POST');
    const ok = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'event',
      fields: {
        title: { 'en-US': 'Launch' },
        day: { 'en-US': '2026-11-03' },
        email: { 'en-US': 'ada@example.com' },
      },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const bad = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'event',
      fields: {
        title: { 'en-US': 'Launch' },
        day: { 'en-US': '2025-12-31' },
        email: { 'en-US': 'not an email' },
      },
    });
    expect(bad.status).toBe(422);
    const text = JSON.stringify(await bad.json());
    expect(text).toContain('Must be 2026-01-01 or later');
    expect(text).toContain('Does not match pattern');
  });

  it('clears a type detail with null, and refuses a layout naming no field', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', event);
    const cleared = await send(`${M}/content-types`, 'POST', {
      ...event,
      icon: null,
      layout: null,
    });
    expect(cleared.status).toBeLessThan(300);
    const got = (await cleared.json()) as Record<string, unknown>;
    expect(got).not.toHaveProperty('icon');
    expect(got).not.toHaveProperty('layout');
    expect(got.group).toBe('Programme');
    const bad = await send(`${M}/content-types`, 'POST', {
      ...event,
      layout: { tabs: [{ apiId: 'a', name: 'A', groups: [{ fields: ['nope'] }] }] },
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('not a field of this type');
  });

  it('takes a time-only Date and a list of numbers, and holds entries to them', async () => {
    const { send } = setup();
    const res = await send(`${M}/content-types`, 'POST', {
      ...event,
      layout: null,
      fields: [
        event.fields[0],
        sym('opens', 1, { type: 'Date', format: 'time' }),
        sym('sizes', 2, { type: 'Array', items: { type: 'Integer' } }),
      ],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const got = (await (await send(`${M}/content-types/event`, 'GET')).json()) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[1]).toMatchObject({ format: 'time' });
    expect(got.fields[2]).toMatchObject({ items: { type: 'Integer' } });
    await send(`${M}/content-types/event/published`, 'POST');
    const ok = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'event',
      fields: {
        title: { 'en-US': 'Launch' },
        opens: { 'en-US': '09:30' },
        sizes: { 'en-US': [1, 2] },
      },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const bad = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'event',
      fields: {
        title: { 'en-US': 'Launch' },
        opens: { 'en-US': '2026-11-03' },
        sizes: { 'en-US': [1.5] },
      },
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('Expected an integer');
  });

  it('saves a tightened Date format, and answers with how many entries it now refuses', async () => {
    const { send } = setup();
    const loose = {
      ...event,
      layout: null,
      fields: [event.fields[0], sym('at', 1, { type: 'Date' })],
    };
    await send(`${M}/content-types`, 'POST', loose);
    await send(`${M}/content-types/event/published`, 'POST');
    const made = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'event',
      fields: { title: { 'en-US': 'Launch' }, at: { 'en-US': '2026-11-03T10:00' } },
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const res = await send(`${M}/content-types`, 'POST', {
      ...loose,
      fields: [event.fields[0], sym('at', 1, { type: 'Date', format: 'date' })],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2, warnings: [{ field: 'at', entries: 1 }] });
  });

  it('documents the settings in OpenAPI', async () => {
    const { send } = setup();
    const spec = JSON.stringify(await (await send('/openapi.json', 'GET')).json());
    for (const text of [
      'Editor-only',
      'YYYY-MM-DD',
      'Inclusive bounds of a Date',
      'by family',
      'usZipCode',
      'sidebar lists types under their group',
    ]) {
      expect(spec).toContain(text);
    }
  });
});

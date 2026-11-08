import type { ApiConfig } from '@commerceworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * Delivery locales over HTTP: the space config serves each locale's settings resolved, a space
 * admin changes them, and Delivery stops serving a locale turned off while Preview keeps it.
 */
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
    locales: ['en-US', 'de-DE', 'ar'],
    scale: 1,
  },
});

const json = { 'Content-Type': 'application/json' };
const cma = { Authorization: 'Bearer cma', ...json };
const cpa = { Authorization: 'Bearer cpa' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

let app: ReturnType<typeof createApp>;
let id: string;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'greeting',
      name: 'Greeting',
      displayField: 'text',
      fields: [
        {
          apiId: 'text',
          name: 'Text',
          type: 'Symbol',
          localized: true,
          required: false,
          position: 0,
        },
      ],
    }),
  });
  await app.request(`${M}/content-types/greeting/published`, { method: 'POST', headers: cma });
  const res = await app.request(`${M}/entries`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      contentTypeApiId: 'greeting',
      fields: { text: { 'en-US': 'Hello', 'de-DE': 'Hallo', ar: 'مرحبا' } },
    }),
  });
  id = ((await res.json()) as { entry: { id: string } }).entry.id;
  await app.request(`${M}/entries/${id}/published`, { method: 'POST', headers: cma });
});

const setSettings = (headers: Record<string, string>, localeSettings: unknown) =>
  app.request(`${M}/locale-settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ localeSettings }),
  });

describe('locale settings over HTTP', () => {
  it('serves every locale resolved on the space config, and sets them for a space admin', async () => {
    const before = (await (await app.request(`${M}/space-config`, { headers: cpa })).json()) as {
      localeSettings: Record<string, { delivered: boolean; direction: string }>;
    };
    expect(before.localeSettings).toEqual({
      'en-US': { delivered: true, direction: 'ltr' },
      'de-DE': { delivered: true, direction: 'ltr' },
      ar: { delivered: true, direction: 'rtl' },
    });

    const set = await setSettings(cma, { 'de-DE': { delivered: false } });
    expect(set.status).toBe(200);
    const after = (await set.json()) as typeof before;
    expect(after.localeSettings['de-DE']).toEqual({ delivered: false, direction: 'ltr' });

    // A preview key can't, the default locale can't be turned off, an unknown key is refused.
    expect((await setSettings(cpa, { ar: { direction: 'ltr' } })).status).toBe(403);
    expect((await setSettings(cma, { 'en-US': { delivered: false } })).status).toBe(422);
    expect((await setSettings(cma, { ar: { colour: 'red' } })).status).toBe(422);
  });

  it('stops Delivery serving a locale turned off, while Preview keeps it', async () => {
    await setSettings(cma, { 'de-DE': { delivered: false } });
    const D = `/delivery/s1/main/entries`;
    expect((await app.request(`${D}/${id}?locale=de-DE`, { headers: cda })).status).toBe(404);
    expect(
      (await app.request(`${D}?content_type=greeting&locale=de-DE`, { headers: cda })).status,
    ).toBe(404);
    const all = (await (await app.request(`${D}/${id}`, { headers: cda })).json()) as {
      fields: { text: Record<string, string> };
    };
    expect(all.fields.text).toEqual({ 'en-US': 'Hello', ar: 'مرحبا' });
    const preview = await app.request(`/preview/s1/main/entries/${id}?locale=de-DE`, {
      headers: cpa,
    });
    expect(((await preview.json()) as { fields: { text: string } }).fields.text).toBe('Hallo');

    // Turned back on, it is served again.
    await setSettings(cma, { 'de-DE': { delivered: true } });
    const back = await app.request(`${D}/${id}?locale=de-DE`, { headers: cda });
    expect(((await back.json()) as { fields: { text: string } }).fields.text).toBe('Hallo');
  });

  it('answers 404 for a singleton read in a locale turned off, on Delivery only', async () => {
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'settings',
        name: 'Settings',
        displayField: 'text',
        singleton: true,
        fields: [
          {
            apiId: 'text',
            name: 'Text',
            type: 'Symbol',
            localized: true,
            required: false,
            position: 0,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/settings/published`, { method: 'POST', headers: cma });
    const made = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        contentTypeApiId: 'settings',
        fields: { text: { 'en-US': 'Hello', 'de-DE': 'Hallo' } },
      }),
    });
    const { entry } = (await made.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });
    const D = '/delivery/s1/main/singletons/settings';
    expect((await app.request(`${D}?locale=de-DE`, { headers: cda })).status).toBe(200);

    await setSettings(cma, { 'de-DE': { delivered: false } });
    for (const qs of ['locale=de-DE', 'locale=de-DE&include=0']) {
      expect((await app.request(`${D}?${qs}`, { headers: cda })).status).toBe(404);
    }
    const all = (await (await app.request(D, { headers: cda })).json()) as {
      fields: { text: Record<string, string> };
    };
    expect(all.fields.text).toEqual({ 'en-US': 'Hello' });
    const preview = await app.request(`/preview/s1/main/singletons/settings?locale=de-DE`, {
      headers: cpa,
    });
    expect(((await preview.json()) as { fields: { text: string } }).fields.text).toBe('Hallo');
  });

  it('neither finds nor quotes a locale turned off, on REST /search and GraphQL search', async () => {
    const D = '/delivery/s1/main';
    const hits = async () =>
      (
        (await (
          await app.request(`${D}/search?q=hallo&mode=lexical`, { headers: cda })
        ).json()) as { hits: { entryId: string }[] }
      ).hits.map((h) => h.entryId);
    const graph = async () => {
      const res = await app.request(`${D}/graphql`, {
        method: 'POST',
        headers: { ...cda, ...json },
        body: JSON.stringify({ query: '{ search(query: "hallo") { entryId snippet } }' }),
      });
      return ((await res.json()) as { data: { search: { entryId: string }[] } }).data.search;
    };
    expect(await hits()).toEqual([id]);
    expect((await graph()).map((h) => h.entryId)).toEqual([id]);

    await setSettings(cma, { 'de-DE': { delivered: false } });
    expect(await hits()).toEqual([]);
    expect(await graph()).toEqual([]);
  });
});

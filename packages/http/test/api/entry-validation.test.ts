import { createContentType, publishContentType, SYSTEM_CALLER } from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

/** The app over its fakes, with a published `post` type: a required title and a unique slug. */
async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol', required: true }),
      field({ apiId: 'slug', type: 'Slug', unique: true, position: 1 }),
    ],
  });
  await publishContentType(wired.ctx, scope, 'post');
  const send = (path: string, body: unknown, headers = admin, method = 'POST') =>
    app.request(`${M}${path}`, { method, headers, body: JSON.stringify(body) });
  return { app, send, ctx: wired.ctx };
}

describe('POST /entries/validate', () => {
  it('answers 200 with the fields a create would store, and creates nothing', async () => {
    const { ctx, send } = await makeApp();
    const res = await send('/entries/validate', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'Hello World' } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'hello-world' } },
      skippedHooks: [],
    });

    expect(await ctx.store.entries.list(scope, {})).toHaveLength(0);
  });

  it('fails with the body a failed create answers', async () => {
    const { send } = await makeApp();
    const input = { contentTypeApiId: 'post', fields: { slug: { 'en-US': 'x' } } };
    const dry = await send('/entries/validate', input);
    const real = await send('/entries', input);
    expect(dry.status).toBe(422);
    expect(real.status).toBe(422);
    expect(await dry.json()).toEqual(await real.json());
  });

  it('answers 409 for a unique value another entry holds, as a save does', async () => {
    const { send } = await makeApp();
    await send('/entries', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'One' }, slug: { 'en-US': 'about' } },
    });
    const two = await send('/entries', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Two' }, slug: { 'en-US': 'two' } },
    });
    const { entry } = (await two.json()) as { entry: { id: string } };
    const fields = { title: { 'en-US': 'Two' }, slug: { 'en-US': 'about' } };

    const dry = await send('/entries/validate', { entryId: entry.id, fields });
    const real = await send(`/entries/${entry.id}`, { fields }, admin, 'PUT');
    expect(dry.status).toBe(409);
    expect(await dry.json()).toEqual(await real.json());

    // Its own value is no conflict: validated as a new version of itself.
    const own = await send('/entries/validate', {
      entryId: entry.id,
      fields: { title: { 'en-US': 'Two!' }, slug: { 'en-US': 'two' } },
    });
    expect(own.status).toBe(200);
  });

  it('refuses a body naming both a type and an entry, or neither', async () => {
    const { send } = await makeApp();
    const both = await send('/entries/validate', { contentTypeApiId: 'post', entryId: 'e1' });
    const neither = await send('/entries/validate', { fields: {} });
    expect(both.status).toBe(422);
    expect(neither.status).toBe(422);
  });

  it('is gated like the save it stands in for', async () => {
    const { send } = await makeApp();
    const res = await send(
      '/entries/validate',
      { contentTypeApiId: 'post', fields: { title: { 'en-US': 'x' } } },
      cpa,
    );
    expect(res.status).toBe(403);
  });
});

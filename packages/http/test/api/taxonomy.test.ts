import {
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setEntryMetadata,
} from '@commerceworker/application';
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
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';
const scope = { spaceId: 's1', environmentId: 'main' };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** An app with a `story` and a `memo` type and one published entry of each carrying `tagId`. */
async function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const ctx = wired.ctx;
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = admin,
  ) =>
    app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  for (const apiId of ['story', 'memo']) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
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
      ],
    });
    await publishContentType(ctx, scope, apiId);
  }
  const publishTagged = async (type: string, tagId: string) => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: type,
      fields: { title: { 'en-US': type } },
    });
    await setEntryMetadata(ctx, scope, entry.id, { tags: [tagId] });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  };
  return { app, ctx, send, publishTagged };
}

describe('taxonomy over HTTP', () => {
  it('creates and edits tags with slugs, descriptions and localized labels', async () => {
    const { send } = await setup();
    const created = await send('POST', `${M}/taxonomy/tags`, {
      name: 'Archive Me',
      description: 'For archive pages',
      labels: { de: 'Archiv' },
    });
    expect(created.status).toBe(201);
    const tag = await json<{ id: string; slug: string }>(created);
    expect(tag).toMatchObject({ slug: 'archive-me', labels: { de: 'Archiv' } });

    expect(
      (await send('POST', `${M}/taxonomy/tags`, { name: 'Other', slug: 'archive-me' })).status,
    ).toBe(409);
    expect(
      (await send('POST', `${M}/taxonomy/tags`, { name: 'Bad', labels: { fr: 'Non' } })).status,
    ).toBe(422);

    const renamed = await send('PATCH', `${M}/taxonomy/tags/${tag.id}`, { name: 'Archived' });
    expect(await json(renamed)).toMatchObject({ name: 'Archived', slug: 'archive-me' });
    expect((await send('PATCH', `${M}/taxonomy/tags/ghost`, { name: 'x' })).status).toBe(404);
    // A delivery key can't change the vocabulary.
    expect(
      (
        await send(
          'POST',
          `${M}/taxonomy/tags`,
          { name: 'Nope' },
          { ...cda, 'Content-Type': 'application/json' },
        )
      ).status,
    ).toBe(403);
  });

  it('serves tags, their counts and their entries on Delivery', async () => {
    const { send, publishTagged } = await setup();
    const tag = await json<{ id: string }>(
      await send('POST', `${M}/taxonomy/tags`, { name: 'Featured', labels: { de: 'Empfohlen' } }),
    );
    const story = await publishTagged('story', tag.id);
    await publishTagged('memo', tag.id);

    const managed = await json<{ items: { id: string; usage: { count: number } }[] }>(
      await send('GET', `${M}/taxonomy/tags`),
    );
    expect(managed.items.find((t) => t.id === tag.id)?.usage.count).toBe(2);

    const listed = await json<{ items: { slug: string; label: string; count: number }[] }>(
      await send('GET', `${D}/taxonomy/tags?locale=de`, undefined, cda),
    );
    expect(listed.items.find((t) => t.slug === 'featured')).toMatchObject({
      label: 'Empfohlen',
      count: 2,
    });
    const one = await send('GET', `${D}/taxonomy/tags/featured?content_type=story`, undefined, cda);
    expect(await json(one)).toMatchObject({ count: 1, countsByContentType: { story: 1 } });
    expect((await send('GET', `${D}/taxonomy/tags/nope`, undefined, cda)).status).toBe(404);

    const entries = await json<{ items: { id: string }[] }>(
      await send(
        'GET',
        `${D}/entries?content_type=story&metadata.tags.slug=featured`,
        undefined,
        cda,
      ),
    );
    expect(entries.items.map((e) => e.id)).toEqual([story]);

    expect(await json(await send('POST', `${M}/taxonomy/repair`))).toEqual({ slugsAssigned: 0 });
  });

  it('counts only the content types a limited key may read', async () => {
    const { app, send, publishTagged } = await setup();
    const tag = await json<{ id: string }>(
      await send('POST', `${M}/taxonomy/tags`, { name: 'Mixed' }),
    );
    await publishTagged('story', tag.id);
    await publishTagged('memo', tag.id);
    const role = await json<{ id: string }>(
      await send('POST', '/spaces/s1/roles', {
        name: 'Stories only',
        scopes: ['delivery:read'],
        contentGrants: [{ contentTypeApiId: 'story', actions: ['read'] }],
      }),
    );
    const { token } = await json<{ token: string }>(
      await send('POST', '/spaces/s1/api-keys', { kind: 'cda', roleId: role.id }),
    );
    const res = await app.request(`${D}/taxonomy/tags/mixed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await json(res)).toMatchObject({ count: 1, countsByContentType: { story: 1 } });
  });

  it('serves concepts by slug, refusing a slug two schemes share without scheme', async () => {
    const { send } = await setup();
    const ids: string[] = [];
    for (const name of ['Topics', 'Places']) {
      const scheme = await json<{ id: string }>(
        await send('POST', `${M}/taxonomy/schemes`, { name }),
      );
      ids.push(scheme.id);
      const concept = await send('POST', `${M}/taxonomy/concepts`, {
        schemeId: scheme.id,
        prefLabel: 'Paris',
      });
      expect(await json(concept)).toMatchObject({ slug: 'paris' });
    }
    expect((await send('GET', `${D}/taxonomy/concepts/paris`, undefined, cda)).status).toBe(409);
    const one = await send('GET', `${D}/taxonomy/concepts/paris?scheme=${ids[1]}`, undefined, cda);
    expect(await json(one)).toMatchObject({ schemeId: ids[1], label: 'Paris', count: 0 });
    const listed = await json<{ items: unknown[] }>(
      await send('GET', `${D}/taxonomy/concepts?scheme=${ids[0]}`, undefined, cda),
    );
    expect(listed.items).toHaveLength(1);
  });
});

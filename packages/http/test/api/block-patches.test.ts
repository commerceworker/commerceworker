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
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const symbol = (apiId: string, position = 0, required = false) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required,
  position,
});
const blocks = (apiId: string, variants: unknown[], position: number) => ({
  apiId,
  name: apiId,
  type: 'Array',
  localized: false,
  required: false,
  position,
  items: { type: 'Component', variants },
});

const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 0, true)] };
const cta = { apiId: 'cta', name: 'Call to action', fields: [symbol('label', 0, true)] };
const section = {
  apiId: 'section',
  name: 'Section',
  fields: [symbol('title'), blocks('items', [hero, cta], 1)],
};

interface Saved {
  entry: { id: string; currentVersion: number };
  fields: { body: { 'en-US': { _type: string; _key: string; items?: { _key: string }[] }[] } };
  keys: Record<string, string>;
  inverse: unknown[];
}

async function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown, headers = cma) =>
    app.request(`${M}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  const type = {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      symbol('title', 0, true),
      blocks('body', [hero, cta, section], 1),
      // For a role that may read but not write one, and may not read the other.
      blocks('sidebar', [cta], 2),
      { ...symbol('notes', 3), type: 'Symbol' },
    ],
  };
  expect((await send('/content-types', 'POST', type)).status).toBe(201);
  await send('/content-types/page/published', 'POST');
  const created = (await (
    await send('/entries', 'POST', {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: {
          'en-US': [
            { _type: 'hero', heading: 'Welcome' },
            { _type: 'section', title: 'Features', items: [{ _type: 'cta', label: 'Try' }] },
          ],
        },
      },
    })
  ).json()) as Saved;
  const [h, s] = created.fields.body['en-US'];
  /** A key whose role writes `page` but may only read `sidebar`, and may not read `notes`. */
  const restricted = async () => {
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Page editor',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [
          {
            contentTypeApiId: 'page',
            actions: ['read', 'write'],
            readOnlyFields: ['sidebar'],
            deniedFields: ['notes'],
          },
        ],
      }),
    });
    expect(role.status).toBe(201);
    const { id: roleId } = (await role.json()) as { id: string };
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const { token } = (await key.json()) as { token: string };
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  return {
    app,
    send,
    restricted,
    id: created.entry.id,
    hero: h?._key as string,
    section: s?._key as string,
    cta: s?.items?.[0]?._key as string,
  };
}

describe('patching an entry’s blocks over HTTP', () => {
  it('applies key-addressed ops as one new draft version', async () => {
    const { send, id, hero, section, cta } = await setup();
    const res = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: [
        {
          op: 'insert',
          field: 'body',
          parent: { key: section, slot: 'items' },
          before: cta,
          block: { _type: 'hero', heading: 'Fast' },
          ref: 'fast',
        },
        { op: 'move', field: 'body', key: hero, to: { after: section } },
        { op: 'update', field: 'body', key: cta, set: { label: 'Try it free' } },
      ],
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Saved;
    expect(saved.entry.currentVersion).toBe(2);
    const body = saved.fields.body['en-US'];
    expect(body.map((b) => b._key)).toEqual([section, hero]);
    expect(body[0]?.items).toEqual([
      { _type: 'hero', _key: saved.keys.fast, heading: 'Fast' },
      { _type: 'cta', _key: cta, label: 'Try it free' },
    ]);
    // The outline reads the new version back, ready for the next patch.
    const outline = await send(`/entries/${id}/blocks?field=body`, 'GET');
    expect(outline.status).toBe(200);
    const read = (await outline.json()) as { version: number; fields: Record<string, unknown> };
    expect(read.version).toBe(2);
    expect(read.fields).toMatchObject({
      body: {
        'en-US': [
          {
            key: section,
            type: 'section',
            path: 'body[0]',
            children: { items: [{ key: saved.keys.fast, label: 'Fast' }, { key: cta }] },
          },
          { key: hero, type: 'hero', name: 'Hero', label: 'Welcome', path: 'body[1]' },
        ],
      },
    });
  });

  it('undoes a patch with its inverse', async () => {
    const { send, id, section } = await setup();
    const before = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    const patched = (await (
      await send(`/entries/${id}/blocks`, 'PATCH', {
        expectedVersion: 1,
        ops: [{ op: 'duplicate', field: 'body', key: section }],
      })
    ).json()) as Saved;
    const undone = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 2,
      ops: patched.inverse,
    });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as Saved).fields).toEqual(before.fields);
  });

  it('answers 409 for a stale expectedVersion and 422 naming the op that failed', async () => {
    const { send, id, hero } = await setup();
    const stale = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 7,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('conflict');

    const bad = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: [
        { op: 'remove', field: 'body', key: hero },
        { op: 'move', field: 'body', key: hero, to: { index: 0 } },
      ],
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { issues: unknown[] } }).error.issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: 'en-US',
        code: 'unknown_key',
        message: `No block with _key "${hero}" in body (en-US)`,
      },
    ]);
    // Neither saved anything.
    const now = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    expect(now.entry.currentVersion).toBe(1);
  });

  it('refuses a body without expectedVersion or with too many ops', async () => {
    const { send, id, hero } = await setup();
    const op = { op: 'remove', field: 'body', key: hero };
    expect((await send(`/entries/${id}/blocks`, 'PATCH', { ops: [op] })).status).toBe(422);
    const many = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: Array.from({ length: 101 }, () => op),
    });
    expect(many.status).toBe(422);
  });

  it('needs content write to patch and preview read to outline', async () => {
    const { send, id, hero } = await setup();
    const patch = await send(
      `/entries/${id}/blocks`,
      'PATCH',
      { expectedVersion: 1, ops: [{ op: 'remove', field: 'body', key: hero }] },
      cpa,
    );
    expect(patch.status).toBe(403);
    expect((await send(`/entries/${id}/blocks`, 'GET', undefined, cpa)).status).toBe(200);
  });

  it('checks a patch without saving it, with the same refusals', async () => {
    const { send, id, hero } = await setup();
    const res = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 1,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(res.status).toBe(200);
    const checked = (await res.json()) as {
      valid: boolean;
      fields: Saved['fields'];
      applied: unknown[];
    };
    expect(checked.valid).toBe(true);
    expect(checked.fields.body['en-US'].map((b) => b._type)).toEqual(['section']);
    expect(checked.applied).toEqual([{ op: 'remove', field: 'body', locale: 'en-US', key: hero }]);
    // Nothing was written.
    const now = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    expect(now.entry.currentVersion).toBe(1);

    const stale = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 2,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(stale.status).toBe(409);
    const broken = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 1,
      ops: [{ op: 'update', field: 'body', key: hero, unset: ['heading'] }],
    });
    expect(broken.status).toBe(422);
    // The rule's issue names the block it falls in by key, not only by position.
    const issues = ((await broken.json()) as { error: { issues: unknown[] } }).error.issues;
    expect(issues[0]).toMatchObject({
      field: 'body[0].heading',
      block: { key: hero, type: 'hero', path: 'heading' },
    });
    const preview = await send(
      '/entries/blocks/validate',
      'POST',
      { entryId: id, expectedVersion: 1, ops: [{ op: 'remove', field: 'body', key: hero }] },
      cpa,
    );
    expect(preview.status).toBe(403);
  });

  it('says what a role refused on both the patch and its dry run, naming no hidden field', async () => {
    const { send, id, restricted } = await setup();
    const editor = await restricted();
    const insert = (field: string) => ({
      expectedVersion: 1,
      ops: [{ op: 'insert', field, block: { _type: 'cta', label: 'x' } }],
    });
    for (const [path, method, body] of [
      [`/entries/${id}/blocks`, 'PATCH', (f: string) => insert(f)],
      ['/entries/blocks/validate', 'POST', (f: string) => ({ entryId: id, ...insert(f) })],
    ] as const) {
      const locked = await send(path, method, body('sidebar'), editor);
      expect(locked.status).toBe(403);
      expect(((await locked.json()) as { error: { details: unknown } }).error.details).toEqual({
        reason: 'read_only',
        field: 'sidebar',
      });
      const hidden = await send(path, method, body('notes'), editor);
      expect(hidden.status).toBe(403);
      const text = await hidden.text();
      expect(JSON.parse(text).error.details).toEqual({ reason: 'hidden', hidden: 1 });
      expect(text).not.toContain('notes');
    }
    // Nothing was saved.
    const now = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    expect(now.entry.currentVersion).toBe(1);
  });

  it('counts a stored value it can’t read that fails a rule, never naming it', async () => {
    const { send, id, hero, restricted } = await setup();
    // Someone else's rule, tightened after the entry was saved without notes.
    const type = (await (await send('/content-types/page', 'GET')).json()) as {
      fields: { apiId: string; required: boolean }[];
    };
    const tightened = await send('/content-types', 'POST', {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: type.fields.map((f) => (f.apiId === 'notes' ? { ...f, required: true } : f)),
    });
    expect([200, 201], await tightened.text()).toContain(tightened.status);
    await send('/content-types/page/published', 'POST');
    const editor = await restricted();
    const ops = [{ op: 'update', field: 'body', key: hero, set: { heading: 'Hi' } }];
    for (const [path, method, body] of [
      [`/entries/${id}/blocks`, 'PATCH', { expectedVersion: 1, ops }],
      ['/entries/blocks/validate', 'POST', { entryId: id, expectedVersion: 1, ops }],
    ] as const) {
      const res = await send(path, method, body, editor);
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text).error.issues).toEqual([
        expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
      ]);
      expect(text).not.toContain('notes');
    }
  });

  it('is described in the OpenAPI document with the body it parses', async () => {
    const { app } = await setup();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown; summary?: string }>>;
    };
    const path = spec.paths['/spaces/{space}/environments/{env}/entries/{id}/blocks'];
    expect(path?.patch?.summary).toBe('Patch an entry’s blocks');
    expect(path?.patch?.requestBody).toBeDefined();
    expect(path?.get?.summary).toBe('Outline an entry’s blocks');
  });
});

import {
  createContentType,
  createEntry,
  entryFieldsChunkRunner,
  publishContentType,
  runBulkChunk,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { BulkChunkDueEvent, FieldDefinition } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { InMemoryContentStore } from '@commerceworker/test-kit';
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
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const symbol = (apiId: string, position: number): FieldDefinition =>
  ({
    apiId,
    name: apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
  }) as FieldDefinition;

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [symbol('title', 0), symbol('status', 1), symbol('owner', 2)],
  });
  await publishContentType(wired.ctx, scope, 'note');
  const ids: string[] = [];
  for (const title of ['a', 'b']) {
    const { entry } = await createEntry(wired.ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title } },
    });
    ids.push(entry.id);
  }
  const store = wired.ctx.store as InMemoryContentStore;
  /** Runs every chunk the outbox holds, as the engine's bulk consumer would. */
  const runChunks = async () => {
    for (const e of store.allEvents().filter((x) => x.type === 'bulk.chunk_due')) {
      await runBulkChunk(wired.ctx, e as BulkChunkDueEvent, {
        entryFieldsChunk: entryFieldsChunkRunner(wired.ctx),
      });
    }
  };
  const start = (body: unknown, headers: Record<string, string> = cma) =>
    app.request(`${M}/bulk/jobs/set-fields`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  /** A key whose role writes notes, with `readOnlyFields` read-only. */
  /** A key in `space` whose role holds `grants`. */
  const keyWith = async (
    name: string,
    grants: Record<string, unknown>[] | undefined,
    space = 's1',
    scopes = ['content:write', 'content:publish', 'preview:read'],
  ) => {
    const role = await json<{ id: string }>(
      await app.request(`/spaces/${space}/roles`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ name, scopes, contentGrants: grants }),
      }),
    );
    const { token } = await json<{ token: string }>(
      await app.request(`/spaces/${space}/api-keys`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      }),
    );
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  /** A key whose role writes notes, with `readOnlyFields` read-only. */
  const keyFor = (readOnlyFields: string[]) =>
    keyWith(
      `Notes ${readOnlyFields.join(',') || 'all'}`,
      [{ contentTypeApiId: 'note', actions: ['read', 'write'], readOnlyFields }],
      's1',
      ['content:write', 'preview:read'],
    );
  return { app, store, ids, runChunks, start, keyFor, keyWith };
}

describe('bulk field edit over HTTP', () => {
  it('sets a field on a selection through POST /bulk/jobs/set-fields', async () => {
    const h = await makeApp();
    const res = await h.start({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { status: { 'en-US': 'reviewed' } },
    });
    expect(res.status).toBe(202);
    const job = await json<{ id: string; action: string }>(res);
    expect(job.action).toBe('set_fields');
    await h.runChunks();

    const done = await json<{ status: string; succeeded: number }>(
      await h.app.request(`${M}/bulk/jobs/${job.id}`, { headers: cma }),
    );
    expect(done).toMatchObject({ status: 'completed', succeeded: 2 });
    for (const [i, id] of h.ids.entries()) {
      expect((await h.store.entries.get(scope, id))?.fields).toEqual({
        title: { 'en-US': ['a', 'b'][i] },
        status: { 'en-US': 'reviewed' },
      });
    }
  });

  it('refuses a field the type lacks before starting, with a 422', async () => {
    const h = await makeApp();
    const res = await h.start({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { colour: { 'en-US': 'red' } },
    });
    expect(res.status).toBe(422);
    expect(h.store.allEvents().some((e) => e.type === 'bulk.chunk_due')).toBe(false);
  });

  it('lets a role limited to the type start one, but not on a field it may only read', async () => {
    const h = await makeApp();
    const limited = await h.keyFor(['owner']);
    const body = (field: string) => ({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { [field]: { 'en-US': 'x' } },
    });
    expect((await h.start(body('owner'), limited)).status).toBe(403);
    const ok = await h.start(body('status'), limited);
    expect(ok.status).toBe(202);
    const job = await json<{ id: string }>(ok);
    // Its report stays closed: the role has a field rule on the type, and a failure can quote a value.
    expect(
      (await h.app.request(`${M}/bulk/jobs/${job.id}/report`, { headers: limited })).status,
    ).toBe(403);
    const open = await h.keyFor([]);
    expect((await h.app.request(`${M}/bulk/jobs/${job.id}/report`, { headers: open })).status).toBe(
      200,
    );
  });

  it('never shows the values it sets to whoever reads job progress', async () => {
    const h = await makeApp();
    const job = await json<{ id: string; config: unknown }>(
      await h.start({
        contentTypeApiId: 'note',
        entryIds: h.ids,
        fields: { owner: { 'en-US': 'secret-owner' } },
      }),
    );
    expect(job.config).toMatchObject({ contentTypeApiId: 'note', fieldNames: ['owner'] });
    expect(job.config).not.toHaveProperty('fields');
    const denied = await h.keyWith('No owner', [
      { contentTypeApiId: 'note', actions: ['read', 'write'], deniedFields: ['owner'] },
    ]);
    const otherType = await h.keyWith('Pages only', [
      { contentTypeApiId: 'page', actions: ['read', 'write'] },
    ]);
    for (const headers of [denied, otherType, cma]) {
      for (const path of [`${M}/bulk/jobs`, `${M}/bulk/jobs/${job.id}`]) {
        const res = await h.app.request(path, { headers });
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).not.toContain('secret-owner');
      }
    }
  });

  it('refuses a role without write on the type, a key for another space, and cancelling from another type', async () => {
    const h = await makeApp();
    const body = {
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { status: { 'en-US': 'x' } },
    };
    const reader = await h.keyWith('Read notes', [{ contentTypeApiId: 'note', actions: ['read'] }]);
    expect((await h.start(body, reader)).status).toBe(403);

    await h.app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
    const elsewhere = await h.keyWith('Second writer', undefined, 's2');
    expect((await h.start(body, elsewhere)).status).toBe(403);

    const job = await json<{ id: string }>(await h.start(body));
    const otherType = await h.keyWith('Pages only', [
      { contentTypeApiId: 'page', actions: ['read', 'write', 'publish'] },
    ]);
    const cancel = (headers: Record<string, string>) =>
      h.app.request(`${M}/bulk/jobs/${job.id}/cancel`, { method: 'POST', headers });
    expect((await cancel(otherType)).status).toBe(403);
    expect((await cancel(await h.keyFor([]))).status).toBe(403); // content:write alone can't cancel
    expect(
      (
        await cancel(
          await h.keyWith('Notes publisher', [
            { contentTypeApiId: 'note', actions: ['read', 'write', 'publish'] },
          ]),
        )
      ).status,
    ).toBe(200);
  });
});

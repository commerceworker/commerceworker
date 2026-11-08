import {
  createContentType,
  createEntry,
  entryTrashChunkRunner,
  publishContentType,
  runBulkChunk,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { BulkChunkDueEvent, FieldDefinition } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
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

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      } as FieldDefinition,
    ],
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
        entryTrashChunk: entryTrashChunkRunner(wired.ctx, { blob: wired.blob }),
      });
    }
  };
  const start = (action: string, entryIds: string[], headers = cma) =>
    app.request(`${M}/bulk/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, entryIds }),
    });
  return { app, store, ids, runChunks, start };
}

describe('bulk trash, restore and purge jobs over HTTP', () => {
  it('trashes, then purges, a selection through POST /bulk/jobs', async () => {
    const h = await makeApp();

    const trash = await h.start('trash', h.ids);
    expect(trash.status).toBe(202);
    const trashJob = await json<{ id: string; action: string }>(trash);
    expect(trashJob.action).toBe('trash');
    await h.runChunks();
    const status = await json<{ status: string; succeeded: number }>(
      await h.app.request(`${M}/bulk/jobs/${trashJob.id}`, { headers: cma }),
    );
    expect(status).toMatchObject({ status: 'completed', succeeded: 2 });
    for (const id of h.ids) {
      expect((await h.store.entries.get(scope, id))?.entry.status).toBe('archived');
    }

    const purge = await h.start('purge', h.ids);
    expect(purge.status).toBe(202);
    await h.runChunks();
    for (const id of h.ids) expect(await h.store.entries.get(scope, id)).toBeNull();
  });

  it('reports a purge of an entry not in the trash per item', async () => {
    const h = await makeApp();
    const job = await json<{ id: string }>(await h.start('purge', h.ids.slice(0, 1)));
    await h.runChunks();
    const report = await json<{ job: { failed: number }; chunks: { failures: unknown[] }[] }>(
      await h.app.request(`${M}/bulk/jobs/${job.id}/report`, { headers: cma }),
    );
    expect(report.job.failed).toBe(1);
    expect(report.chunks[0]?.failures).toEqual([
      { id: h.ids[0], error: expect.stringContaining('trash') },
    ]);
  });

  it('refuses an unknown action, and a role restricted by content type', async () => {
    const h = await makeApp();
    expect((await h.start('delete', h.ids)).status).toBe(422);

    const role = await json<{ id: string }>(
      await h.app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: 'Notes only',
          scopes: ['content:write', 'content:publish', 'preview:read'],
          contentGrants: [{ contentTypeApiId: 'note', actions: ['read', 'write', 'publish'] }],
        }),
      }),
    );
    const { token } = await json<{ token: string }>(
      await h.app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      }),
    );
    const restricted = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await h.start('trash', h.ids, restricted)).status).toBe(403);

    // What the admin asks first, so it offers these actions only to a role that may take them.
    const me = async (headers: Record<string, string>) =>
      json<{ scopes: string[]; restricted: boolean }>(
        await h.app.request('/spaces/s1/auth/me', { headers }),
      );
    expect(await me(restricted)).toMatchObject({ restricted: true });
    expect(await me(cma)).toMatchObject({ restricted: false });
    expect((await me(cma)).scopes).toContain('content:publish');
  });
});

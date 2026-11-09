import {
  createContentType,
  createEntry,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { createManagementClient } from '@commerceworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({ adminToken: 'admin' });
const scope = { spaceId: 's1', environmentId: 'main' };

/** sdk-management's saved-view methods against the real routes. */
describe('saved views through the SDK', () => {
  it('saves, runs, changes and deletes a shared view', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
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
          required: false,
          position: 0,
        },
      ],
    });
    await publishContentType(wired.ctx, scope, 'note');
    for (const title of ['Alpha', 'Beta']) {
      await createEntry(wired.ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': title } },
      });
    }
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });

    const view = await cma.savedViews.create({
      name: 'B notes',
      contentTypeApiId: 'note',
      visibility: 'shared',
      query: { where: { or: [{ field: 'title', op: 'startsWith', value: 'B' }] } },
      columns: ['sys.status'],
    });
    expect((await cma.savedViews.list({ contentType: 'note' })).map((v) => v.id)).toEqual([
      view.id,
    ]);
    const run = await cma.savedViews.run(view.id);
    expect(run.items.map((e) => (e.fields.title as Record<string, string>)['en-US'])).toEqual([
      'Beta',
    ]);
    const changed = await cma.savedViews.update(view.id, {
      columns: null,
      revision: view.revision,
    });
    expect(changed.columns).toBeUndefined();
    await expect(cma.savedViews.delete(view.id, { revision: view.revision })).rejects.toThrow();
    await cma.savedViews.delete(view.id, { revision: changed.revision });
    expect(await cma.savedViews.list()).toEqual([]);
  });
});

import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { createDeliveryClient, DeliveryError } from '@commerceworker/sdk-core';
import { createManagementClient } from '@commerceworker/sdk-management';
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

/** The SDKs' menu methods against the real routes: manage with one, render with the other. */
describe('menus through the SDKs', () => {
  it('builds a menu with sdk-management and reads it resolved with sdk-core', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });
    const cda = createDeliveryClient({
      baseUrl: 'http://localhost',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch,
    });

    const menu = await cma.menus.create({
      handle: 'footer',
      name: 'Footer',
      items: [
        { id: 'legal', label: 'Legal', link: { type: 'url', url: '/legal' } },
        { id: 'contact', label: 'Contact', link: { type: 'url', url: 'mailto:hi@example.com' } },
      ],
    });
    const moved = await cma.menus.moveItem(menu.id, {
      itemId: 'contact',
      parentId: 'legal',
      index: 0,
      revision: menu.revision,
    });
    await cma.menus.update(menu.id, { name: 'Site footer', revision: moved.revision });
    expect((await cma.menus.list()).map((m) => [m.handle, m.itemCount])).toEqual([['footer', 2]]);
    expect((await cma.menus.preview(menu.id)).items[0]?.status).toBe('live');

    expect(await cda.menus()).toEqual([{ handle: 'footer', name: 'Site footer' }]);
    const delivered = await cda.menu('footer', { locale: 'de' });
    expect(delivered.items).toEqual([
      {
        id: 'legal',
        label: 'Legal',
        url: '/legal',
        children: [{ id: 'contact', label: 'Contact', url: 'mailto:hi@example.com', children: [] }],
      },
    ]);
    const missing = await cda.menu('nope').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(DeliveryError);
    expect((missing as DeliveryError).status).toBe(404);

    await cma.menus.delete(menu.id);
    expect(await cda.menus()).toEqual([]);
  });
});

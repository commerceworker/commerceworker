// @vitest-environment jsdom
import type { DeliveryClient } from '@commerceworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { type App, createApp, defineComponent, h, nextTick, ref } from 'vue';
import {
  createCommerceworker,
  useDeliveryClient,
  useEntries,
  useEntry,
  useSemanticSearch,
} from '../src/index.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stubClient(overrides: Partial<Record<keyof DeliveryClient, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const client = {
    getEntry: record('getEntry', { id: 'e1', fields: { title: 'Hello' } }),
    listEntries: record('listEntries', { items: [{ id: 'e1' }], total: 1 }),
    search: record('search', [{ entryId: 'e1', score: 1, snippet: 'hit' }]),
    ...overrides,
  } as unknown as DeliveryClient;
  return { client, calls };
}

/** Mounts a throwaway component running `setup`, with the plugin installed. */
function withSetup<T>(client: DeliveryClient, setup: () => T): { result: T; app: App } {
  let result!: T;
  const app = createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => h('div');
      },
    }),
  );
  app.use(createCommerceworker(client));
  app.mount(document.createElement('div'));
  return { result, app };
}

describe('@commerceworker/sdk-vue composables', () => {
  it('useDeliveryClient throws without the plugin', () => {
    const app = createApp(
      defineComponent({
        setup() {
          expect(() => useDeliveryClient()).toThrow(/createCommerceworker/);
          return () => h('div');
        },
      }),
    );
    app.mount(document.createElement('div'));
    app.unmount();
  });

  it('useEntry fetches on mount and exposes data/loading', async () => {
    const { client, calls } = stubClient();
    const { result, app } = withSetup(client, () => useEntry('e1', { locale: 'en-US' }));
    expect(result.loading.value).toBe(true);
    await flush();
    expect(result.loading.value).toBe(false);
    expect((result.data.value as { id: string } | undefined)?.id).toBe('e1');
    expect(calls[0]).toEqual({
      method: 'getEntry',
      args: ['e1', { locale: 'en-US', include: undefined }],
    });
    app.unmount();
  });

  it('re-fetches when a reactive input changes', async () => {
    const { client, calls } = stubClient();
    const id = ref('a');
    const { result, app } = withSetup(client, () => useEntry(id));
    await flush();
    expect(calls).toHaveLength(1);

    id.value = 'b';
    await nextTick();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0]).toBe('b');
    expect(result.loading.value).toBe(false);
    app.unmount();
  });

  it('discards a stale settlement that resolves after a newer request', async () => {
    // Deferred-controlled getEntry: the FIRST request resolves LAST.
    const pending: { id: string; resolve: (v: unknown) => void }[] = [];
    const client = {
      getEntry: (id: string) =>
        new Promise((resolve) => {
          pending.push({ id, resolve });
        }),
    } as unknown as DeliveryClient;
    const id = ref('stale');
    const { result, app } = withSetup(client, () => useEntry(id));
    await flush();
    id.value = 'fresh';
    await nextTick();
    await flush();
    expect(pending.map((p) => p.id)).toEqual(['stale', 'fresh']);

    // Newer request settles first…
    pending[1]?.resolve({ id: 'fresh' });
    await flush();
    expect((result.data.value as { id: string } | undefined)?.id).toBe('fresh');
    expect(result.loading.value).toBe(false);

    // …then the stale one lands and must be ignored.
    pending[0]?.resolve({ id: 'stale' });
    await flush();
    expect((result.data.value as { id: string } | undefined)?.id).toBe('fresh');
    app.unmount();
  });

  it('a re-fetch clears the previous data (no stale-while-error)', async () => {
    let calls = 0;
    const client = {
      getEntry: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ id: 'first' })
          : Promise.reject(new Error('second failed'));
      },
    } as unknown as DeliveryClient;
    const id = ref('a');
    const { result, app } = withSetup(client, () => useEntry(id));
    await flush();
    expect((result.data.value as { id: string } | undefined)?.id).toBe('first');

    id.value = 'b';
    await nextTick();
    await flush();
    expect(result.error.value?.message).toBe('second failed');
    expect(result.data.value).toBeUndefined();
    app.unmount();
  });

  it('useEntries forwards the query and surfaces totals', async () => {
    const { client, calls } = stubClient();
    const { result, app } = withSetup(client, () =>
      useEntries({ contentType: 'article', limit: 5 }),
    );
    await flush();
    expect(result.data.value?.total).toBe(1);
    expect(calls[0]?.args[0]).toEqual({ contentType: 'article', limit: 5 });
    app.unmount();
  });

  it('useSemanticSearch short-circuits empty queries without a request', async () => {
    const { client, calls } = stubClient();
    const q = ref('');
    const { result, app } = withSetup(client, () => useSemanticSearch(q));
    await flush();
    expect(result.data.value).toEqual([]);
    expect(calls).toHaveLength(0);

    q.value = 'databases';
    await nextTick();
    await flush();
    expect(calls).toEqual([{ method: 'search', args: ['databases', { topK: undefined }] }]);
    expect(result.data.value).toHaveLength(1);
    app.unmount();
  });

  it('surfaces rejections as error refs', async () => {
    const { client } = stubClient({
      getEntry: () => Promise.reject(new Error('not found')),
    });
    const { result, app } = withSetup(client, () => useEntry('missing'));
    await flush();
    expect(result.error.value?.message).toBe('not found');
    expect(result.loading.value).toBe(false);
    expect(result.data.value).toBeUndefined();
    app.unmount();
  });
});

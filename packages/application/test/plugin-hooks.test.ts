import {
  type PluginCapability,
  type PluginManifest,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { PluginCapabilities, PluginInvocation, PluginRuntime } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createPluginHookDispatcher,
  installPlugin,
  publishContentType,
  SYSTEM_CALLER,
  setPluginEnabled,
} from '../src/index';

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };

let ctx: AppContext;
let blob: FakeBlobStore;

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

/** Captures what the runtime was handed, and answers however a test wants. */
function fakeRuntime(
  answer?: (inv: PluginInvocation, caps: PluginCapabilities) => unknown,
): PluginRuntime & { calls: { inv: PluginInvocation; caps: PluginCapabilities }[] } {
  const calls: { inv: PluginInvocation; caps: PluginCapabilities }[] = [];
  return {
    calls,
    async invoke(inv, caps) {
      calls.push({ inv, caps });
      const result = answer?.(inv, caps);
      return (result as never) ?? { payload: inv.payload };
    },
  };
}

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'com.example.one',
  name: 'One',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  ...over,
});

async function installEnabled(over: Partial<PluginManifest> = {}, approved?: PluginCapability[]) {
  const m = manifest(over);
  const plugin = await installPlugin(ctx, blob, admin, SPACE, {
    manifest: m,
    bundle: `// ${m.id}`,
    approvedCapabilities: approved ?? m.capabilities,
  });
  await setPluginEnabled(ctx, SPACE, plugin.id, true);
  return plugin;
}

beforeEach(async () => {
  blob = new FakeBlobStore();
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
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
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
});

describe('dispatching to plugins', () => {
  it('does nothing when no plugin is installed', async () => {
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    expect(await d.dispatch('entry:beforeSave', { n: 1 }, scope)).toEqual({ payload: { n: 1 } });
    expect(runtime.calls).toHaveLength(0);
  });

  it('skips a plugin that is installed but disabled', async () => {
    const m = manifest();
    await installPlugin(ctx, blob, admin, SPACE, {
      manifest: m,
      bundle: '// x',
      approvedCapabilities: m.capabilities,
    });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', { n: 1 }, scope);
    expect(runtime.calls).toHaveLength(0);
  });

  it('skips a plugin not registered for the hook', async () => {
    await installEnabled({ hooks: ['entry:beforePublish'] });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', { n: 1 }, scope);
    expect(runtime.calls).toHaveLength(0);
  });

  it('chains plugins in a stable order, each seeing the previous mutation', async () => {
    await installEnabled({ id: 'com.example.b' });
    await installEnabled({ id: 'com.example.a' });
    const runtime = fakeRuntime((inv) => ({
      payload: { seen: [...((inv.payload as { seen?: string[] }).seen ?? []), inv.pluginId] },
    }));
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });

    const result = await d.dispatch('entry:beforeSave', { seen: [] }, scope);
    // Sorted by id, so the outcome does not depend on storage iteration order.
    expect(result).toEqual({ payload: { seen: ['com.example.a', 'com.example.b'] } });
  });

  it('stops at the first veto', async () => {
    await installEnabled({ id: 'com.example.a' });
    await installEnabled({ id: 'com.example.b' });
    const runtime = fakeRuntime((inv) =>
      inv.pluginId === 'com.example.a'
        ? { veto: { hook: inv.pluginId, reason: 'no' } }
        : { payload: inv.payload },
    );
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });

    const result = await d.dispatch('entry:beforeSave', { n: 1 }, scope);
    expect(result).toMatchObject({ veto: { hook: 'com.example.a' } });
    expect(runtime.calls).toHaveLength(1);
  });

  it('carries on when a plugin fails, rather than making the CMS unwritable', async () => {
    await installEnabled({ id: 'com.example.a' });
    await installEnabled({ id: 'com.example.b' });
    const onError = vi.fn();
    const runtime: PluginRuntime = {
      async invoke(inv) {
        if (inv.pluginId === 'com.example.a') throw new Error('boom');
        return { payload: { reached: true } };
      },
    };
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin, onError });

    expect(await d.dispatch('entry:beforeSave', { n: 1 }, scope)).toEqual({
      payload: { reached: true },
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('runs only capability-free plugins on a dry run, and names the rest', async () => {
    await installEnabled({ id: 'com.example.pure', capabilities: [] }, []);
    await installEnabled({ id: 'com.example.writer', capabilities: ['content:write'] });
    const runtime = fakeRuntime((inv) => ({
      payload: { seen: [...((inv.payload as { seen?: string[] }).seen ?? []), inv.pluginId] },
    }));
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });

    expect(await d.dispatch('entry:beforeSave', { seen: [] }, scope, { pureOnly: true })).toEqual({
      payload: { seen: ['com.example.pure'] },
      skipped: ['com.example.writer'],
    });
    // Marked as a dry run, so the runtime reports no capability refusal (an audit write).
    expect(runtime.calls[0]?.inv.dryRun).toBe(true);
    // A real save still runs both.
    expect(await d.dispatch('entry:beforeSave', { seen: [] }, scope)).toEqual({
      payload: { seen: ['com.example.pure', 'com.example.writer'] },
    });
    expect(runtime.calls[1]?.inv.dryRun).toBeUndefined();
  });
});

describe('what a plugin is handed', () => {
  it('gets only the capabilities it was granted', async () => {
    await installEnabled({ capabilities: ['content:read'] });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as Record<string, Record<string, unknown>>;
    expect(typeof caps.content?.list).toBe('function');
    // Ungranted capabilities are ABSENT, not present-and-refusing: the plugin's
    // call fails because there is nothing to call.
    expect(caps.content?.create).toBeUndefined();
    expect(caps.taxonomy).toBeUndefined();
  });

  it('adds write methods only with content:write', async () => {
    await installEnabled({ capabilities: ['content:read', 'content:write'] });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as Record<string, Record<string, unknown>>;
    expect(typeof caps.content?.create).toBe('function');
  });

  it('never hands over the store itself', async () => {
    await installEnabled();
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as Record<string, unknown>;
    // A plugin gets narrow capability objects, never a database handle.
    expect(caps.store).toBeUndefined();
    expect(JSON.stringify(Object.keys(caps))).not.toContain('store');
  });
});

describe('the principal a plugin acts as', () => {
  it('holds exactly the scopes its approved capabilities imply', async () => {
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Readable' } },
    });
    // Approved for reading only — and no principal is supplied by the caller.
    await installEnabled({ capabilities: ['content:read', 'content:write'] }, ['content:read']);
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime);
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as {
      content: { list(): Promise<unknown[]> } & { create?: unknown };
    };
    // The read the operator consented to works...
    expect(await caps.content.list()).toHaveLength(1);
    // ...and the write they declined is not there to call.
    expect(caps.content.create).toBeUndefined();
  });

  it('is scoped to the space the hook fired in', async () => {
    await installEnabled();
    const runtime = fakeRuntime();
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);

    // A plugin installed in one space must not act as a wildcard principal.
    const caps = runtime.calls[0]?.caps as {
      content: { get(id: string): Promise<unknown> };
    };
    await expect(caps.content.get('nope')).rejects.toBeTruthy();
  });
});

describe('a plugin cannot exceed its installer', () => {
  it('reads through the use-cases, so RBAC still applies', async () => {
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Secret' } },
    });
    await installEnabled({ capabilities: ['content:read'] });

    // A principal restricted to a content type it cannot read.
    const restricted: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead],
      contentGrants: [{ contentTypeApiId: 'other', actions: ['read'] }],
    };
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: restricted });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as {
      content: { list(): Promise<unknown[]> };
    };
    // The plugin can call list(), and gets nothing — the same answer its
    // installer would get from the HTTP API.
    expect(await caps.content.list()).toEqual([]);
  });

  it('masks denied fields exactly as the API would', async () => {
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Visible' } },
    });
    await installEnabled({ capabilities: ['content:read'] });

    const masked: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead],
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read'], deniedFields: ['title'] }],
    };
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: masked });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as {
      content: { list(): Promise<{ fields: Record<string, unknown> }[]> };
    };
    const [entry] = await caps.content.list();
    expect(entry?.fields.title).toBeUndefined();
  });

  it('keeps the fields its installer may not write when it saves what it read', async () => {
    const field = (apiId: string, position: number) => ({
      apiId,
      name: apiId,
      type: 'Symbol' as const,
      localized: false,
      required: false,
      position,
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [field('title', 0), field('internalNotes', 1)],
    });
    await publishContentType(ctx, scope, 'note');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'A' }, internalNotes: { 'en-US': 'secret' } },
    });
    await installEnabled({ capabilities: ['content:read', 'content:write'] });

    const masked: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead, SCOPES.contentWrite],
      contentGrants: [
        { contentTypeApiId: 'note', actions: ['read', 'write'], deniedFields: ['internalNotes'] },
      ],
    };
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: masked });
    await d.dispatch('entry:beforeSave', {}, scope);

    type Fields = Record<string, Record<string, unknown>>;
    const caps = runtime.calls[0]?.caps as {
      content: {
        get(id: string): Promise<{ fields: Fields }>;
        update(id: string, fields: Fields): Promise<{ fields: Fields }>;
      };
    };
    const read = await caps.content.get(entry.id);
    const saved = await caps.content.update(entry.id, { ...read.fields, title: { 'en-US': 'B' } });
    expect(saved.fields).toEqual({ title: { 'en-US': 'B' } });
    expect((await ctx.store.entries.get(scope, entry.id))?.fields).toEqual({
      title: { 'en-US': 'B' },
      internalNotes: { 'en-US': 'secret' },
    });
  });

  it('writes through the use-cases, so validation still applies', async () => {
    await installEnabled({ capabilities: ['content:write'] });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', {}, scope);

    const caps = runtime.calls[0]?.caps as {
      content: { create(input: unknown): Promise<unknown> };
    };
    // Title is required; a plugin is not a back door around the content model.
    await expect(
      caps.content.create({ contentTypeApiId: 'article', fields: {} }),
    ).rejects.toBeTruthy();
  });
});

describe('bundle integrity', () => {
  it('refuses to run bytes that no longer match the approved checksum', async () => {
    const plugin = await installEnabled();
    // Someone swapped the object in the blob store after approval.
    await blob.put(plugin.bundleKey, '// tampered');

    const onError = vi.fn();
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin, onError });
    await d.dispatch('entry:beforeSave', { n: 1 }, scope);

    expect(runtime.calls).toHaveLength(0);
    expect(onError.mock.calls[0]?.[0]).toContain('com.example.one');
  });

  it('hands the runtime the verified bytes and the checksum', async () => {
    const plugin = await installEnabled();
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { principal: admin });
    await d.dispatch('entry:beforeSave', {}, scope);

    // The checksum keys the isolate cache, so changed bytes cannot reuse one
    // warmed from the old bundle.
    expect(runtime.calls[0]?.inv.checksum).toBe(plugin.checksum);
    expect(runtime.calls[0]?.inv.bundle).toContain('com.example.one');
  });
});

describe('reaching the network', () => {
  const fetcher = (over: { status?: number; body?: string } = {}) => {
    const calls: { url: string; options: { maxBytes: number; timeoutMs?: number } }[] = [];
    return {
      calls,
      get: async (url: string, options: { maxBytes: number; timeoutMs?: number }) => {
        calls.push({ url, options });
        return { status: over.status ?? 200, contentType: 'text/plain', body: over.body ?? 'ok' };
      },
    };
  };

  const netCaps = async (
    over: Partial<PluginManifest> = {},
    opts: Record<string, unknown> = {},
  ) => {
    await installEnabled({
      capabilities: ['network:request'],
      allowedHosts: ['api.example.com', '*.cdn.example.com'],
      ...over,
    });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, opts);
    await d.dispatch('entry:beforeSave', {}, scope);
    return runtime.calls[0]?.caps as {
      network?: { fetch(url: unknown): Promise<{ status: number; body: string }> };
    };
  };

  it('is not offered at all when nothing can perform it', async () => {
    // Offered-and-doing-nothing is the failure this project keeps refusing.
    expect((await netCaps()).network).toBeUndefined();
  });

  it('reads from an allowed host', async () => {
    const f = fetcher();
    const caps = await netCaps({}, { fetcher: f });
    expect(await caps.network?.fetch('https://api.example.com/thing')).toMatchObject({
      status: 200,
      body: 'ok',
    });
    expect(f.calls[0]?.url).toBe('https://api.example.com/thing');
  });

  it('matches a wildcard against subdomains but not the apex', async () => {
    const caps = await netCaps({}, { fetcher: fetcher() });
    await expect(caps.network?.fetch('https://img.cdn.example.com/a.png')).resolves.toBeTruthy();
    await expect(caps.network?.fetch('https://cdn.example.com/a.png')).rejects.toThrow(
      /not in this plugin's allowed hosts/,
    );
  });

  it('refuses a host nobody approved', async () => {
    const f = fetcher();
    const caps = await netCaps({}, { fetcher: f });
    await expect(caps.network?.fetch('https://evil.test/steal')).rejects.toThrow(/allowed hosts/);
    // Refused before the request, not after.
    expect(f.calls).toHaveLength(0);
  });

  it('refuses an internal address even if it were allowlisted', async () => {
    const caps = await netCaps({ allowedHosts: ['127.0.0.1'] }, { fetcher: fetcher() });
    // An operator allowlisting a host that resolves internally must not thereby
    // hand a plugin an SSRF; the two checks answer different questions.
    const err = await caps.network?.fetch('http://127.0.0.1/admin').catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]?.message).toMatch(/loopback/i);
  });

  it('bounds the response and the wait', async () => {
    const f = fetcher();
    const caps = await netCaps({}, { fetcher: f });
    await caps.network?.fetch('https://api.example.com/thing');
    // A plugin holds an editor's save open; an unbounded read holds it forever.
    expect(f.calls[0]?.options.maxBytes).toBeGreaterThan(0);
    expect(f.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it('offers reads only', async () => {
    const caps = await netCaps({}, { fetcher: fetcher() });
    // A POST to a third party is a side effect on someone else's system, and a
    // larger thing to grant than "may read from these hosts".
    expect(Object.keys(caps.network ?? {})).toEqual(['fetch']);
  });

  it('is absent for a plugin that was not granted it', async () => {
    await installEnabled({ capabilities: ['content:read'] });
    const runtime = fakeRuntime();
    const d = createPluginHookDispatcher(ctx, blob, runtime, { fetcher: fetcher() });
    await d.dispatch('entry:beforeSave', {}, scope);
    expect((runtime.calls[0]!.caps as Record<string, unknown>).network).toBeUndefined();
  });
});

import type { PluginInvocation } from '@commerceworker/ports';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerLoaderRuntime,
  type WorkerLoaderBinding,
} from '../../src/plugins-cf-loader/index';

/**
 * A stand-in for the Worker Loader binding.
 *
 * It records the config it was asked to load — which is how the isolation
 * settings get asserted, since whether workerd honours `globalOutbound: null`
 * is Cloudflare's guarantee, verified separately against a real runtime, not
 * something a unit test can prove.
 */
function fakeLoader(handlers: Record<string, unknown> = {}) {
  const loads: { id: string; config: Record<string, unknown> }[] = [];
  const binding: WorkerLoaderBinding = {
    get(id, supplier) {
      const config = supplier() as unknown as Record<string, unknown>;
      loads.push({ id, config });
      return {
        getEntrypoint: () => handlers as Record<string, (...a: unknown[]) => Promise<unknown>>,
      };
    },
  };
  return { binding, loads };
}

const invocation = (over: Partial<PluginInvocation> = {}): PluginInvocation => ({
  pluginId: 'com.example.one',
  bundle: 'export class Plugin {}',
  entrypoint: 'index.js',
  checksum: 'abc123',
  hook: 'entry:beforeSave',
  payload: { title: 'hi' },
  capabilities: ['content:read'],
  allowedHosts: [],
  ...over,
});

describe('isolation settings', () => {
  it('loads the plugin with the network severed', async () => {
    const { binding, loads } = fakeLoader({ onEntryBeforeSave: async () => undefined });
    const runtime = createWorkerLoaderRuntime(binding);
    await runtime.invoke(invocation(), {});

    // Verified against a real workerd: with this set, fetch() inside the
    // isolate throws rather than escaping.
    expect(loads[0]?.config.globalOutbound).toBeNull();
    expect(loads[0]?.config.modules).toEqual({ 'index.js': 'export class Plugin {}' });
  });

  it('keys the isolate by checksum, so changed bytes cannot reuse a warm one', async () => {
    const { binding, loads } = fakeLoader({ onEntryBeforeSave: async () => undefined });
    const runtime = createWorkerLoaderRuntime(binding);
    await runtime.invoke(invocation({ checksum: 'aaa' }), {});
    await runtime.invoke(invocation({ checksum: 'bbb' }), {});
    expect(loads.map((l) => l.id)).toEqual(['com.example.one@aaa', 'com.example.one@bbb']);
  });

  it('pins the plugin compatibility date independently of the host', async () => {
    const { binding, loads } = fakeLoader({ onEntryBeforeSave: async () => undefined });
    const runtime = createWorkerLoaderRuntime(binding, { compatibilityDate: '2026-01-01' });
    await runtime.invoke(invocation(), {});
    // A plugin should not change behaviour because the platform's date moved.
    expect(loads[0]?.config.compatibilityDate).toBe('2026-01-01');
  });
});

describe('network:request no longer stops a plugin running', () => {
  it('runs a plugin granted it, with the network still severed', async () => {
    const { binding, loads } = fakeLoader({ onEntryBeforeSave: async () => undefined });
    const runtime = createWorkerLoaderRuntime(binding);
    const result = await runtime.invoke(
      invocation({ capabilities: ['network:request'], allowedHosts: ['example.com'] }),
      {},
    );

    expect(result).toEqual({ payload: { title: 'hi' } });
    // The capability is a method handed in as an argument, checked host-side.
    // The isolate itself still has no way out, so there is nothing to bypass.
    expect(loads[0]?.config.globalOutbound).toBeNull();
  });
});

describe('reading what the plugin returned', () => {
  const run = async (handler: () => Promise<unknown>, inv = invocation()) => {
    const { binding } = fakeLoader({ onEntryBeforeSave: handler });
    return createWorkerLoaderRuntime(binding).invoke(inv, {});
  };

  it('passes the payload through when the plugin returns nothing', async () => {
    expect(await run(async () => undefined)).toEqual({ payload: { title: 'hi' } });
  });

  it('takes a replacement payload', async () => {
    expect(await run(async () => ({ payload: { title: 'changed' } }))).toEqual({
      payload: { title: 'changed' },
    });
  });

  it('takes a veto and names the plugin, not whatever the plugin claimed', async () => {
    const result = await run(async () => ({ veto: { hook: 'i-am-someone-else', reason: 'no' } }));
    // A plugin must not be able to attribute its refusal to another plugin.
    expect(result).toEqual({ veto: { hook: 'com.example.one', reason: 'no', issues: undefined } });
  });

  it('carries field issues through a veto', async () => {
    const result = await run(async () => ({
      veto: { reason: 'bad', issues: [{ field: 'title', message: 'too shouty' }] },
    }));
    expect(result).toMatchObject({ veto: { issues: [{ field: 'title' }] } });
  });

  it('treats junk as pass-through rather than as a payload', async () => {
    // A plugin returning nonsense must not be able to corrupt an entry.
    expect(await run(async () => 'not an object' as unknown)).toEqual({
      payload: { title: 'hi' },
    });
    expect(await run(async () => 42 as unknown)).toEqual({ payload: { title: 'hi' } });
  });

  it('passes through when the plugin does not implement the hook it registered for', async () => {
    const { binding } = fakeLoader({});
    const result = await createWorkerLoaderRuntime(binding).invoke(invocation(), {});
    // A packaging bug, not a refusal.
    expect(result).toEqual({ payload: { title: 'hi' } });
  });
});

describe('bounding the call', () => {
  it('hands the granted host methods to the plugin, bound to the host', async () => {
    const seen: unknown[] = [];
    const { binding } = fakeLoader({
      onEntryBeforeSave: async (...args: unknown[]) => {
        seen.push(...args);
        return undefined;
      },
    });
    const list = vi.fn(async () => ['e1']);
    await createWorkerLoaderRuntime(binding).invoke(invocation(), { content: { list } });
    expect(seen[0]).toEqual({ title: 'hi' });
    const caps = seen[1] as { content: { list: () => Promise<unknown> }; granted: string[] };
    expect(await caps.content.list()).toEqual(['e1']);
    expect(list).toHaveBeenCalledOnce();
    expect(caps.granted).toEqual(['content:read']);
  });

  it('times out rather than holding the write open', async () => {
    const { binding } = fakeLoader({ onEntryBeforeSave: () => new Promise(() => {}) });
    const onError = vi.fn();
    const runtime = createWorkerLoaderRuntime(binding, { timeoutMs: 20, onError });

    const started = Date.now();
    await expect(runtime.invoke(invocation(), {})).rejects.toThrow(/exceeded/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports a throwing plugin and lets the caller decide', async () => {
    const { binding } = fakeLoader({
      onEntryBeforeSave: async () => {
        throw new Error('plugin exploded');
      },
    });
    const onError = vi.fn();
    const runtime = createWorkerLoaderRuntime(binding, { onError });
    // Rethrown, so the caller's per-plugin policy decides what failure means.
    await expect(runtime.invoke(invocation(), {})).rejects.toThrow('plugin exploded');
    expect(onError.mock.calls[0]?.[0]).toContain('com.example.one');
  });
});

/**
 * The capability fence. The host passes what it built; the adapter re-derives
 * what the isolate actually receives from the invocation's grant, so even a
 * host that handed over too much cannot widen what a plugin can reach.
 */
describe('capability enforcement', () => {
  type Method = (...a: unknown[]) => Promise<unknown>;
  type Caps = Record<string, Record<string, Method> | undefined> & { granted?: unknown };
  type OnDenied = (denial: unknown) => Promise<void>;

  async function capsFor(
    inv: PluginInvocation,
    host: Record<string, unknown>,
    onDenied = vi.fn<OnDenied>(async () => {}),
  ) {
    let caps: Caps | undefined;
    const { binding } = fakeLoader({
      onEntryBeforeSave: async (_payload: unknown, c: Caps) => {
        caps = c;
        return undefined;
      },
    });
    await createWorkerLoaderRuntime(binding, { onDenied }).invoke(inv, host);
    if (!caps) throw new Error('plugin was not called');
    return { caps, onDenied };
  }

  it('never reaches a host method whose capability was not granted', async () => {
    const create = vi.fn(async () => 'created');
    // The host (wrongly) supplied content.create; the grant is content:read only.
    const { caps, onDenied } = await capsFor(
      invocation({ scope: { spaceId: 's1', environmentId: 'main' } }),
      { content: { list: async () => [], create } },
    );

    await expect(caps.content?.create?.({})).rejects.toThrow(
      /capability_denied: plugin "com\.example\.one" was not granted "content:write"/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith({
      pluginId: 'com.example.one',
      capability: 'content:write',
      method: 'content.create',
      reason: 'not-granted',
      hook: 'entry:beforeSave',
      spaceId: 's1',
      environmentId: 'main',
    });
  });

  it('refuses a dry run the same way, without reporting it', async () => {
    const { caps, onDenied } = await capsFor(
      invocation({
        capabilities: [],
        dryRun: true,
        scope: { spaceId: 's1', environmentId: 'main' },
      }),
      {},
    );
    await expect(caps.content?.list?.()).rejects.toThrow(/capability_denied/);
    // Reporting writes an audit row; a dry run writes nothing.
    expect(onDenied).not.toHaveBeenCalled();
  });

  it('denies every capability by default', async () => {
    const { caps, onDenied } = await capsFor(invocation({ capabilities: [] }), {});
    const calls = [
      () => caps.content?.list?.(),
      () => caps.content?.publish?.('e1'),
      () => caps.assets?.get?.('a1'),
      () => caps.taxonomy?.createTag?.({ name: 'x' }),
      () => caps.network?.fetch?.('https://example.com/'),
      () => caps.kv?.put?.('k', 'v'),
      () => caps.ai?.generate?.('prompt'),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(/capability_denied/);
    }
    expect(onDenied).toHaveBeenCalledTimes(calls.length);
    expect(caps.granted).toEqual([]);
  });

  it('drops host keys no capability unlocks', async () => {
    const { caps } = await capsFor(invocation({ capabilities: ['content:read'] }), {
      content: { list: async () => [] },
      secrets: { read: async () => 'token' },
      env: { DATABASE_URL: 'sqlite://' },
    });
    expect(caps.secrets).toBeUndefined();
    expect(caps.env).toBeUndefined();
  });

  it('says so when a granted capability is not provided by this deployment', async () => {
    const { caps, onDenied } = await capsFor(invocation({ capabilities: ['kv:storage'] }), {});
    await expect(caps.kv?.get?.('k')).rejects.toThrow(/does not provide caps\.kv\.get/);
    expect(onDenied.mock.calls[0]?.[0]).toMatchObject({ reason: 'not-provided' });
  });

  it('limits network:request to the declared hosts, and audits the refusal', async () => {
    const fetch = vi.fn(async () => ({ status: 200, contentType: 'text/plain', body: 'ok' }));
    const { caps, onDenied } = await capsFor(
      invocation({ capabilities: ['network:request'], allowedHosts: ['api.example.com'] }),
      { network: { fetch } },
    );

    await expect(caps.network?.fetch?.('https://api.example.com/x')).resolves.toMatchObject({
      status: 200,
    });
    await expect(caps.network?.fetch?.('https://evil.example.net/x')).rejects.toThrow(
      /may not reach "evil\.example\.net"/,
    );
    await expect(caps.network?.fetch?.('not a url')).rejects.toThrow(/capability_denied/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onDenied.mock.calls[0]?.[0]).toMatchObject({
      reason: 'host-not-allowed',
      host: 'evil.example.net',
    });
  });

  it('binds kv:storage, list included, only when granted', async () => {
    const list = vi.fn(async () => ({ keys: ['a'] }));
    const host = {
      kv: { get: async () => 1, put: async () => {}, delete: async () => true, list },
    };
    const granted = await capsFor(invocation({ capabilities: ['kv:storage'] }), host);
    await expect(granted.caps.kv?.list?.({ prefix: 'a' })).resolves.toEqual({ keys: ['a'] });
    expect(list).toHaveBeenCalledWith({ prefix: 'a' });

    const denied = await capsFor(invocation({ capabilities: [] }), host);
    await expect(denied.caps.kv?.list?.()).rejects.toThrow(/was not granted "kv:storage"/);
    expect(list).toHaveBeenCalledOnce();
  });

  it('hands every plugin settings.get, with no capability, and only get', async () => {
    const get = vi.fn(async () => ({ apiKey: 'sk' }));
    const { caps, onDenied } = await capsFor(invocation({ capabilities: [] }), {
      settings: { get, set: async () => {} },
    });
    await expect(caps.settings?.get?.()).resolves.toEqual({ apiKey: 'sk' });
    expect(caps.settings?.set).toBeUndefined();
    expect(onDenied).not.toHaveBeenCalled();

    // A host that provides none still hands over an empty object, not a missing method.
    const bare = await capsFor(invocation({ capabilities: [] }), {});
    await expect(bare.caps.settings?.get?.()).resolves.toEqual({});
  });

  it('still refuses when reporting the denial fails', async () => {
    const onDenied = vi.fn<OnDenied>(async () => {
      throw new Error('audit store down');
    });
    const { caps } = await capsFor(invocation({ capabilities: [] }), {}, onDenied);
    await expect(caps.content?.list?.()).rejects.toThrow(/capability_denied/);
  });
});

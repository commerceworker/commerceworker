import {
  capabilityDeniedMessage,
  hostAllowed,
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_METHODS,
  type PluginCapability,
  type PluginCapabilityDenial,
  type PluginDenialReason,
} from '@commerceworker/domain';
import type {
  HookResult,
  PluginCapabilities,
  PluginInvocation,
  PluginRuntime,
} from '@commerceworker/ports';

/**
 * Plugin runtime backed by Cloudflare's Worker Loader.
 *
 * Each plugin runs in its own dynamic Worker: a separate v8 isolate with no
 * ambient authority. What it can do is exactly what it is handed, and what it
 * is handed is decided here.
 *
 * Three properties were verified against a real workerd before this was
 * written, rather than assumed:
 *
 * 1. `globalOutbound: null` genuinely severs the isolate from the network —
 *    `fetch()` inside it throws rather than escaping. It stays severed even for
 *    a plugin granted `network:request`: that capability is a method handed in
 *    as an RPC argument, checked against the allowlist host-side, so there is
 *    no ambient network to bypass it with. Filtering the isolate's own outbound
 *    instead would need a per-plugin `Fetcher` for `globalOutbound`, which the
 *    runtime does not offer — a dynamically-loaded worker cannot be passed
 *    (`DataCloneError`, by design) and a parent entrypoint cannot be
 *    constructed per plugin. Both were tried against a real workerd.
 * 2. Capabilities cannot be passed as load-time `env` (RPC references only
 *    serialize *for* RPC), so they are passed as arguments on the RPC call.
 *    That is the better shape anyway: a warm isolate cannot retain authority
 *    granted for an earlier invocation.
 * 3. An ungranted capability carries no authority inside the sandbox. This
 *    adapter re-derives what the isolate receives from the invocation's grant
 *    (`gateCapabilities`): only methods listed for a granted capability in
 *    `PLUGIN_CAPABILITY_METHODS` are bound to host code; every other listed
 *    method is an inert stand-in that holds no reference to anything and
 *    refuses with a `capability_denied` error, reported through `onDenied`;
 *    anything the host passed that the map does not list is dropped. Deny by
 *    default, even against a host that handed over too much.
 */

/** The subset of the Worker Loader binding this adapter uses. */
export interface WorkerLoaderBinding {
  get(
    id: string,
    supplier: () => {
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound: null;
    },
  ): { getEntrypoint(name?: string): Record<string, (...args: unknown[]) => Promise<unknown>> };
}

export interface WorkerLoaderRuntimeOptions {
  /**
   * Compatibility date handed to plugin isolates. Pinned separately from the
   * host Worker's: a plugin should not silently change behaviour because the
   * platform's date moved.
   */
  readonly compatibilityDate?: string;
  /** Ceiling on one invocation. The host bounds the wait; workerd bounds the CPU. */
  readonly timeoutMs?: number;
  readonly onError?: (message: string, detail: unknown) => void;
  /**
   * Called for every refused capability call — log it and put it on the audit
   * trail. Awaited (failures swallowed) before the plugin sees the error.
   */
  readonly onDenied?: (denial: PluginCapabilityDenial) => void | Promise<void>;
}

/** The class a plugin bundle must export. */
export const PLUGIN_ENTRYPOINT_CLASS = 'Plugin';

/** Hook name → the method a plugin implements. */
const HOOK_METHOD: Record<string, string> = {
  'entry:beforeSave': 'onEntryBeforeSave',
  'entry:beforePublish': 'onEntryBeforePublish',
  'entry:beforeTrash': 'onEntryBeforeTrash',
  'entry:beforePurge': 'onEntryBeforePurge',
  'asset:beforeCreate': 'onAssetBeforeCreate',
};

const DEFAULT_COMPATIBILITY_DATE = '2026-06-01';
const DEFAULT_TIMEOUT_MS = 2_000;

export function createWorkerLoaderRuntime(
  loader: WorkerLoaderBinding,
  options: WorkerLoaderRuntimeOptions = {},
): PluginRuntime {
  const compatibilityDate = options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const report = options.onError ?? (() => {});
  const onDenied = options.onDenied ?? (() => {});

  return {
    async invoke(
      invocation: PluginInvocation,
      capabilities: PluginCapabilities,
    ): Promise<HookResult<unknown>> {
      const method = HOOK_METHOD[invocation.hook];
      if (!method) {
        return { veto: { hook: invocation.pluginId, reason: `Unknown hook ${invocation.hook}` } };
      }

      try {
        // Keyed by checksum as well as id, so changed bytes never reuse an
        // isolate warmed from the old ones.
        const worker = loader.get(`${invocation.pluginId}@${invocation.checksum}`, () => ({
          compatibilityDate,
          mainModule: invocation.entrypoint,
          modules: { [invocation.entrypoint]: invocation.bundle },
          // No network. Verified: fetch() inside the isolate throws.
          globalOutbound: null,
        }));

        const entrypoint = worker.getEntrypoint(PLUGIN_ENTRYPOINT_CLASS);
        const handler = entrypoint[method];
        if (typeof handler !== 'function') {
          // A plugin that registered for a hook it does not implement is a
          // packaging bug, not a refusal — let the write proceed.
          return { payload: invocation.payload };
        }

        const result = await withTimeout(
          handler.call(
            entrypoint,
            invocation.payload,
            gateCapabilities(capabilities, invocation, onDenied),
          ),
          invocation.timeoutMs ?? defaultTimeout,
          `plugin ${invocation.pluginId}`,
        );
        return interpret(result, invocation);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report(`plugin ${invocation.pluginId} failed on ${invocation.hook}: ${message}`, err);
        // The caller's per-plugin error policy decides what a failure means;
        // the runtime's job is to not take the request down with it.
        throw err;
      }
    },
  };
}

type Fn = (...args: unknown[]) => Promise<unknown>;

/**
 * Builds exactly what the isolate is handed.
 *
 * Re-derived from the invocation's grant rather than trusting the shape the
 * host passed: for every method in `PLUGIN_CAPABILITY_METHODS`, the plugin gets
 * the host implementation only when the method's capability is granted *and*
 * the host provided one; otherwise it gets a stand-in that reports the denial
 * and throws. Host keys the map does not list never reach the plugin.
 *
 * Stand-ins (rather than absent keys) are deliberate: a plugin calling
 * something it was not granted gets an error that says which capability it is
 * missing, and the operator gets an audit entry — instead of an anonymous
 * "undefined is not a function" nobody sees. They close over nothing but the
 * denial record, so there is no authority behind them to reach.
 *
 * `caps.granted` lists the effective grant, for feature detection, and
 * `caps.settings.get()` the plugin's own settings (no capability needed).
 */
export function gateCapabilities(
  host: PluginCapabilities,
  invocation: PluginInvocation,
  onDenied: (denial: PluginCapabilityDenial) => void | Promise<void>,
): PluginCapabilities {
  const granted = new Set<string>(invocation.capabilities);
  const gated: Record<string, Record<string, Fn>> = {};

  const deny = (
    capability: PluginCapability,
    method: string,
    reason: PluginDenialReason,
    host?: string,
  ): PluginCapabilityDenial => ({
    pluginId: invocation.pluginId,
    capability,
    method,
    reason,
    hook: invocation.hook,
    ...(invocation.scope
      ? { spaceId: invocation.scope.spaceId, environmentId: invocation.scope.environmentId }
      : {}),
    ...(host ? { host } : {}),
  });
  const refuse = async (denial: PluginCapabilityDenial): Promise<never> => {
    // A dry run is refused the same way but leaves no trace: reporting is a write.
    if (!invocation.dryRun) {
      try {
        await onDenied(denial);
      } catch {
        // Reporting must not change what the plugin sees.
      }
    }
    throw new Error(capabilityDeniedMessage(denial));
  };

  for (const capability of PLUGIN_CAPABILITIES) {
    for (const method of PLUGIN_CAPABILITY_METHODS[capability]) {
      const [namespace = '', name = ''] = method.split('.');
      const owner = host[namespace] as Record<string, unknown> | undefined;
      const provided = owner?.[name];
      let bound: Fn;
      if (!granted.has(capability)) {
        bound = () => refuse(deny(capability, method, 'not-granted'));
      } else if (typeof provided !== 'function') {
        bound = () => refuse(deny(capability, method, 'not-provided'));
      } else if (capability === 'network:request') {
        // Checked here as well as host-side: the allowlist is part of the grant,
        // and a refused host is a denial worth auditing, not just an exception.
        bound = async (...args) => {
          const target = typeof args[0] === 'string' ? hostOf(args[0]) : '';
          if (!target || !hostAllowed(invocation.allowedHosts, target)) {
            return refuse(deny(capability, method, 'host-not-allowed', target || undefined));
          }
          return (provided as Fn).apply(owner, args);
        };
      } else {
        bound = (...args) => (provided as Fn).apply(owner, args);
      }
      const ns = gated[namespace] ?? {};
      ns[name] = bound;
      gated[namespace] = ns;
    }
  }

  // Settings are the plugin's own configuration and need no capability, so they
  // sit outside the map above. Still re-bound rather than passed through: only
  // `get` crosses, and a host that provides none hands over an empty object.
  const settings = (host.settings as Record<string, unknown> | undefined)?.get;
  gated.settings = {
    get:
      typeof settings === 'function'
        ? () => (settings as Fn).call(host.settings)
        : async () => ({}),
  };

  return { ...gated, granted: [...invocation.capabilities] };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Reads what a plugin returned.
 *
 * A plugin may return nothing (pass through), a veto, or a replacement payload.
 * Anything unrecognised is treated as pass-through rather than as a payload, so
 * a plugin returning junk cannot corrupt an entry.
 */
function interpret(result: unknown, invocation: PluginInvocation): HookResult<unknown> {
  if (result === undefined || result === null) return { payload: invocation.payload };
  if (typeof result === 'object' && 'veto' in (result as Record<string, unknown>)) {
    const veto = (result as { veto: { reason?: string; issues?: unknown } }).veto;
    return {
      veto: {
        // The plugin names itself, so an editor sees whose rule refused.
        hook: invocation.pluginId,
        reason: typeof veto?.reason === 'string' ? veto.reason : 'Refused by plugin',
        issues: Array.isArray(veto?.issues) ? (veto.issues as HookVetoIssues) : undefined,
      },
    };
  }
  if (typeof result === 'object' && 'payload' in (result as Record<string, unknown>)) {
    return { payload: (result as { payload: unknown }).payload };
  }
  return { payload: invocation.payload };
}

type HookVetoIssues = NonNullable<
  Extract<HookResult<unknown>, { veto: unknown }>['veto']['issues']
>;

/**
 * Bounds how long the *host* waits. The isolate's own CPU limits are enforced
 * by workerd; this stops a plugin holding an editor's save open.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

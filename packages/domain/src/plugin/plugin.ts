import { type PermissionScope, SCOPES } from '../auth/auth';
import { DomainError, ValidationError } from '../errors';
import { type PluginSettingField, settingsSchemaIssues } from './settings';

/**
 * Plugins: third-party code that runs inside commerceworker's write path.
 *
 * The whole model rests on one idea — a plugin declares what it needs, a human
 * approves exactly that, and the runtime grants exactly that and nothing more.
 * Capability gating is implemented by *omitting* the corresponding binding, so
 * an ungranted call fails as "not a function" rather than as a check that could
 * be bypassed.
 *
 * This module is the vocabulary and the rules. Execution lives behind the
 * `PluginRuntime` port.
 */

/** What a plugin may ask for. */
export const PLUGIN_CAPABILITIES = [
  'content:read',
  'content:write',
  'content:publish',
  'assets:read',
  'assets:write',
  'taxonomy:read',
  'taxonomy:write',
  'search:read',
  'ai:generate',
  /** Outbound HTTP, restricted to the manifest's `allowedHosts`. */
  'network:request',
  /**
   * A key/value scratch space of the plugin's own, per environment. Keys are
   * namespaced by the installed plugin's id on the host side, so no plugin can
   * name another's.
   */
  'kv:storage',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * The platform scope a capability implies.
 *
 * Capabilities **intersect** RBAC, they never widen it: you cannot grant a
 * plugin the power to publish if you cannot publish yourself. Without this an
 * editor could install a plugin as a privilege-escalation ladder.
 */
const CAPABILITY_SCOPE: Record<PluginCapability, PermissionScope | null> = {
  'content:read': SCOPES.previewRead,
  'content:write': SCOPES.contentWrite,
  'content:publish': SCOPES.contentPublish,
  'assets:read': SCOPES.previewRead,
  'assets:write': SCOPES.contentWrite,
  'taxonomy:read': SCOPES.previewRead,
  'taxonomy:write': SCOPES.contentWrite,
  'search:read': SCOPES.searchRead,
  'ai:generate': SCOPES.contentWrite,
  // Neither reaches platform data, so neither implies a content scope. Network
  // access is bounded by allowedHosts; storage is namespaced per plugin.
  'network:request': null,
  'kv:storage': null,
};

/** The scope an installer must hold to grant `capability`, if any. */
export function scopeForCapability(capability: PluginCapability): PermissionScope | null {
  return CAPABILITY_SCOPE[capability];
}

/** Hooks a plugin may register for. Mirrors the HookDispatcher's names. */
export const PLUGIN_HOOKS = [
  'entry:beforeSave',
  'entry:beforePublish',
  'entry:beforeTrash',
  'entry:beforePurge',
  'asset:beforeCreate',
] as const;
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

/** What a plugin says about itself. Authored by the plugin, trusted by nobody. */
export interface PluginManifest {
  /** Stable identifier, reverse-DNS style: `com.example.seo`. */
  readonly id: string;
  readonly name: string;
  /** Semver-ish; compared as an opaque string, only for display and upgrades. */
  readonly version: string;
  readonly description?: string;
  readonly capabilities: readonly PluginCapability[];
  /**
   * Hosts `network:request` may reach. Deny-by-default: an empty list with the
   * capability declared is refused, because "any host" must be stated, not
   * arrived at by omission.
   */
  readonly allowedHosts: readonly string[];
  readonly hooks: readonly PluginHook[];
  /** Module path within the bundle, e.g. `index.js`. */
  readonly entrypoint: string;
  /**
   * The settings an operator fills in, read back by the plugin through
   * `caps.settings.get()`. Optional: most plugins need none.
   */
  readonly settings?: readonly PluginSettingField[];
}

/** A plugin as installed in a space. */
export interface InstalledPlugin {
  readonly id: string;
  readonly spaceId: string;
  readonly manifest: PluginManifest;
  /** SHA-256 of the bundle, hex. Verified before every load. */
  readonly checksum: string;
  /** Where the bundle lives in the blob store. */
  readonly bundleKey: string;
  /**
   * What a human actually approved. The manifest is what the plugin *asked*
   * for; this is the grant, and the runtime uses this one.
   */
  readonly approvedCapabilities: readonly PluginCapability[];
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly installedBy?: string;
  /**
   * Set (never stored) when the stored manifest predates the required
   * `capabilities` field. See `normalizeInstalledPlugin`.
   */
  readonly needsReapproval?: boolean;
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MAX_HOSTS = 50;

/**
 * Validates a manifest before anything is stored.
 *
 * Rejects rather than repairs: a manifest is a security document, and quietly
 * fixing one means the thing a human approves is not the thing the author
 * wrote.
 */
export function assertValidManifest(manifest: PluginManifest): void {
  const issues: { field: string; message: string }[] = [];

  if (!ID_PATTERN.test(manifest.id ?? '')) {
    issues.push({
      field: 'id',
      message: 'id must be lowercase alphanumeric segments separated by dots or hyphens',
    });
  }
  if (!manifest.name?.trim()) issues.push({ field: 'name', message: 'name is required' });
  if (!manifest.version?.trim()) issues.push({ field: 'version', message: 'version is required' });
  if (!manifest.entrypoint?.trim()) {
    issues.push({ field: 'entrypoint', message: 'entrypoint is required' });
  }

  // Required, even when empty: a manifest that says nothing about what it needs
  // cannot be consented to, and "[]" is a statement where omission is not.
  if (!Array.isArray(manifest.capabilities)) {
    issues.push({
      field: 'capabilities',
      message: 'capabilities is required; declare [] if the plugin needs none',
    });
  }
  const seen = new Set<string>();
  for (const capability of Array.isArray(manifest.capabilities) ? manifest.capabilities : []) {
    if (seen.has(capability)) {
      issues.push({ field: 'capabilities', message: `Duplicate capability "${capability}"` });
    }
    seen.add(capability);
    if (!(PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
      issues.push({ field: 'capabilities', message: `Unknown capability "${capability}"` });
    }
  }
  for (const hook of manifest.hooks ?? []) {
    if (!(PLUGIN_HOOKS as readonly string[]).includes(hook)) {
      issues.push({ field: 'hooks', message: `Unknown hook "${hook}"` });
    }
  }

  const wantsNetwork =
    Array.isArray(manifest.capabilities) && manifest.capabilities.includes('network:request');
  const hosts = manifest.allowedHosts ?? [];
  if (wantsNetwork && hosts.length === 0) {
    issues.push({
      field: 'allowedHosts',
      message: 'network:request requires at least one allowed host',
    });
  }
  if (!wantsNetwork && hosts.length > 0) {
    issues.push({
      field: 'allowedHosts',
      message: 'allowedHosts is set but network:request was not requested',
    });
  }
  if (hosts.length > MAX_HOSTS) {
    issues.push({ field: 'allowedHosts', message: `At most ${MAX_HOSTS} hosts` });
  }
  for (const host of hosts) {
    // Hostnames only. A URL here would suggest path-level restriction, which
    // is not something the egress layer can enforce.
    if (!/^\*?[a-z0-9.-]+$/i.test(host) || host.includes('/')) {
      issues.push({ field: 'allowedHosts', message: `"${host}" is not a bare hostname` });
    }
  }

  issues.push(...settingsSchemaIssues(manifest.settings));

  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * True when `host` is permitted by an allowlist entry. `*.example.com` matches
 * any subdomain but NOT the apex, which has to be listed separately — a
 * wildcard that silently included the apex would grant more than it appears to.
 */
export function hostAllowed(allowedHosts: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('*.'))
      return target.endsWith(pattern.slice(1)) && target !== pattern.slice(2);
    return pattern === target;
  });
}

/**
 * Checks the human's approval against what the plugin asked for.
 *
 * Approving *fewer* capabilities than requested is allowed and is the point of
 * a consent screen. Approving something the manifest never asked for is
 * refused: it means the grant and the manifest disagree, and the manifest is
 * what was reviewed.
 */
export function assertConsentCoversManifest(
  manifest: PluginManifest,
  approved: readonly PluginCapability[],
): void {
  const requested = new Set<string>(manifest.capabilities);
  const extra = approved.filter((c) => !requested.has(c));
  if (extra.length > 0) {
    throw new ValidationError([
      {
        field: 'approvedCapabilities',
        message: `Approved capabilities the plugin did not request: ${extra.join(', ')}`,
      },
    ]);
  }
}

/**
 * The capabilities `next` asks for that the plugin had never asked for before.
 *
 * Only these need fresh consent. A capability the previous version also asked
 * for was already put in front of a human: if it was declined then, it stays
 * declined (the carried-forward grant is `effectivePluginGrant`, which drops
 * it), and re-asking does not reopen the question on every release.
 */
export function newlyRequestedCapabilities(
  previouslyDeclared: readonly PluginCapability[],
  next: PluginManifest,
): PluginCapability[] {
  const before = new Set<string>(previouslyDeclared);
  return next.capabilities.filter((c) => !before.has(c));
}

/**
 * True when a version change asks for something never put to a human, which
 * must force fresh consent rather than upgrading silently.
 */
export function requiresReconsent(
  previouslyDeclared: readonly PluginCapability[],
  next: PluginManifest,
): boolean {
  return newlyRequestedCapabilities(previouslyDeclared, next).length > 0;
}

/**
 * The grant a plugin actually runs with: **declared ∩ approved**.
 *
 * Both halves are necessary. The approval is the human's ceiling; the manifest
 * is the author's. A stored approval that outlived the manifest that justified
 * it (or a manifest that grew without consent) must never be honoured beyond
 * the narrower of the two. Unknown strings drop out, and the result is in
 * vocabulary order so it compares and displays stably.
 */
export function effectivePluginGrant(
  declared: readonly string[] | undefined,
  approved: readonly string[] | undefined,
): PluginCapability[] {
  const d = new Set(declared ?? []);
  const a = new Set(approved ?? []);
  return PLUGIN_CAPABILITIES.filter((c) => d.has(c) && a.has(c));
}

/**
 * Reads a stored plugin, upgrading a manifest that predates the required
 * `capabilities` field.
 *
 * The migration decision: such a plugin is treated as **requesting exactly the
 * access it already holds** (its approved list), so a deploy neither widens nor
 * silently strips what is running, and it is flagged `needsReapproval` until a
 * human confirms the list. Since its declaration is synthesised from its grant,
 * re-approval can only keep or narrow it, never widen it.
 */
export function normalizeInstalledPlugin(plugin: InstalledPlugin): InstalledPlugin {
  if (Array.isArray(plugin.manifest.capabilities)) {
    const { needsReapproval: _ignored, ...rest } = plugin;
    return rest;
  }
  return {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      capabilities: effectivePluginGrant(plugin.approvedCapabilities, plugin.approvedCapabilities),
      allowedHosts: plugin.manifest.allowedHosts ?? [],
    },
    needsReapproval: true,
  };
}

/**
 * Every host method a capability unlocks, as `namespace.method` — the shape a
 * plugin sees (`caps.content.create`).
 *
 * This is the single map both enforcement layers read: the application builds
 * methods only for granted capabilities, and the sandbox adapter hands the
 * isolate only the methods whose capability is in the grant, so a method that
 * is not listed here can never reach a plugin at all.
 */
export const PLUGIN_CAPABILITY_METHODS: Readonly<Record<PluginCapability, readonly string[]>> = {
  'content:read': ['content.list', 'content.get', 'content.listPublished'],
  'content:write': ['content.create', 'content.update'],
  'content:publish': ['content.publish'],
  'assets:read': ['assets.list', 'assets.get'],
  'assets:write': ['assets.create'],
  'taxonomy:read': ['taxonomy.listTags'],
  'taxonomy:write': ['taxonomy.createTag'],
  'search:read': ['search.query'],
  'ai:generate': ['ai.generate'],
  'network:request': ['network.fetch'],
  'kv:storage': ['kv.get', 'kv.put', 'kv.delete', 'kv.list'],
};

/** The capability that unlocks `namespace.method`, or null for a method nothing unlocks. */
export function capabilityForMethod(method: string): PluginCapability | null {
  for (const capability of PLUGIN_CAPABILITIES) {
    if (PLUGIN_CAPABILITY_METHODS[capability].includes(method)) return capability;
  }
  return null;
}

/**
 * Why a plugin's call was refused:
 * - `not-granted` — the capability is not in the effective grant;
 * - `not-provided` — granted, but this deployment wires no implementation;
 * - `host-not-allowed` — `network:request` to a host outside `allowedHosts`.
 */
export type PluginDenialReason = 'not-granted' | 'not-provided' | 'host-not-allowed';

/** One refused capability call, as reported for logging and the audit trail. */
export interface PluginCapabilityDenial {
  readonly pluginId: string;
  readonly capability: PluginCapability;
  /** `namespace.method`, as the plugin called it. */
  readonly method: string;
  readonly reason: PluginDenialReason;
  readonly hook?: string;
  readonly spaceId?: string;
  readonly environmentId?: string;
  /** The refused host, for `host-not-allowed`. */
  readonly host?: string;
}

/**
 * The message a plugin sees. It crosses an RPC boundary, where the error's
 * class does not survive, so everything a plugin author needs is in the text —
 * prefixed with a stable code they can match on.
 */
export function capabilityDeniedMessage(denial: PluginCapabilityDenial): string {
  const where = `caps.${denial.method}`;
  switch (denial.reason) {
    case 'not-granted':
      return `capability_denied: plugin "${denial.pluginId}" was not granted "${denial.capability}", so ${where} is unavailable. Declare it in the manifest and have a space admin approve it.`;
    case 'not-provided':
      return `capability_denied: "${denial.capability}" is granted to plugin "${denial.pluginId}" but this deployment does not provide ${where}.`;
    case 'host-not-allowed':
      return `capability_denied: plugin "${denial.pluginId}" may not reach "${denial.host ?? '?'}" — it is not in the manifest's allowedHosts.`;
  }
}

/** A plugin called a capability method it may not use. */
export class PluginCapabilityDeniedError extends DomainError {
  readonly denial: PluginCapabilityDenial;
  constructor(denial: PluginCapabilityDenial) {
    super('capability_denied', capabilityDeniedMessage(denial), denial);
    this.denial = denial;
  }
}

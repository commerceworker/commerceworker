import {
  assertConsentCoversManifest,
  assertValidManifest,
  authorize,
  ConflictError,
  DomainError,
  effectivePluginGrant,
  ForbiddenError,
  type InstalledPlugin,
  NotFoundError,
  newlyRequestedCapabilities,
  normalizeInstalledPlugin,
  type PluginCapability,
  type PluginCapabilityDenial,
  type PluginManifest,
  type Principal,
  scopeForCapability,
  ValidationError,
} from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';
import { recordAudit } from './audit';
import type { AppContext } from './context';
import { sha256Hex } from './token-crypto';

/**
 * The plugin registry: what is installed, what it was allowed to do, and who
 * said so.
 *
 * Execution lives behind the `PluginRuntime` port. This module is deliberately
 * the half that decides *authority*, because that is the half where a mistake
 * is a security bug rather than a broken feature.
 */

/** Where a plugin's bundle lives, so the key is derivable and never guessed. */
export function pluginBundleKey(spaceId: string, pluginId: string, checksum: string): string {
  // Content-addressed: the same bytes reinstalled land on the same key, and a
  // changed bundle cannot silently occupy the old one.
  return `plugins/${spaceId}/${pluginId}/${checksum}.js`;
}

export interface InstallPluginInput {
  readonly manifest: PluginManifest;
  /** The bundle source. Stored verbatim; its SHA-256 becomes the checksum. */
  readonly bundle: string;
  /**
   * Exactly what the human approved. May be narrower than the manifest asks
   * for — that is the point of a consent screen — but never wider.
   */
  readonly approvedCapabilities: readonly PluginCapability[];
}

/**
 * Installs a plugin, after checking three separate things that are easy to
 * conflate:
 *
 * 1. the manifest is well-formed (it is a security document, so it is rejected
 *    rather than repaired);
 * 2. the consent matches the manifest — you cannot approve something the
 *    plugin never asked for, because the manifest is what was reviewed;
 * 3. the installer actually holds the authority they are delegating.
 *
 * (3) is the one that matters most. Capabilities **intersect** RBAC, they never
 * widen it: an editor who cannot publish must not be able to install a plugin
 * that can, or plugin installation becomes a privilege-escalation ladder.
 *
 * Plugins install **disabled**. Installing and turning on are separate acts, so
 * approving a capability list never silently starts running code.
 */
export async function installPlugin(
  ctx: AppContext,
  blob: BlobStore,
  principal: Principal,
  spaceId: string,
  input: InstallPluginInput,
): Promise<InstalledPlugin> {
  assertValidManifest(input.manifest);
  assertConsentCoversManifest(input.manifest, input.approvedCapabilities);
  assertInstallerHoldsCapabilities(principal, spaceId, input.approvedCapabilities);

  if (!input.bundle.trim()) {
    throw new ValidationError([{ field: 'bundle', message: 'bundle is empty' }]);
  }
  const existing = await ctx.store.plugins.get(spaceId, input.manifest.id);
  if (existing) {
    throw new ConflictError(`Plugin "${input.manifest.id}" is already installed`, {
      installedVersion: existing.manifest.version,
    });
  }

  const checksum = sha256Hex(input.bundle);
  const bundleKey = pluginBundleKey(spaceId, input.manifest.id, checksum);
  await putBundle(blob, bundleKey, input.bundle);

  const plugin: InstalledPlugin = {
    id: input.manifest.id,
    spaceId,
    manifest: input.manifest,
    checksum,
    bundleKey,
    approvedCapabilities: effectivePluginGrant(
      input.manifest.capabilities,
      input.approvedCapabilities,
    ),
    // Never enabled on install: approving a capability list and starting to
    // run code are two decisions.
    enabled: false,
    installedAt: ctx.clock.now().toISOString(),
    installedBy: principal.subject ?? principal.kind,
  };
  await ctx.store.plugins.create(plugin);
  return plugin;
}

export interface UpgradePluginInput {
  readonly manifest: PluginManifest;
  readonly bundle: string;
  /** Required only when the new version asks for capabilities not already held. */
  readonly approvedCapabilities?: readonly PluginCapability[];
}

/**
 * Replaces a plugin's bundle and manifest.
 *
 * A version that asks for *more* than was approved forces fresh consent — an
 * upgrade must never be a way to acquire capabilities quietly. A version asking
 * for the same or less carries the existing grant, narrowed to what it still
 * asks for.
 */
export async function upgradePlugin(
  ctx: AppContext,
  blob: BlobStore,
  principal: Principal,
  spaceId: string,
  input: UpgradePluginInput,
): Promise<InstalledPlugin> {
  assertValidManifest(input.manifest);
  const raw = await ctx.store.plugins.get(spaceId, input.manifest.id);
  if (!raw) throw new NotFoundError('Plugin', input.manifest.id);
  const current = normalizeInstalledPlugin(raw);
  const currentGrant = effectivePluginGrant(
    current.manifest.capabilities,
    current.approvedCapabilities,
  );

  // Only capabilities never put to a human need fresh consent. One the previous
  // version also asked for was already decided — granted or declined — and
  // that decision carries.
  const added = newlyRequestedCapabilities(current.manifest.capabilities, input.manifest);
  if (added.length > 0 && !input.approvedCapabilities) {
    // Refused, not applied: the installed version keeps running on the grant
    // it has until someone approves the new list.
    throw new ValidationError([
      {
        field: 'approvedCapabilities',
        message: `Version ${input.manifest.version} requests capabilities not previously requested (${added.join(', ')}); re-approval is required`,
      },
    ]);
  }

  const approved = input.approvedCapabilities
    ? input.approvedCapabilities
    : // Carry the grant forward, dropping anything the new version stopped
      // asking for rather than holding authority it no longer declares.
      effectivePluginGrant(input.manifest.capabilities, currentGrant);

  assertConsentCoversManifest(input.manifest, approved);
  assertInstallerHoldsCapabilities(principal, spaceId, approved);

  const checksum = sha256Hex(input.bundle);
  const bundleKey = pluginBundleKey(spaceId, input.manifest.id, checksum);
  await putBundle(blob, bundleKey, input.bundle);

  // A grant that grows stops the plugin: the operator re-enables once they
  // have seen what changed. Narrowing or keeping it does not.
  const widens = approved.some((c) => !currentGrant.includes(c));
  const { needsReapproval: _legacy, ...base } = raw;
  const upgraded: InstalledPlugin = {
    ...base,
    manifest: input.manifest,
    checksum,
    bundleKey,
    approvedCapabilities: effectivePluginGrant(input.manifest.capabilities, approved),
    enabled: widens ? false : current.enabled,
  };
  await ctx.store.plugins.save(upgraded);
  return upgraded;
}

/**
 * Records a fresh capability decision for an installed plugin, without
 * changing its code.
 *
 * Used to re-approve a plugin flagged `needsReapproval` (its manifest predates
 * the `capabilities` field), to narrow a grant, or to grant something the
 * manifest asked for that was declined earlier. The same three checks as an
 * install apply. A grant that grows disables the plugin, exactly as an upgrade
 * does — approving and running are two decisions.
 *
 * `narrowOnly` refuses anything beyond the current grant. It is what the MCP
 * surface uses: an agent may confirm or reduce what a human approved, never
 * widen it.
 */
export async function approvePluginCapabilities(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
  approvedCapabilities: readonly PluginCapability[],
  options: { narrowOnly?: boolean } = {},
): Promise<InstalledPlugin> {
  const raw = await ctx.store.plugins.get(spaceId, id);
  if (!raw) throw new NotFoundError('Plugin', id);
  const current = normalizeInstalledPlugin(raw);
  const currentGrant = effectivePluginGrant(
    current.manifest.capabilities,
    current.approvedCapabilities,
  );

  assertConsentCoversManifest(current.manifest, approvedCapabilities);
  const widened = approvedCapabilities.filter((c) => !currentGrant.includes(c));
  if (options.narrowOnly && widened.length > 0) {
    throw new DomainError(
      'forbidden',
      `This surface may confirm or narrow a plugin's grant, never widen it (would add: ${widened.join(', ')}); a human approves that in the admin`,
    );
  }
  assertInstallerHoldsCapabilities(principal, spaceId, approvedCapabilities);

  const { needsReapproval: _legacy, ...base } = current;
  const next: InstalledPlugin = {
    ...base,
    // For a legacy plugin this persists the declaration it was being treated
    // as making, which is what clears `needsReapproval`.
    manifest: current.manifest,
    approvedCapabilities: effectivePluginGrant(current.manifest.capabilities, approvedCapabilities),
    enabled: widened.length > 0 ? false : current.enabled,
  };
  await ctx.store.plugins.save(next);
  return next;
}

/** Lists a space's plugins, legacy manifests normalized and flagged for re-approval. */
export async function listPlugins(ctx: AppContext, spaceId: string): Promise<InstalledPlugin[]> {
  return (await ctx.store.plugins.list(spaceId)).map(normalizeInstalledPlugin);
}

export async function getPlugin(
  ctx: AppContext,
  spaceId: string,
  id: string,
): Promise<InstalledPlugin> {
  const plugin = await ctx.store.plugins.get(spaceId, id);
  if (!plugin) throw new NotFoundError('Plugin', id);
  return normalizeInstalledPlugin(plugin);
}

/**
 * Turns a plugin on or off without changing its grant.
 *
 * Turning *on* a plugin flagged `needsReapproval` is refused: one that is
 * already running keeps running on the grant a human gave it, but starting one
 * is a fresh decision and should be made against a current approval. Turning
 * off is always allowed.
 */
export async function setPluginEnabled(
  ctx: AppContext,
  spaceId: string,
  id: string,
  enabled: boolean,
): Promise<InstalledPlugin> {
  const raw = await ctx.store.plugins.get(spaceId, id);
  if (!raw) throw new NotFoundError('Plugin', id);
  if (enabled && !raw.enabled && normalizeInstalledPlugin(raw).needsReapproval) {
    throw new ConflictError(
      `Plugin "${id}" predates capability manifests; approve its capabilities before enabling it`,
      { pluginId: id, needsReapproval: true },
    );
  }
  // Saved from the raw record so toggling never quietly clears the
  // re-approval flag by persisting a synthesised declaration.
  const next = { ...raw, enabled };
  await ctx.store.plugins.save(next);
  return normalizeInstalledPlugin(next);
}

/**
 * Removes a plugin, its bundle, its settings and its `kv:storage` keys.
 *
 * The record goes first: an orphaned object in the blob store is harmless,
 * whereas a plugin record pointing at bytes that no longer exist would fail
 * at load time on the write path. Settings and keys go too, so reinstalling
 * the same id starts clean rather than inheriting a predecessor's secrets.
 */
export async function uninstallPlugin(
  ctx: AppContext,
  blob: BlobStore,
  spaceId: string,
  id: string,
): Promise<void> {
  const plugin = await getPlugin(ctx, spaceId, id);
  await ctx.store.plugins.delete(spaceId, id);
  await ctx.store.pluginSettings.delete(spaceId, id);
  await ctx.store.pluginStorage.deleteAll(spaceId, id);
  await blob.delete(plugin.bundleKey).catch(() => {});
}

/**
 * Fetches and verifies a plugin's bundle.
 *
 * The checksum is what binds "the bytes that run" to "the bytes a human
 * approved". Verifying on every load — not only at install — is what makes a
 * tampered or swapped object in the blob store a refusal rather than an
 * execution.
 */
export async function loadPluginBundle(
  ctx: AppContext,
  blob: BlobStore,
  spaceId: string,
  id: string,
): Promise<{ plugin: InstalledPlugin; bundle: string }> {
  const plugin = await getPlugin(ctx, spaceId, id);
  const bundle = await readBundle(blob, plugin.bundleKey);
  if (bundle === null) {
    throw new NotFoundError('PluginBundle', plugin.bundleKey);
  }
  if (sha256Hex(bundle) !== plugin.checksum) {
    throw new ConflictError(
      `Plugin "${id}" bundle does not match its approved checksum and will not be loaded`,
      { pluginId: id, bundleKey: plugin.bundleKey },
    );
  }
  return { plugin, bundle };
}

/**
 * Records a refused plugin capability call on the space's audit trail.
 *
 * Called by the sandbox runtime's denial path. A plugin reaching for something
 * it was not granted is either a packaging mistake or a plugin probing its
 * fence; either way an operator should be able to see it, not just the plugin.
 * Without a space the denial cannot be attributed, so it is not recorded.
 */
export async function recordPluginCapabilityDenial(
  ctx: AppContext,
  denial: PluginCapabilityDenial,
): Promise<void> {
  if (!denial.spaceId) return;
  await recordAudit(ctx, {
    spaceId: denial.spaceId,
    ...(denial.environmentId ? { environmentId: denial.environmentId } : {}),
    actor: `plugin:${denial.pluginId}`,
    action: `plugin.capability_denied ${denial.capability} caps.${denial.method} (${denial.reason}${denial.host ? ` ${denial.host}` : ''})`,
    targetType: 'plugin',
    targetId: denial.pluginId,
    status: 403,
  });
}

/** Refuses to delegate authority the installer does not have. */
function assertInstallerHoldsCapabilities(
  principal: Principal,
  spaceId: string,
  capabilities: readonly PluginCapability[],
): void {
  for (const capability of capabilities) {
    const scope = scopeForCapability(capability);
    if (!scope) continue;
    try {
      authorize(principal, scope, spaceId);
    } catch {
      throw new ForbiddenError(`plugin capability "${capability}" (requires ${scope})`);
    }
  }
}

/**
 * Bundles go through the BlobStore port rather than an R2 binding, so the same
 * code works against R2 in production and the in-memory fake in tests.
 */
async function putBundle(blob: BlobStore, key: string, bundle: string): Promise<void> {
  await blob.put(key, bundle, 'application/javascript');
}

async function readBundle(blob: BlobStore, key: string): Promise<string | null> {
  return blob.get(key);
}

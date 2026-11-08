import {
  applyPluginSettingsPatch,
  ConflictError,
  type InstalledPlugin,
  type PluginSettings,
  type PluginSettingsPatch,
  type PluginSettingsView,
  type PluginSettingValue,
  type Principal,
  pluginSettingsView,
  resolvePluginSettings,
} from '@commerceworker/domain';
import type { AppContext } from './context';
import { getPlugin } from './plugins';

/**
 * Plugin settings: what an operator configures, and what the plugin reads back.
 *
 * The read side an operator sees never carries a secret's value, only whether
 * one is set. Secrets are sealed under DATA_KEY at the store seam
 * (`withSealedSecrets`), so this module handles plaintext and never the format.
 */

/** A plugin's settings as an operator sees them: secrets reported as set, never shown. */
export async function getPluginSettings(
  ctx: AppContext,
  spaceId: string,
  id: string,
): Promise<PluginSettingsView> {
  const plugin = await getPlugin(ctx, spaceId, id);
  const stored = await ctx.store.pluginSettings.get(spaceId, id);
  return pluginSettingsView(id, plugin.manifest.settings ?? [], stored);
}

export interface SetPluginSettingsInput {
  /** A value per key to set, `null` to clear; keys left out keep their value. */
  readonly values: PluginSettingsPatch;
  /**
   * The `version` the caller last read. When given and stale the change is
   * refused, so an edit made against an old form cannot undo someone else's.
   */
  readonly expectedVersion?: number;
}

/**
 * Changes a plugin's settings, validated against the fields its manifest
 * declares. A compare-and-set on the record's version: a concurrent change
 * between this read and the write is a `ConflictError`, never a lost field.
 */
export async function setPluginSettings(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
  input: SetPluginSettingsInput,
): Promise<PluginSettingsView> {
  const plugin = await getPlugin(ctx, spaceId, id);
  const fields = plugin.manifest.settings ?? [];
  const current = await ctx.store.pluginSettings.get(spaceId, id);
  const version = current?.version ?? 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
    throw staleSettings(id, version);
  }

  const next = applyPluginSettingsPatch(
    fields,
    current ?? { values: {}, secrets: {} },
    input.values,
  );
  const record: PluginSettings = {
    spaceId,
    pluginId: id,
    values: next.values,
    secrets: next.secrets,
    version: version + 1,
    updatedAt: ctx.clock.now().toISOString(),
    updatedBy: principal.subject ?? principal.kind,
  };
  if (!(await ctx.store.pluginSettings.save(record, version))) {
    const now = (await ctx.store.pluginSettings.get(spaceId, id))?.version ?? 0;
    throw staleSettings(id, now);
  }
  return pluginSettingsView(id, fields, record);
}

function staleSettings(id: string, version: number): ConflictError {
  return new ConflictError(
    `Plugin "${id}" settings changed since they were read; reload them and try again`,
    { pluginId: id, version },
  );
}

/**
 * What `caps.settings.get()` returns: every declared field's value or default,
 * secrets in plaintext. The plugin's own configuration, so no capability gates
 * it, and only the plugin the settings belong to is ever handed them.
 */
export async function resolveSettingsForPlugin(
  ctx: AppContext,
  plugin: InstalledPlugin,
): Promise<Record<string, PluginSettingValue>> {
  const fields = plugin.manifest.settings ?? [];
  if (fields.length === 0) return {};
  return resolvePluginSettings(
    fields,
    await ctx.store.pluginSettings.get(plugin.spaceId, plugin.id),
  );
}

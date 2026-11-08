import { ValidationError } from '../errors';

/**
 * Plugin settings: the operator's configuration for one installed plugin.
 *
 * The manifest declares the fields (typed, some secret); an operator fills them
 * in; the plugin reads them back through `caps.settings.get()`. Settings are
 * the plugin's own configuration, so reading them needs no capability: what a
 * plugin can learn from them is exactly what an operator chose to tell it.
 *
 * Secret fields are sealed at rest under `DATA_KEY` (the store seam does it,
 * like webhook secrets) and never leave the platform through a read API: an
 * operator sees whether a secret is set, never its value. Only the plugin it
 * was set for receives the plaintext.
 */

export const PLUGIN_SETTING_TYPES = ['string', 'number', 'boolean', 'select'] as const;
export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];

/** A setting's value. Settings are flat and typed: no objects, no markup. */
export type PluginSettingValue = string | number | boolean;

/** One field a manifest declares. */
export interface PluginSettingField {
  /** Stable name, as the plugin reads it: `apiKey`, `max_length`. */
  readonly key: string;
  readonly label: string;
  readonly type: PluginSettingType;
  readonly description?: string;
  /** An operator cannot save settings that leave this unset (and it has no default). */
  readonly required?: boolean;
  /**
   * Sealed at rest and never returned by a read API. `string` fields only, with
   * no default: a default would be written in the manifest for anyone to read.
   */
  readonly secret?: boolean;
  /** The allowed values of a `select` field. */
  readonly options?: readonly string[];
  readonly default?: PluginSettingValue;
}

/** One plugin's settings in one space, as the store holds them (secrets already opened). */
export interface PluginSettings {
  readonly spaceId: string;
  readonly pluginId: string;
  /** Non-secret values, by field key. */
  readonly values: Readonly<Record<string, PluginSettingValue>>;
  /** Secret values in plaintext, by field key. The store seals each one at rest. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Bumped on every save; the compare-and-set token for concurrent edits. */
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy?: string;
}

/**
 * What a read API returns: the schema, the non-secret values (defaults
 * applied), and which secrets are set — never their values.
 */
export interface PluginSettingsView {
  readonly pluginId: string;
  readonly fields: readonly PluginSettingField[];
  readonly values: Readonly<Record<string, PluginSettingValue>>;
  /** Secret fields that hold a value, by key. */
  readonly secretsSet: readonly string[];
  /** 0 before the first save; pass it back as `expectedVersion`. */
  readonly version: number;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

/**
 * An operator's change: a value per key to set, `null` to clear. Keys left out
 * keep their value, so a secret need not be retyped to change something else.
 */
export type PluginSettingsPatch = Readonly<Record<string, PluginSettingValue | null>>;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 50;
const MAX_OPTIONS = 100;
/** Longest string (or secret) value. Settings are configuration, not content. */
export const PLUGIN_SETTING_MAX_STRING = 4096;

type Issue = { field: string; message: string };

/**
 * Checks a manifest's `settings` declaration; returns issues rather than
 * throwing so `assertValidManifest` reports everything wrong at once.
 */
export function settingsSchemaIssues(settings: unknown): Issue[] {
  if (settings === undefined) return [];
  if (!Array.isArray(settings)) return [{ field: 'settings', message: 'settings must be a list' }];
  const issues: Issue[] = [];
  if (settings.length > MAX_FIELDS) {
    issues.push({ field: 'settings', message: `At most ${MAX_FIELDS} settings` });
  }
  const seen = new Set<string>();
  for (const raw of settings as PluginSettingField[]) {
    const where = `settings.${typeof raw?.key === 'string' ? raw.key : '?'}`;
    if (typeof raw?.key !== 'string' || !KEY_PATTERN.test(raw.key)) {
      issues.push({
        field: where,
        message: 'key must start with a letter and hold only letters, digits or "_" (max 64)',
      });
      continue;
    }
    if (seen.has(raw.key)) issues.push({ field: where, message: 'Duplicate setting key' });
    seen.add(raw.key);
    if (typeof raw.label !== 'string' || !raw.label.trim()) {
      issues.push({ field: where, message: 'label is required' });
    }
    if (!(PLUGIN_SETTING_TYPES as readonly string[]).includes(raw.type)) {
      issues.push({ field: where, message: `Unknown setting type "${String(raw.type)}"` });
      continue;
    }
    if (raw.secret && raw.type !== 'string') {
      issues.push({ field: where, message: 'Only string settings can be secret' });
    }
    if (raw.secret && raw.default !== undefined) {
      issues.push({ field: where, message: 'A secret setting cannot have a default' });
    }
    if (raw.type === 'select') {
      const options = raw.options;
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.length > MAX_OPTIONS ||
        options.some((o) => typeof o !== 'string' || !o || o.length > 200)
      ) {
        issues.push({
          field: where,
          message: `A select setting needs 1–${MAX_OPTIONS} non-empty string options`,
        });
      }
    } else if (raw.options !== undefined) {
      issues.push({ field: where, message: 'options is only for select settings' });
    }
    if (raw.default !== undefined) {
      const problem = valueProblem(raw, raw.default);
      if (problem) issues.push({ field: where, message: `default ${problem}` });
    }
  }
  return issues;
}

/** Why `value` does not fit `field`, or null when it does. */
function valueProblem(field: PluginSettingField, value: unknown): string | null {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      if (value.length > PLUGIN_SETTING_MAX_STRING) {
        return `must be at most ${PLUGIN_SETTING_MAX_STRING} characters`;
      }
      return null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'select':
      return typeof value === 'string' && (field.options ?? []).includes(value)
        ? null
        : `must be one of: ${(field.options ?? []).join(', ')}`;
  }
}

/**
 * Applies an operator's patch to the stored settings, against the manifest's
 * fields. Refuses an unknown key, a mistyped value, or a result that leaves a
 * required field without a value or a default.
 */
export function applyPluginSettingsPatch(
  fields: readonly PluginSettingField[],
  current: Pick<PluginSettings, 'values' | 'secrets'>,
  patch: PluginSettingsPatch,
): Pick<PluginSettings, 'values' | 'secrets'> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const values: Record<string, PluginSettingValue> = {};
  const secrets: Record<string, string> = {};
  // Only what the current schema still declares carries over: a field an
  // upgrade removed is dropped at the next save rather than kept forever.
  for (const field of fields) {
    const v = field.secret ? current.secrets[field.key] : current.values[field.key];
    if (v === undefined || valueProblem(field, v)) continue;
    if (field.secret) secrets[field.key] = v as string;
    else values[field.key] = v;
  }

  const issues: Issue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) {
      issues.push({ field: key, message: 'The plugin declares no such setting' });
      continue;
    }
    if (value === null) {
      delete values[key];
      delete secrets[key];
      continue;
    }
    const problem = valueProblem(field, value);
    if (problem) {
      issues.push({ field: key, message: problem });
      continue;
    }
    if (field.secret) secrets[key] = value as string;
    else values[key] = value;
  }
  for (const field of fields) {
    if (!field.required || field.default !== undefined) continue;
    const set = field.secret ? secrets[field.key] : values[field.key];
    if (set === undefined || set === '') {
      issues.push({ field: field.key, message: `${field.label} is required` });
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { values, secrets };
}

/**
 * What the plugin reads: every declared field's value (or default), secrets in
 * plaintext. A stored value that no longer fits the field (an upgrade changed
 * its type) falls back to the default instead of reaching the plugin mistyped.
 */
export function resolvePluginSettings(
  fields: readonly PluginSettingField[],
  stored: Pick<PluginSettings, 'values' | 'secrets'> | null,
): Record<string, PluginSettingValue> {
  const out: Record<string, PluginSettingValue> = {};
  for (const field of fields) {
    const v = field.secret ? stored?.secrets[field.key] : stored?.values[field.key];
    if (v !== undefined && !valueProblem(field, v)) out[field.key] = v;
    else if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** What a read API returns: no secret value, only whether one is set. */
export function pluginSettingsView(
  pluginId: string,
  fields: readonly PluginSettingField[],
  stored: PluginSettings | null,
): PluginSettingsView {
  const resolved = resolvePluginSettings(
    fields.filter((f) => !f.secret),
    stored,
  );
  const secretsSet = fields
    .filter((f) => f.secret && typeof stored?.secrets[f.key] === 'string')
    .map((f) => f.key);
  return {
    pluginId,
    fields,
    values: resolved,
    secretsSet,
    version: stored?.version ?? 0,
    ...(stored ? { updatedAt: stored.updatedAt } : {}),
    ...(stored?.updatedBy ? { updatedBy: stored.updatedBy } : {}),
  };
}

// ---------------------------------------------------------------------------
// kv:storage
// ---------------------------------------------------------------------------

/**
 * Bounds on a plugin's key/value store, per plugin per environment. A plugin
 * runs inside an editor's save, so its scratch space is for small state
 * (a cursor, a cache of a lookup, a counter), not for content.
 */
export const PLUGIN_KV_LIMITS = {
  maxKeyLength: 512,
  /** Bytes of the value's JSON encoding. */
  maxValueBytes: 64 * 1024,
  maxKeys: 1000,
  /** Keys per `list` page. */
  maxListLimit: 100,
} as const;

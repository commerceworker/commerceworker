import { apiFieldIssues, type PluginSettingField, type PluginSettingsView } from './management';

/**
 * The settings form's state and what it sends, kept out of the screen.
 *
 * The form holds text for every typed field (so a half-typed number stays as typed) and a decision
 * for every secret, never a secret's value from the server: the API has none to give. What is sent
 * is a patch of the fields that changed, so a save never resends, or blanks, a secret nobody
 * touched, and the server stays the one judge of what a value may be.
 */

/** What the operator decided about a secret: leave it, replace it, or remove it. */
export type SecretDraft =
  | { readonly action: 'keep' }
  | { readonly action: 'replace'; readonly value: string }
  | { readonly action: 'clear' };

/** Text for string, number and select fields; a boolean for a switch; a decision for a secret. */
export type SettingDraft = string | boolean | SecretDraft;
export type SettingsDraft = Readonly<Record<string, SettingDraft>>;

export type SettingsPatch = Record<string, string | number | boolean | null>;

const isSecretDraft = (d: SettingDraft | undefined): d is SecretDraft =>
  typeof d === 'object' && d !== null;

/** The form as the saved settings fill it: secrets kept, everything else as stored (or default). */
export function settingsDraft(view: PluginSettingsView): SettingsDraft {
  const draft: Record<string, SettingDraft> = {};
  for (const field of view.fields) {
    const value = view.values[field.key];
    if (field.secret) draft[field.key] = { action: 'keep' };
    else if (field.type === 'boolean') draft[field.key] = value === true;
    else draft[field.key] = value === undefined ? '' : String(value);
  }
  return draft;
}

/**
 * Only what changed, as the PATCH takes it: a value to set, `null` to clear. An emptied field is
 * cleared (its default, if any, applies again); a number that does not parse is sent as typed so
 * the server's refusal lands beside the field rather than being guessed at here.
 */
export function settingsPatch(view: PluginSettingsView, draft: SettingsDraft): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const field of view.fields) {
    const d = draft[field.key];
    const saved = view.values[field.key];
    if (field.secret) {
      if (!isSecretDraft(d)) continue;
      if (d.action === 'replace' && d.value !== '') patch[field.key] = d.value;
      else if (d.action === 'clear' && view.secretsSet.includes(field.key)) patch[field.key] = null;
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof d === 'boolean' && d !== (saved === true)) patch[field.key] = d;
      continue;
    }
    if (typeof d !== 'string') continue;
    const text = field.type === 'number' ? d.trim() : d;
    if (text === '') {
      if (saved !== undefined) patch[field.key] = null;
      continue;
    }
    const value = field.type === 'number' ? numberOrText(text) : text;
    if (value !== saved) patch[field.key] = value;
  }
  return patch;
}

const numberOrText = (text: string): number | string => {
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
};

/**
 * A refused save's issues by setting key. The domain names the key (`apiKey`); the body parser
 * names its path (`values.apiKey`). Issues that name no declared field come back under `form`.
 */
export function settingsIssues(
  fields: readonly PluginSettingField[],
  err: unknown,
): { readonly byKey: Readonly<Record<string, string>>; readonly form: readonly string[] } {
  const keys = new Set(fields.map((f) => f.key));
  const byKey: Record<string, string> = {};
  const form: string[] = [];
  for (const [path, message] of Object.entries(apiFieldIssues(err))) {
    const key = path.startsWith('values.') ? path.slice('values.'.length) : path;
    if (keys.has(key)) byKey[key] ??= message;
    else form.push(message);
  }
  return { byKey, form };
}

/** What an empty field falls back to, in words, for its hint. */
export function defaultHint(field: PluginSettingField): string | undefined {
  if (field.default === undefined) return undefined;
  if (field.type === 'boolean') return `Defaults to ${field.default ? 'on' : 'off'}.`;
  return `Empty uses the default, ${String(field.default)}.`;
}

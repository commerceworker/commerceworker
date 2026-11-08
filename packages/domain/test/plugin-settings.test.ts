import { describe, expect, it } from 'vitest';
import {
  applyPluginSettingsPatch,
  assertValidManifest,
  PLUGIN_CAPABILITY_METHODS,
  type PluginManifest,
  type PluginSettingField,
  pluginSettingsView,
  resolvePluginSettings,
  settingsSchemaIssues,
  ValidationError,
} from '../src/index';

const FIELDS: PluginSettingField[] = [
  { key: 'apiKey', label: 'API key', type: 'string', secret: true, required: true },
  { key: 'maxLength', label: 'Max length', type: 'number', default: 120 },
  { key: 'strict', label: 'Strict', type: 'boolean' },
  { key: 'tone', label: 'Tone', type: 'select', options: ['plain', 'formal'], default: 'plain' },
];

const manifest = (settings: unknown): PluginManifest =>
  ({
    id: 'com.example.seo',
    name: 'SEO',
    version: '1.0.0',
    capabilities: [],
    allowedHosts: [],
    hooks: [],
    entrypoint: 'index.js',
    settings,
  }) as PluginManifest;

describe('a manifest’s settings declaration', () => {
  it('accepts typed fields, and no declaration at all', () => {
    expect(() => assertValidManifest(manifest(FIELDS))).not.toThrow();
    expect(() => assertValidManifest(manifest(undefined))).not.toThrow();
  });

  it('refuses what a form could not render or a store could not keep apart', () => {
    const messages = settingsSchemaIssues([
      { key: '1bad', label: 'x', type: 'string' },
      { key: 'dup', label: 'a', type: 'string' },
      { key: 'dup', label: 'b', type: 'string' },
      { key: 'n', label: 'n', type: 'number', secret: true },
      { key: 's', label: 's', type: 'string', secret: true, default: 'leaked' },
      { key: 'pick', label: 'p', type: 'select', options: [] },
      { key: 'odd', label: 'o', type: 'json' },
      { key: 'nolabel', label: ' ', type: 'boolean' },
      { key: 'wrongDefault', label: 'w', type: 'number', default: 'ten' },
    ]).map((i) => `${i.field}: ${i.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^settings\.1bad: key must start with a letter/),
      'settings.dup: Duplicate setting key',
      'settings.n: Only string settings can be secret',
      'settings.s: A secret setting cannot have a default',
      expect.stringMatching(/^settings\.pick: A select setting needs/),
      'settings.odd: Unknown setting type "json"',
      'settings.nolabel: label is required',
      'settings.wrongDefault: default must be a number',
    ]);
    expect(() => assertValidManifest(manifest('nope'))).toThrow(ValidationError);
  });
});

describe('applying an operator’s change', () => {
  const empty = { values: {}, secrets: {} };

  it('splits secrets from values and keeps what the patch leaves out', () => {
    const first = applyPluginSettingsPatch(FIELDS, empty, { apiKey: 'sk_1', strict: true });
    expect(first).toEqual({ values: { strict: true }, secrets: { apiKey: 'sk_1' } });
    // Changing something else does not need the secret retyped.
    const second = applyPluginSettingsPatch(FIELDS, first, { tone: 'formal' });
    expect(second).toEqual({
      values: { strict: true, tone: 'formal' },
      secrets: { apiKey: 'sk_1' },
    });
  });

  it('clears with null, and refuses to clear a required field', () => {
    const set = applyPluginSettingsPatch(FIELDS, empty, { apiKey: 'sk', strict: true });
    expect(applyPluginSettingsPatch(FIELDS, set, { strict: null }).values).toEqual({});
    expect(() => applyPluginSettingsPatch(FIELDS, set, { apiKey: null })).toThrow(ValidationError);
  });

  it('refuses unknown keys and mistyped values, all at once', () => {
    try {
      applyPluginSettingsPatch(FIELDS, empty, {
        apiKey: 'sk',
        nope: 1,
        maxLength: 'long',
        tone: 'shouty',
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ValidationError).issues.map((i) => i.field)).toEqual([
        'nope',
        'maxLength',
        'tone',
      ]);
    }
  });

  it('drops a stored value whose field an upgrade removed or retyped', () => {
    const stored = { values: { gone: 'x', maxLength: 'was a string' }, secrets: { apiKey: 'sk' } };
    expect(applyPluginSettingsPatch(FIELDS, stored as never, {})).toEqual({
      values: {},
      secrets: { apiKey: 'sk' },
    });
  });
});

describe('reading settings back', () => {
  const stored = {
    spaceId: 's1',
    pluginId: 'com.example.seo',
    values: { strict: false, maxLength: 'retyped' },
    secrets: { apiKey: 'sk_live' },
    version: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'usr_1',
  } as never;

  it('gives the plugin every value, defaults and secrets included', () => {
    expect(resolvePluginSettings(FIELDS, stored)).toEqual({
      apiKey: 'sk_live',
      maxLength: 120,
      strict: false,
      tone: 'plain',
    });
    expect(resolvePluginSettings(FIELDS, null)).toEqual({ maxLength: 120, tone: 'plain' });
  });

  it('gives an operator whether a secret is set, never its value', () => {
    const view = pluginSettingsView('com.example.seo', FIELDS, stored);
    expect(view).toEqual({
      pluginId: 'com.example.seo',
      fields: FIELDS,
      values: { maxLength: 120, strict: false, tone: 'plain' },
      secretsSet: ['apiKey'],
      version: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'usr_1',
    });
    expect(JSON.stringify(view)).not.toContain('sk_live');
    expect(pluginSettingsView('x', FIELDS, null)).toMatchObject({ version: 0, secretsSet: [] });
  });
});

it('kv:storage unlocks get, put, delete and list', () => {
  expect(PLUGIN_CAPABILITY_METHODS['kv:storage']).toEqual([
    'kv.get',
    'kv.put',
    'kv.delete',
    'kv.list',
  ]);
});

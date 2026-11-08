import { describe, expect, it } from 'vitest';
import {
  assertValidManifest,
  capabilityDeniedMessage,
  capabilityForMethod,
  effectivePluginGrant,
  type InstalledPlugin,
  newlyRequestedCapabilities,
  normalizeInstalledPlugin,
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_METHODS,
  PluginCapabilityDeniedError,
  type PluginManifest,
  requiresReconsent,
  ValidationError,
} from '../src/index';

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

const installed = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'com.example.one',
  spaceId: 's1',
  manifest: manifest(),
  checksum: 'abc',
  bundleKey: 'plugins/s1/com.example.one/abc.js',
  approvedCapabilities: ['content:read'],
  enabled: true,
  installedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the effective grant', () => {
  it('is declared ∩ approved', () => {
    expect(
      effectivePluginGrant(['content:read', 'content:write'], ['content:write', 'content:publish']),
    ).toEqual(['content:write']);
  });

  it('never honours an approval the manifest does not declare', () => {
    expect(effectivePluginGrant([], ['content:publish'])).toEqual([]);
  });

  it('drops unknown strings and duplicates, in vocabulary order', () => {
    expect(
      effectivePluginGrant(
        ['network:request', 'content:read', 'root:everything', 'content:read'],
        ['content:read', 'network:request', 'root:everything'],
      ),
    ).toEqual(['content:read', 'network:request']);
  });

  it('treats a missing side as granting nothing', () => {
    expect(effectivePluginGrant(undefined, ['content:read'])).toEqual([]);
    expect(effectivePluginGrant(['content:read'], undefined)).toEqual([]);
  });
});

describe('what an upgrade must ask again', () => {
  it('is only what was never requested before', () => {
    const next = manifest({ capabilities: ['content:read', 'content:write', 'kv:storage'] });
    expect(newlyRequestedCapabilities(['content:read', 'content:write'], next)).toEqual([
      'kv:storage',
    ]);
    expect(requiresReconsent(['content:read', 'content:write'], next)).toBe(true);
  });

  it('does not reopen a capability that was declined but is still requested', () => {
    // Declined last time is still a decision; re-asking is not new information.
    const next = manifest({ capabilities: ['content:read', 'content:write'] });
    expect(requiresReconsent(['content:read', 'content:write'], next)).toBe(false);
  });
});

describe('manifests that predate the capabilities field', () => {
  const legacy = () =>
    installed({
      manifest: { ...manifest(), capabilities: undefined } as unknown as PluginManifest,
      approvedCapabilities: ['content:read', 'taxonomy:read'],
    });

  it('are treated as requesting exactly the access they already hold', () => {
    const normalized = normalizeInstalledPlugin(legacy());
    expect(normalized.manifest.capabilities).toEqual(['content:read', 'taxonomy:read']);
    expect(
      effectivePluginGrant(normalized.manifest.capabilities, normalized.approvedCapabilities),
    ).toEqual(['content:read', 'taxonomy:read']);
  });

  it('are flagged for re-approval', () => {
    expect(normalizeInstalledPlugin(legacy()).needsReapproval).toBe(true);
  });

  it('leave a current manifest alone, and unflagged', () => {
    const current = normalizeInstalledPlugin(installed({ needsReapproval: true }));
    expect(current.needsReapproval).toBeUndefined();
    expect(current.manifest.capabilities).toEqual(['content:read']);
  });

  it('are refused at install: the field is required, even empty', () => {
    const missing = { ...manifest(), capabilities: undefined } as unknown as PluginManifest;
    expect(() => assertValidManifest(missing)).toThrow(ValidationError);
    expect(() => assertValidManifest(manifest({ capabilities: [] }))).not.toThrow();
  });
});

describe('manifest capability validation', () => {
  it('refuses a duplicated capability', () => {
    expect(() =>
      assertValidManifest(manifest({ capabilities: ['content:read', 'content:read'] })),
    ).toThrow(ValidationError);
  });
});

describe('the method map', () => {
  it('gives every capability at least one method', () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      expect(PLUGIN_CAPABILITY_METHODS[capability].length).toBeGreaterThan(0);
    }
  });

  it('attributes every method to exactly one capability', () => {
    const all = PLUGIN_CAPABILITIES.flatMap((c) => PLUGIN_CAPABILITY_METHODS[c]);
    expect(new Set(all).size).toBe(all.length);
    expect(capabilityForMethod('content.create')).toBe('content:write');
    expect(capabilityForMethod('network.fetch')).toBe('network:request');
    expect(capabilityForMethod('secrets.read')).toBeNull();
  });
});

describe('a denied call', () => {
  it('says which capability is missing, with a stable prefix', () => {
    const denial = {
      pluginId: 'com.example.one',
      capability: 'content:write',
      method: 'content.create',
      reason: 'not-granted',
    } as const;
    expect(capabilityDeniedMessage(denial)).toMatch(
      /^capability_denied: plugin "com\.example\.one" was not granted "content:write", so caps\.content\.create/,
    );
    const err = new PluginCapabilityDeniedError(denial);
    expect(err.code).toBe('capability_denied');
    expect(err.denial).toBe(denial);
  });

  it('names the refused host', () => {
    expect(
      capabilityDeniedMessage({
        pluginId: 'p',
        capability: 'network:request',
        method: 'network.fetch',
        reason: 'host-not-allowed',
        host: 'evil.example',
      }),
    ).toContain('"evil.example"');
  });
});

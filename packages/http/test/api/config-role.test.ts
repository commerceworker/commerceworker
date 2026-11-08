import { loadConfig, mountsRole } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';

describe('ROLE parsing', () => {
  it('accepts a single role', () => {
    const config = loadConfig({ ROLE: 'delivery' } as NodeJS.ProcessEnv);
    expect(mountsRole(config, 'delivery')).toBe(true);
    expect(mountsRole(config, 'preview')).toBe(false);
    expect(mountsRole(config, 'management')).toBe(false);
  });

  it('accepts a comma-separated union (scale-out read plane)', () => {
    const config = loadConfig({ ROLE: 'delivery,preview' } as NodeJS.ProcessEnv);
    expect(mountsRole(config, 'delivery')).toBe(true);
    expect(mountsRole(config, 'preview')).toBe(true);
    expect(mountsRole(config, 'management')).toBe(false);
  });

  it('tolerates whitespace around list items', () => {
    const config = loadConfig({ ROLE: ' delivery , preview ' } as NodeJS.ProcessEnv);
    expect(mountsRole(config, 'preview')).toBe(true);
  });

  it('all mounts every surface, and remains the default', () => {
    for (const config of [
      loadConfig({} as NodeJS.ProcessEnv),
      loadConfig({ ROLE: 'all' } as NodeJS.ProcessEnv),
    ]) {
      expect(mountsRole(config, 'management')).toBe(true);
      expect(mountsRole(config, 'delivery')).toBe(true);
      expect(mountsRole(config, 'preview')).toBe(true);
    }
  });

  it('rejects unknown roles, including inside a list', () => {
    expect(() => loadConfig({ ROLE: 'bogus' } as NodeJS.ProcessEnv)).toThrow(/Invalid ROLE/);
    expect(() => loadConfig({ ROLE: 'delivery,bogus' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid ROLE/,
    );
    expect(() => loadConfig({ ROLE: 'delivery,' } as NodeJS.ProcessEnv)).toThrow(/Invalid ROLE/);
  });
});

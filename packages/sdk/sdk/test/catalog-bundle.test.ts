import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));

// The catalog client runs in shoppers' browsers, and its limits are generated from core's source.
// Bundle the entry the way tsup.config.ts does and read what comes out: the generated file must
// have carried constants, not imports.
describe('the catalog subpath, built', () => {
  let out: string;
  let files: string[];
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'sdk-catalog-'));
    await build({
      config: false,
      silent: true,
      cwd: pkg,
      entry: { catalog: 'src/catalog.ts' },
      format: ['esm', 'cjs'],
      noExternal: [/^@commerceworker\//],
      outDir: out,
      target: 'es2022',
    });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    files = walk(out).filter((f) => /\.(js|cjs)$/.test(f));
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('writes the entry as ESM and CJS', () => {
    const names = files.map((f) => f.slice(out.length + 1)).sort();
    expect(names).toEqual(expect.arrayContaining(['catalog.cjs', 'catalog.js']));
  });

  it('contains no zod, no @commerceworker/core and no node: import', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/["']zod(\/[^"']*)?["']/);
      expect(text, file).not.toContain('@commerceworker/core');
      expect(text, file).not.toMatch(/["']node:/);
      expect(text, file).not.toMatch(/\brequire\(/);
    }
  });

  it('is small enough to ship to a browser', () => {
    const esm = readFileSync(join(out, 'catalog.js'), 'utf8');
    expect(esm.length).toBeLessThan(20_000);
  });
});

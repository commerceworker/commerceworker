import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));

// The commerce client is generated from the web app's zod schemas, but only their TypeScript
// types ship. Bundle the two commerce entries the way tsup.config.ts does and read what comes out.
describe('the commerce subpaths, built', () => {
  let out: string;
  let files: string[];
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'sdk-commerce-'));
    await build({
      config: false,
      silent: true,
      cwd: pkg,
      entry: { commerce: 'src/commerce.ts', 'commerce-webhooks': 'src/commerce-webhooks.ts' },
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

  it('writes each entry as ESM and CJS', () => {
    const names = files.map((f) => f.slice(out.length + 1)).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'commerce.cjs',
        'commerce.js',
        'commerce-webhooks.cjs',
        'commerce-webhooks.js',
      ]),
    );
  });

  it('contains no zod, no @commerceworker/core and no node: import', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/["']zod(\/[^"']*)?["']/);
      expect(text, file).not.toContain('@commerceworker/core');
      expect(text, file).not.toMatch(/["']node:/);
    }
  });
});

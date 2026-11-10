import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The catalog path's size budget. The catalog's entry modules are bundled on their own, minified
 * as the Worker is, so anything from the content stack that one of them imports (the http, platform
 * or application packages, hono, zod through core's full model) shows up as a jump in size, and in
 * the module list. The delivery Worker's one script carries both sides; this holds the catalog's
 * share of it to about 10 KiB gzipped (8.1 KiB when the budget was set).
 */
const BUDGET_GZIP = 10 * 1024;

const bundle = () =>
  build({
    stdin: {
      contents: "export * from './gateway'; export { CatalogDelivery } from './delivery';",
      resolveDir: new URL('../src/catalog/', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    minify: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });

describe('catalog entrypoint bundle', () => {
  it('stays within its gzipped budget', async () => {
    const out = await bundle();
    const size = gzipSync(out.outputFiles[0]?.contents ?? new Uint8Array()).length;
    expect(size, `${size} bytes gzipped`).toBeLessThanOrEqual(BUDGET_GZIP);
  });

  it('imports nothing of the content stack, nor core outside its zod-free subpaths', async () => {
    const inputs = Object.keys((await bundle()).metafile.inputs);
    const stray = inputs.filter(
      (f) =>
        !f.startsWith('<stdin>') &&
        !f.startsWith('src/catalog/') &&
        !/packages\/core\/src\/product\/(paths|listing|listing-index|routing|search)\.ts$/.test(f),
    );
    expect(stray).toEqual([]);
  });
});

import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The catalog Worker's size budget. `src/catalog/worker.ts`, the entry `wrangler.catalog.jsonc`
 * deploys, is bundled as it is, minified as the Worker is, so anything from the content stack that
 * it imports (the http, platform or application packages, hono, zod through core's full model)
 * shows up as a jump in size, and in the module list. This holds the deployed script to about 10 KiB gzipped (8.1 KiB when the budget was set).
 */
const BUDGET_GZIP = 10 * 1024;

const bundle = () =>
  build({
    entryPoints: ['src/catalog/worker.ts'],
    absWorkingDir: new URL('..', import.meta.url).pathname,
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

describe('the catalog Worker bundle', () => {
  it('stays within its gzipped budget', async () => {
    const out = await bundle();
    const size = gzipSync(out.outputFiles[0]?.contents ?? new Uint8Array()).length;
    expect(size, `${size} bytes gzipped`).toBeLessThanOrEqual(BUDGET_GZIP);
  });

  it('imports nothing of the content stack, nor core outside its zod-free subpaths', async () => {
    const inputs = Object.keys((await bundle()).metafile.inputs);
    const stray = inputs.filter(
      (f) =>
        !f.startsWith('src/catalog/') &&
        !/packages\/core\/src\/product\/(paths|listing|listing-index|routing|search)\.ts$/.test(f),
    );
    expect(stray).toEqual([]);
  });
});

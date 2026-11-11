/**
 * Writes src/generated/operations.ts from the web app's OpenAPI document, the way apps/docs builds
 * its explorer's: by importing `openApiDocument` from the web source, so the types match the code at
 * this commit. `--check` writes nothing and exits 1 when the committed file is stale (the drift
 * test runs it). This is build tooling: nothing under src/ imports the web app, and the published
 * client carries only the generated file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../../../../apps/web/app/lib/openapi';
import { emit } from './emit';

const target = fileURLToPath(new URL('../src/generated/operations.ts', import.meta.url));
const next = emit(openApiDocument('https://app.commerceworker.com'));

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== next) {
    console.error(
      'src/generated/operations.ts is stale: run `pnpm --filter @commerceworker/sdk-commerce generate:operations`',
    );
    process.exit(1);
  }
  console.log('src/generated/operations.ts is current');
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}

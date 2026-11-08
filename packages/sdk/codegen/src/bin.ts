#!/usr/bin/env node
/** Bin entry: always runs. Importable logic lives in cli.ts / generate.ts. */
import { main } from './cli.js';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

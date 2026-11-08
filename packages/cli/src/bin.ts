#!/usr/bin/env node
/** Bin entry: always runs. Everything testable lives in run.ts and the modules it calls. */
import { processIo } from './io.js';
import { run } from './run.js';

run(process.argv.slice(2), processIo()).then((code) => {
  process.exitCode = code;
});

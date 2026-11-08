import { defineConfig } from 'vitest/config';

// Unit tests for the gateway's pure parts: visibility profiles, canonical cache URLs, and the
// rationed purge drain.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });

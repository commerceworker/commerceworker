import { env } from 'cloudflare:workers';

/** The test Worker's bindings (vitest.config.ts). */
export const testDb = (env as unknown as { DB: D1Database }).DB;

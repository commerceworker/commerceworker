import { defineConfig, devices } from '@playwright/test';

/**
 * `E2E_PORT` moves the dev server off 5391, so device tests in another worktree (or the admin's,
 * on 5390) can run at the same time. A server already on the port is reused only with
 * `E2E_REUSE=1`: otherwise the run would quietly test whatever another checkout is serving there,
 * and `--strictPort` stops it instead.
 */
const PORT = Number(process.env.E2E_PORT ?? 5391);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error(
    `E2E_PORT must be a port number from 1024 to 65535, not "${process.env.E2E_PORT}"`,
  );
const state = '.wrangler/e2e';

/**
 * Device tests: the buyer's pages in WebKit on an iPhone and an iPad, both ways up, plus a desktop,
 * against the dev server running offline (COMMERCEWORKER_E2E in vite.config.ts) with an engine of its
 * own on a fresh database. They check what unit tests can't: layout at each size, the safe areas
 * and the headers a buyer's frame depends on. See docs/testing.md.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One test at a time on CI and two retries, as the admin's device tests: the runner is small.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'iphone-landscape', use: { ...devices['iPhone 15 landscape'] } },
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'ipad-landscape', use: { ...devices['iPad Pro 11 landscape'] } },
    { name: 'desktop', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: [
      `rm -rf ${state}`,
      // The engine's database (the storefront has none): the engine runs as its auxiliary Worker.
      `wrangler d1 migrations apply commerceworker --local --persist-to ${state} --config ../engine/wrangler.jsonc`,
      `COMMERCEWORKER_E2E=1 react-router dev --port ${PORT} --strictPort`,
    ].join(' && '),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI && process.env.E2E_REUSE === '1',
    timeout: 180_000,
    stdout: 'ignore',
  },
});

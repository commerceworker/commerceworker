import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5392);
const state = '.wrangler/content-e2e';

export default defineConfig({
  testDir: 'e2e-content',
  globalSetup: './e2e-content/warm.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'desktop', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: [
      `wrangler d1 migrations apply commerceworker --local --persist-to ${state}`,
      `wrangler d1 migrations apply DB --local --config dev/content-database.jsonc --persist-to ${state}`,
      `COMMERCEWORKER_CONTENT=1 COMMERCEWORKER_E2E=1 COMMERCEWORKER_STATE=${state} react-router dev --port ${port} --strictPort`,
    ].join(' && '),
    url: `http://localhost:${port}/health`,
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 180_000,
  },
});

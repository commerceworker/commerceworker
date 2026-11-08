import { defineConfig, devices } from '@playwright/test';

// E2E_PORT runs a second suite beside one already on 5390 (another worktree's), with its own server.
const PORT = Number(process.env.E2E_PORT) || 5390;
const state = '.wrangler/e2e';

/**
 * Device tests: the admin in WebKit on an iPhone and an iPad, both ways up, plus a desktop, against
 * the dev server running offline (COMMERCEWORKER_E2E in vite.config.ts) on a fresh database with no
 * one added, so local development is open. They check what unit tests can't: layout at each size,
 * the safe areas and touch targets. The `auth` project signs the first admin up, which turns
 * sign-in on for the server, so it runs after the others.
 */
const DEVICES = ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop', 'cms'];

/**
 * CI runs the suite in four jobs at once, each on its own server, named by `E2E_PART`:
 * `webkit` (the iPhone, iPad and desktop projects), `axe` (the accessibility sweep and the modal
 * focus specs, the desktop project's too), `cms` (every other CMS spec, so a new one lands here) and
 * `sign-in` (the
 * projects that sign the first admin up, with no device tests to wait for). Each is about a third
 * of the suite's time. Unset, the whole suite runs in order, as it does locally.
 */
const PARTS = ['webkit', 'axe', 'cms', 'sign-in'] as const;
const PART = process.env.E2E_PART as (typeof PARTS)[number] | undefined;
if (PART && !PARTS.includes(PART)) {
  throw new Error(`E2E_PART is "${PART}"; use ${PARTS.join(', ')} or leave it unset`);
}
const AXE = /(accessibility|modal-focus)\.spec\.ts/;
const partOf = (project: string) =>
  project === 'cms'
    ? ['axe', 'cms']
    : project === 'desktop'
      ? ['webkit', 'axe']
      : DEVICES.includes(project)
        ? ['webkit']
        : ['sign-in'];

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/warm.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI's runner has 4 vCPUs shared with the dev server and workerd: two browsers keep it busy
  // without starving the server. Specs stamp their own data, so they run side by side.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone',
      // The editor's action bar sits above the tab bar only on a phone: measured here too, with
      // the entry form's tabs and the entries list.
      testMatch: [
        'shell.spec.ts',
        'editor-action-bar.spec.ts',
        'entry-tabs.spec.ts',
        'entries-list-phone.spec.ts',
        'modals-phone.spec.ts',
      ],
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'iphone-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPhone 15 landscape'] },
    },
    {
      name: 'ipad',
      testMatch: ['shell.spec.ts', 'entry-tabs.spec.ts'],
      use: { ...devices['iPad (gen 7)'] },
    },
    {
      name: 'ipad-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPad Pro 11 landscape'] },
    },
    {
      name: 'desktop',
      // Its modal focus specs run in the `axe` part, which evens out the parts' time.
      testMatch: PART === 'axe' ? 'modal-focus.spec.ts' : ['shell.spec.ts', 'modal-focus.spec.ts'],
      testIgnore: PART === 'webkit' ? 'modal-focus.spec.ts' : undefined,
      use: { ...devices['Desktop Safari'] },
    },
    // The CMS screens (seeded through the same-origin gateway while sign-in is still open), with
    // the axe sweep. Desktop Chrome: the editors are review-only below lg.
    {
      name: 'cms',
      testMatch:
        PART === 'axe'
          ? AXE
          : /(cms|workflows|space-access|first-space|block-patch-card|accessibility|contrast-settle|modal-focus)\.spec\.ts/,
      testIgnore: PART === 'cms' ? AXE : undefined,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'auth',
      testMatch: 'login.spec.ts',
      dependencies: PART === 'sign-in' ? [] : DEVICES,
      // Chromium: it keeps the `Secure` session cookie on http://localhost, which WebKit drops.
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Invitations, once sign-in is on: someone joins from a link, and someone with an account
      // signs in and accepts. Its own people, so it runs beside `oauth`.
      name: 'invites',
      testMatch: 'invites.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // OAuth for MCP clients, signed in as the admin the `auth` project created.
      name: 'oauth',
      testMatch: 'oauth.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'] },
    },
  ].filter((project) => !PART || partOf(project.name).includes(PART)),
  webServer: {
    command: [
      `rm -rf ${state}`,
      `wrangler d1 migrations apply commerceworker --local --persist-to ${state}`,
      `COMMERCEWORKER_E2E=1 PORT=${PORT} react-router dev`,
    ].join(' && '),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
  },
});

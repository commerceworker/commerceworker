import { devices, type FullConfig, request, webkit } from '@playwright/test';
import { seedAgentProposal } from './cms';
import { PAGES } from './helpers';

/**
 * Seeds the e2e space and its agent proposal, then visits every page once before the tests. The
 * first time the dev server sees a page's client dependencies it bundles them and reloads the
 * browser, which would interrupt whichever test got there first. It's only a head start: a page that still fails is reported and skipped, and the
 * tests (which wait for what they need) say whether anything is actually wrong.
 */
export default async function warm(config: FullConfig) {
  const base = config.projects[0]!.use.baseURL!;
  // The agent proposal the Approvals sweeps need, written before the tests start.
  const api = await request.newContext({ baseURL: base });
  await seedAgentProposal(api);
  await api.dispose();
  const browser = await webkit.launch();
  const page = await browser.newPage({ ...devices['iPhone 15'] });
  for (const path of [...PAGES, '/login']) {
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(base + path, { waitUntil: 'networkidle' });
        break;
      } catch (err) {
        if (i === 2) console.warn(`warm-up: ${path} skipped: ${(err as Error).message}`);
      }
    }
  }
  await browser.close();
}

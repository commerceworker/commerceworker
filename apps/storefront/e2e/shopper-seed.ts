import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  DEV_PRINCIPAL_KEY,
  hashShopperCode,
  hashShopperSecret,
  shopperCodeKey,
} from '@commerceworker/core';

/**
 * Pending sign-ins for the device tests to redeem. A code or link works once and the five device
 * projects, and the tests of a spec, run at the same time against one database, so each has a
 * sign-in of its own, by link or by code, written as the engine stores them (hashes only): the link's
 * SHA-256, and the code's HMAC under the key the engine derives from the dev principal key. Nothing
 * here is mailed: the device tests' engine has no Email Sending, which is what the sign-in page's
 * "isn't available" answer is tested against.
 */
export const PROJECTS = [
  'iphone',
  'iphone-landscape',
  'ipad',
  'ipad-landscape',
  'desktop',
] as const;
export const CODE = '424242';

/** The tests that each redeem a link of their own, since the tests of a spec run in parallel too. */
export const LINKS = ['flow', 'signout'] as const;

/** The link token and address a project's link sign-in is seeded under, for one of `LINKS`. */
export const linkSeed = (project: string, which: (typeof LINKS)[number]) => ({
  token: createHash('sha256').update(`e2e-link-${project}-${which}`).digest('hex'),
  email: `${project}-${which}@e2e.test`,
});
/** The address a project's code sign-in is seeded under. */
export const codeSeed = (project: string) => ({ email: `${project}-code@e2e.test` });

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Writes the sign-ins into the device tests' database (`.wrangler/e2e`, as playwright.config.ts names it). */
export async function seedShoppers() {
  const key = await shopperCodeKey(DEV_PRINCIPAL_KEY);
  const now = Date.now();
  const rows: string[] = [];
  for (const p of PROJECTS) {
    const code = codeSeed(p);
    const pending: [string, string, string][] = [
      [
        code.email,
        await hashShopperSecret(`e2e-unused-${p}`),
        await hashShopperCode(key, code.email, CODE),
      ],
    ];
    for (const which of LINKS) {
      const link = linkSeed(p, which);
      pending.push([
        link.email,
        await hashShopperSecret(link.token),
        await hashShopperCode(key, link.email, '111111'),
      ]);
    }
    for (const [email, linkHash, codeHash] of pending)
      rows.push(
        `INSERT OR REPLACE INTO shopper_sign_ins (email, code_hash, link_hash, expires_at, attempts, used_at, created_at, day_started_at, sent_today) VALUES (${q(email)}, ${q(codeHash)}, ${q(linkHash)}, ${now + 6 * 3_600_000}, 0, NULL, ${now - 3_600_000}, ${now - 3_600_000}, 1)`,
      );
  }
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'commerceworker',
      '--local',
      '--persist-to',
      '.wrangler/e2e',
      '--config',
      '../engine/wrangler.jsonc',
      '--command',
      rows.join(';'),
    ],
    { stdio: 'pipe' },
  );
}

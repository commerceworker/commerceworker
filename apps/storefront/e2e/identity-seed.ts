import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashShopperSecret } from '@commerceworker/core';
import { PROJECTS } from './shopper-seed';

/**
 * What the identity-linking device tests need in the engine's database: agentic checkout on (the
 * authorization server answers only then), one registered platform with its return address registered, and per device project a signed-in shopper (a session whose secret the test
 * puts in the cookie) for consenting, and another with a link to the platform to unlink. Written as
 * the engine stores them: hashes only.
 */
/**
 * The flow agentic checkout is set to: an id nothing publishes. UCP is on (the profile and the
 * authorization server answer, which is what identity linking needs) while no flow can price a
 * checkout, so the hosted checkout specs, which expect the device engine to have none, still see
 * "not set up" (hosted checkout falls back to UCP's flow when it names none of its own).
 */
const UNPUBLISHED_FLOW = 'e2e-unpublished-flow';
export const PLATFORM = {
  id: 'ucp_e2e',
  name: 'E2E Shopping Agent',
  profile: 'https://platform.e2e.test/.well-known/ucp',
  redirect: 'https://platform.e2e.test/callback',
};
/** The session secret (what the cookie holds) and address of a project's shopper, for one of `ROLES`. */
export const ROLES = ['consent', 'unlink'] as const;
export const sessionSeed = (project: string, role: (typeof ROLES)[number]) => ({
  secret: createHash('sha256').update(`e2e-session-${project}-${role}`).digest('hex'),
  email: `${project}-${role}@e2e.test`,
});
export const linkId = (project: string) => `lg_e2e_${project}`;

const q = (s: string | number) =>
  typeof s === 'number' ? String(s) : `'${s.replaceAll("'", "''")}'`;

export async function seedIdentity() {
  const now = Date.now();
  const rows = [
    `INSERT OR REPLACE INTO workspace_settings (key, value, updated_at, updated_by) VALUES ('ucp', ${q(JSON.stringify({ checkoutFlowId: UNPUBLISHED_FLOW, links: [], orderUrl: null, productUrl: null }))}, ${now}, 'e2e')`,
    `INSERT OR REPLACE INTO ucp_platforms (id, name, profile_url, key_prefix, key_hash, redirect_uris, created_at) VALUES (${q(PLATFORM.id)}, ${q(PLATFORM.name)}, ${q(PLATFORM.profile)}, 'cmw_ucp_e2e', 'e2e-not-a-real-key-hash', ${q(JSON.stringify([PLATFORM.redirect]))}, ${now})`,
  ];
  for (const p of PROJECTS)
    for (const role of ROLES) {
      const s = sessionSeed(p, role);
      rows.push(
        `INSERT OR REPLACE INTO shopper_sessions (token_hash, email, created_at, expires_at) VALUES (${q(await hashShopperSecret(s.secret))}, ${q(s.email)}, ${now}, ${now + 6 * 3_600_000})`,
      );
      if (role === 'unlink')
        rows.push(
          `INSERT OR REPLACE INTO ucp_link_grants (id, platform_id, email, scope, created_at, expires_at) VALUES (${q(linkId(p))}, ${q(PLATFORM.id)}, ${q(s.email)}, 'dev.ucp.shopping.order:read', ${now}, ${now + 6 * 3_600_000})`,
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

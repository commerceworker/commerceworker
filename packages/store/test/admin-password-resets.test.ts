import { env } from 'cloudflare:workers';
import {
  describeAdminPasswordResetsContract,
  RESET_FIXTURE,
  resetRow,
} from '@commerceworker/test-kit/admin-password-resets-contract';
import { expect, it } from 'vitest';
import { createAdminAuth } from '../src/admin-auth';
import { createAdminPasswordResets } from '../src/admin-password-resets';
import { authDbOf, recoveryCodes, sessions, users } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
async function make() {
  await DB.batch(
    [
      'DELETE FROM password_resets',
      'DELETE FROM sign_in_challenges',
      'DELETE FROM sessions',
      'DELETE FROM recovery_codes',
      'DELETE FROM users',
    ].map((q) => DB.prepare(q)),
  );
  const db = authDbOf(DB);
  for (const user of RESET_FIXTURE.users ?? [])
    await db.insert(users).values({ ...user, createdAt: 1 });
  for (const session of RESET_FIXTURE.sessions ?? []) await db.insert(sessions).values(session);
  for (const code of RESET_FIXTURE.recoveryCodes ?? [])
    await db.insert(recoveryCodes).values({ ...code, createdAt: 1 });
  return { resets: createAdminPasswordResets(DB), auth: createAdminAuth(DB) };
}
describeAdminPasswordResetsContract('D1', make);

it('rolls back the password and revocations together on a failed session deletion', async () => {
  const { resets, auth } = await make();
  await resets.issue(resetRow('own'));
  await auth.startChallenge({
    tokenHash: 'challenge',
    userId: 'pr_ada',
    createdAt: 100,
    expiresAt: 1000,
  });
  await resets.claim('own', 150);
  await DB.prepare(`CREATE TRIGGER reject_reset_session_delete BEFORE DELETE ON sessions
    WHEN OLD.user_id = 'pr_ada' BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`).run();
  try {
    await expect(resets.complete('pr_ada', 'new')).rejects.toThrow();
    expect((await auth.user('pr_ada'))?.passwordHash).toBe('old');
    expect(await auth.session('one')).toBeDefined();
    expect(await auth.challenge('challenge', 150)).toBeDefined();
    const row = await DB.prepare("SELECT used_at FROM password_resets WHERE id = 'own'").first<{
      used_at: number;
    }>();
    expect(row?.used_at).toBe(150);
  } finally {
    await DB.prepare('DROP TRIGGER reject_reset_session_delete').run();
  }
});

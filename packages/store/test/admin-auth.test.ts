import { env } from 'cloudflare:workers';
import { describeAdminAuthContract } from '@commerceworker/test-kit/admin-auth-contract';
import { expect, it } from 'vitest';
import { createAdminAuth } from '../src/admin-auth';
import { authDbOf, recoveryCodes, sessions, users } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
describeAdminAuthContract('D1', async (f) => {
  await DB.batch(
    [
      'DELETE FROM sign_in_challenges',
      'DELETE FROM recovery_codes',
      'DELETE FROM sessions',
      'DELETE FROM users',
      'DELETE FROM auth_failures',
    ].map((sql) => DB.prepare(sql)),
  );
  const db = authDbOf(DB);
  for (const u of f.users ?? []) await db.insert(users).values({ ...u, createdAt: 1 });
  for (const s of f.sessions ?? []) await db.insert(sessions).values(s);
  for (const c of f.recoveryCodes ?? [])
    await db.insert(recoveryCodes).values({ ...c, createdAt: 1 });
  return createAdminAuth(DB);
});

it('rolls back recovery-code replacement if a replacement cannot be inserted', async () => {
  const db = authDbOf(DB);
  await db.insert(users).values({
    id: 'atomic_owner',
    email: 'atomic@example.com',
    name: 'Owner',
    role: 'member',
    createdAt: 1,
  });
  const store = createAdminAuth(DB);
  await store.replaceRecoveryCodes('atomic_owner', ['atomic_old'], 1);
  await expect(
    store.replaceRecoveryCodes('atomic_owner', ['duplicate', 'duplicate'], 2),
  ).rejects.toThrow();
  expect(await store.recoveryCodesLeft('atomic_owner')).toBe(1);
  expect(await store.useRecoveryCode('atomic_owner', 'atomic_old')).toBe(true);
});

it('rolls back disabling TOTP if deleting its recovery codes fails', async () => {
  const db = authDbOf(DB);
  await db.insert(users).values({
    id: 'atomic_disable',
    email: 'disable@example.com',
    name: 'Owner',
    role: 'member',
    createdAt: 1,
  });
  const store = createAdminAuth(DB);
  await store.enableTotp('atomic_disable', 'sealed', 1, 5);
  await store.replaceRecoveryCodes('atomic_disable', ['disable_code'], 1);
  await DB.prepare(`CREATE TRIGGER reject_recovery_delete BEFORE DELETE ON recovery_codes
    WHEN OLD.user_id = 'atomic_disable' BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`).run();
  try {
    await expect(store.disableTotp('atomic_disable')).rejects.toThrow();
    expect(await store.user('atomic_disable')).toMatchObject({
      totpSecret: 'sealed',
      totpEnabledAt: 1,
      totpLastStep: 5,
    });
    expect(await store.recoveryCodesLeft('atomic_disable')).toBe(1);
  } finally {
    await DB.prepare('DROP TRIGGER reject_recovery_delete').run();
  }
});

it('propagates storage errors during identity linking instead of treating them as a lost race', async () => {
  const db = authDbOf(DB);
  await db.insert(users).values({
    id: 'link_failure',
    email: 'link_failure@example.com',
    name: 'Link',
    role: 'member',
    createdAt: 1,
  });
  await DB.prepare(`CREATE TRIGGER reject_identity_link BEFORE UPDATE OF external_sub ON users
    WHEN OLD.id = 'link_failure' BEGIN SELECT RAISE(ABORT, 'injected link failure'); END`).run();
  try {
    await expect(createAdminAuth(DB).linkSub('link_failure', 'subject')).rejects.toThrow();
    expect((await createAdminAuth(DB).user('link_failure'))?.externalSub).toBeNull();
  } finally {
    await DB.prepare('DROP TRIGGER reject_identity_link').run();
  }
});

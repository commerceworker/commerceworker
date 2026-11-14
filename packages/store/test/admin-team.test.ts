import { env } from 'cloudflare:workers';
import {
  ADMIN_TEAM_FIXTURE,
  describeAdminTeamContract,
} from '@commerceworker/test-kit/admin-team-contract';
import { like } from 'drizzle-orm';
import { createAdminTeam } from '../src/admin-team';
import { authDbOf, users } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
describeAdminTeamContract('D1', async () => {
  const db = authDbOf(DB);
  await db.delete(users).where(like(users.id, 'at_%'));
  for (const u of ADMIN_TEAM_FIXTURE) await db.insert(users).values(u);
  return createAdminTeam(DB);
});

import { env } from 'cloudflare:workers';
import { describeCompanyDirectoryContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1CompanyDirectory } from '../src/company-directory';
import { createDb } from '../src/index';
import { companies, companyMembers, companyTeams, customers } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describeCompanyDirectoryContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(companyMembers).where(like(companyMembers.companyId, 'cd_%'));
  await db.delete(companyTeams).where(like(companyTeams.companyId, 'cd_%'));
  await db.delete(companies).where(like(companies.customerId, 'cd_%'));
  await db.delete(customers).where(like(customers.id, 'cd_%'));
  return d1CompanyDirectory(DB);
});

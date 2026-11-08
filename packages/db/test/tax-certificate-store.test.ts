import { env } from 'cloudflare:workers';
import { describeTaxCertificateStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { taxCertificates } from '../src/schema';
import { d1TaxCertificateStore } from '../src/tax-certificate-store';

const DB = (env as unknown as { DB: D1Database }).DB;

describeTaxCertificateStoreContract('D1', async () => {
  await createDb(DB).delete(taxCertificates).where(like(taxCertificates.id, 'tc_%'));
  return d1TaxCertificateStore(DB);
});

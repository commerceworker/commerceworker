import { describeTaxCertificateStoreContract, InMemoryTaxCertificateStore } from '../src/commerce';

describeTaxCertificateStoreContract('in memory', async () => new InMemoryTaxCertificateStore());

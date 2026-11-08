/**
 * The behaviour every `TaxCertificateStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Ids start `tc_`.
 */
import type { TaxCertificate } from '@commerceworker/core';
import type { TaxCertificateStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const cert = (id: string, over: Partial<TaxCertificate> = {}): TaxCertificate => ({
  id,
  customerId: 'tc_cus',
  number: 'RS-1',
  regions: [{ country: 'US', region: 'NY' }] as TaxCertificate['regions'],
  expiresAt: null,
  file: {
    key: `customers/tc_cus/tax-certificates/${id}.pdf`,
    name: 'cert.pdf',
    type: 'application/pdf',
    size: 10,
  },
  status: 'active',
  createdBy: 'Ada',
  createdById: 'usr_ada',
  createdAt: 1,
  verifiedBy: null,
  verifiedAt: null,
  revokedBy: null,
  revokedAt: null,
  ...over,
});

export function describeTaxCertificateStoreContract(
  name: string,
  make: () => Promise<TaxCertificateStore>,
) {
  describe(`${name}: the tax certificate store contract`, () => {
    it("adds certificates once by id, and reads a customer's oldest first", async () => {
      const s = await make();
      expect(await s.add(cert('tc_b', { createdAt: 2 }))).toBe(true);
      expect(await s.add(cert('tc_a', { createdAt: 1, file: null }))).toBe(true);
      expect(await s.add(cert('tc_a', { number: 'other' }))).toBe(false);
      expect(await s.add(cert('tc_x', { customerId: 'tc_other' }))).toBe(true);
      expect((await s.forCustomer('tc_cus')).map((c) => c.id)).toEqual(['tc_a', 'tc_b']);
      expect(await s.count('tc_cus')).toBe(2);
      expect(await s.find('tc_cus', 'tc_b')).toEqual(cert('tc_b', { createdAt: 2 }));
      expect(await s.find('tc_other', 'tc_b')).toBeUndefined();
    });

    it('records verification and revocation, keeping the certificate', async () => {
      const s = await make();
      await s.add(cert('tc_v'));
      await s.verify('tc_cus', 'tc_v', 'Grace', 5);
      expect(await s.find('tc_cus', 'tc_v')).toMatchObject({ verifiedBy: 'Grace', verifiedAt: 5 });
      await s.revoke('tc_cus', 'tc_v', 'Grace', 6);
      expect(await s.find('tc_cus', 'tc_v')).toMatchObject({
        status: 'revoked',
        revokedBy: 'Grace',
        revokedAt: 6,
        verifiedAt: 5,
      });
    });
  });
}

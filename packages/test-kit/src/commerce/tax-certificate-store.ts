/**
 * The tax certificates port in memory. The contract in ./tax-certificate-store-contract.ts holds
 * it to the same behaviour as the D1 store.
 */
import type { TaxCertificate } from '@commerceworker/core';
import type { TaxCertificateStore } from '@commerceworker/ports/commerce';

export class InMemoryTaxCertificateStore implements TaxCertificateStore {
  private readonly rows: TaxCertificate[] = [];

  private one(customerId: string, id: string) {
    return this.rows.find((c) => c.customerId === customerId && c.id === id);
  }

  async forCustomer(customerId: string) {
    return this.rows
      .filter((c) => c.customerId === customerId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => structuredClone(c));
  }

  async find(customerId: string, id: string) {
    const c = this.one(customerId, id);
    return c ? structuredClone(c) : undefined;
  }

  async count(customerId: string) {
    return this.rows.filter((c) => c.customerId === customerId).length;
  }

  async add(c: TaxCertificate) {
    if (this.rows.some((x) => x.id === c.id)) return false;
    this.rows.push(structuredClone(c));
    return true;
  }

  async verify(customerId: string, id: string, by: string, at: number) {
    const c = this.one(customerId, id);
    if (c) Object.assign(c, { verifiedBy: by, verifiedAt: at });
  }

  async revoke(customerId: string, id: string, by: string, at: number) {
    const c = this.one(customerId, id);
    if (c) Object.assign(c, { status: 'revoked', revokedBy: by, revokedAt: at });
  }
}

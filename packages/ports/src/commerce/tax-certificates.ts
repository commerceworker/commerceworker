/**
 * Customers' tax exemption certificates: what staff add, verify and revoke, and what the tax node
 * reads. A certificate is kept once revoked, for the record of which orders it exempted.
 * `d1TaxCertificateStore` (packages/db) and `InMemoryTaxCertificateStore` (packages/test-kit)
 * implement it, held to one contract.
 */
import type { TaxCertificate } from '@commerceworker/core';

export interface TaxCertificateStore {
  /** A customer's certificates, oldest first (the order the tax node picks from). */
  forCustomer(customerId: string): Promise<TaxCertificate[]>;
  /** One of a customer's certificates. */
  find(customerId: string, id: string): Promise<TaxCertificate | undefined>;
  /** How many certificates the customer holds. */
  count(customerId: string): Promise<number>;
  /** Adds a certificate; false (nothing written) when its id is taken. */
  add(certificate: TaxCertificate): Promise<boolean>;
  /** Records who verified it, and when. */
  verify(customerId: string, id: string, by: string, at: number): Promise<void>;
  /** Revokes it, recording who and when. */
  revoke(customerId: string, id: string, by: string, at: number): Promise<void>;
}

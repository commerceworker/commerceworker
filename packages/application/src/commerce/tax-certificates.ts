/**
 * Customers' tax exemption certificates (`tax-exemption.ts` in core): staff add them unverified,
 * someone verifies them against the issuing authority, and a revoked one is kept for the record.
 * With the workspace's approval separation on, whoever added a certificate can't verify it.
 */
import {
  checkTaxCertificateInput,
  MAX_TAX_CERTIFICATES,
  type Refusable,
  type RpcActor,
  type TaxCertificate,
  type TaxCertificateChange,
} from '@commerceworker/core';
import type { PricingStore, TaxCertificateStore } from '@commerceworker/ports/commerce';

export type TaxCertificatePorts = {
  readonly certificates: TaxCertificateStore;
  readonly pricing: Pick<PricingStore, 'customer'>;
};

const refuse = (error: string) => ({ ok: false as const, error });
const done = (certificate: TaxCertificate, changed: boolean) => ({
  ok: true as const,
  value: { certificate, changed },
});

/** A customer's certificates, or null for an id no customer has. */
export async function listTaxCertificates(ports: TaxCertificatePorts, customerId: string) {
  if (!(await ports.pricing.customer(customerId))) return null;
  return ports.certificates.forCustomer(customerId);
}

/**
 * Adds a certificate, unverified. Adding the same id again (a retried request) answers with the
 * one already there rather than a second.
 */
export async function addTaxCertificate(
  ports: TaxCertificatePorts,
  customerId: string,
  raw: unknown,
  actor: RpcActor,
  now: number,
): Promise<Refusable<TaxCertificateChange>> {
  if (!(await ports.pricing.customer(customerId))) return refuse('No such customer.');
  const checked = checkTaxCertificateInput(customerId, raw);
  if (!checked.ok) return checked;
  const c = checked.value;
  const already = await ports.certificates.find(customerId, c.id);
  if (already) return done(already, false);
  if ((await ports.certificates.count(customerId)) >= MAX_TAX_CERTIFICATES)
    return refuse(`A customer holds at most ${MAX_TAX_CERTIFICATES} certificates.`);
  await ports.certificates.add({
    id: c.id,
    customerId,
    number: c.number,
    regions: c.regions,
    expiresAt: c.expiresAt,
    file: c.file ?? null,
    status: 'active',
    createdBy: actor.name,
    createdById: actor.id,
    createdAt: now,
    verifiedBy: null,
    verifiedAt: null,
    revokedBy: null,
    revokedAt: null,
  });
  const added = await ports.certificates.find(customerId, c.id);
  return added ? done(added, true) : refuse('That certificate id is taken.');
}

/**
 * Marks an active, unexpired certificate verified by `actor`. Verifying it again changes nothing.
 * With approval separation on (`separated`), whoever added it can't verify it: the same setting
 * that keeps a person from approving their own order keeps them from vouching for their own entry.
 */
export async function verifyTaxCertificate(
  ports: TaxCertificatePorts,
  customerId: string,
  id: string,
  actor: RpcActor,
  now: number,
  separated: () => Promise<boolean>,
): Promise<Refusable<TaxCertificateChange>> {
  const c = await ports.certificates.find(customerId, id);
  if (!c) return refuse('No such certificate.');
  if (c.status === 'revoked') return refuse('The certificate was revoked; add a new one.');
  if (c.verifiedAt !== null) return done(c, false);
  if (c.expiresAt !== null && now > c.expiresAt)
    return refuse('The certificate has expired; add the renewed one.');
  if (c.createdById === actor.id && (await separated()))
    return refuse('Someone other than whoever added the certificate must verify it.');
  await ports.certificates.verify(customerId, id, actor.name, now);
  return done({ ...c, verifiedBy: actor.name, verifiedAt: now }, true);
}

/** Revokes a certificate, keeping it. Revoking it again changes nothing. */
export async function revokeTaxCertificate(
  ports: TaxCertificatePorts,
  customerId: string,
  id: string,
  actor: RpcActor,
  now: number,
): Promise<Refusable<TaxCertificateChange>> {
  const c = await ports.certificates.find(customerId, id);
  if (!c) return refuse('No such certificate.');
  if (c.status === 'revoked') return done(c, false);
  await ports.certificates.revoke(customerId, id, actor.name, now);
  return done({ ...c, status: 'revoked', revokedBy: actor.name, revokedAt: now }, true);
}

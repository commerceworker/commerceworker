/**
 * Customers' tax exemption certificates (`tax-exemption.ts` in core): what staff add, verify and
 * revoke through `EngineRpc`, and what `commerce.tax` reads inside its step. The certificate
 * use-cases (@commerceworker/application/commerce) bound to this deployment's stores. The web app
 * stores a certificate's file before adding it; erasing the customer deletes both (`subjects.ts`).
 */
import * as uc from '@commerceworker/application/commerce';
import { APPROVAL_SEPARATION_KEY, type RpcActor, type TaxCertificate } from '@commerceworker/core';
import { pricingStore, taxCertificateStore, workspaceStore } from './wire';

const ports = (env: Env): uc.TaxCertificatePorts => ({
  certificates: taxCertificateStore(env),
  pricing: pricingStore(env),
});

/**
 * A customer's certificates, oldest first (the order `exemptingCertificate` picks from, so a
 * replayed step picks the same one). Empty for no customer.
 */
export async function customerTaxCertificates(
  env: Env,
  customerId: string | undefined,
): Promise<TaxCertificate[]> {
  return customerId ? taxCertificateStore(env).forCustomer(customerId) : [];
}

/** As `EngineRpc.taxCertificates`: null for an id no customer has. */
export const listTaxCertificates = (env: Env, customerId: string) =>
  uc.listTaxCertificates(ports(env), customerId);

export const addTaxCertificate = (
  env: Env,
  customerId: string,
  raw: unknown,
  actor: RpcActor,
  now = Date.now(),
) => uc.addTaxCertificate(ports(env), customerId, raw, actor, now);

export const verifyTaxCertificate = (
  env: Env,
  customerId: string,
  id: string,
  actor: RpcActor,
  now = Date.now(),
) => uc.verifyTaxCertificate(ports(env), customerId, id, actor, now, () => separated(env));

export const revokeTaxCertificate = (
  env: Env,
  customerId: string,
  id: string,
  actor: RpcActor,
  now = Date.now(),
) => uc.revokeTaxCertificate(ports(env), customerId, id, actor, now);

/** The workspace's `approval_separation` setting is on. */
export async function separated(env: Env) {
  return (await workspaceStore(env).setting(APPROVAL_SEPARATION_KEY)) === 'on';
}

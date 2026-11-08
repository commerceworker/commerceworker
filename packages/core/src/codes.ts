/**
 * Codes people read off a screen or a receipt, derived from the id they belong to so a retried
 * step produces the same code. Not secrets: a pickup still checks the order, an entitlement its
 * owner.
 */

/** A 32-bit string hash (Java's), stable across runtimes. */
export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** The six-character code a customer gives at the counter to collect a pickup. */
export const pickupCode = (shipmentId: string) =>
  Math.abs(stringHash(shipmentId)).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);

/** A digital good's code: the SKU and eight characters derived from the entitlement's id. */
export function entitlementCode(sku: string, entitlementId: string) {
  const h = Math.abs(stringHash(entitlementId)).toString(36).toUpperCase().padStart(8, '0');
  return `${sku}-${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

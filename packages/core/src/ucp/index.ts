/**
 * The Universal Commerce Protocol (https://ucp.dev), version `UCP_VERSION`: the business side of
 * discovery, checkout, fulfillment and orders, mapped onto the protocol-neutral checkout
 * (../checkout.ts) and CommerceWorker's orders. Pure; the engine serves it (apps/engine/src/ucp/) and
 * the storefront Worker fronts it (apps/storefront/app/lib/ucp.server.ts).
 */

export * from './catalog';
export * from './checkout';
export * from './discount';
export * from './errors';
export * from './identity-linking';
export * from './order';
export * from './profile';
export * from './signature';
export * from './structured';

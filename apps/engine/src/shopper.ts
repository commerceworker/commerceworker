/**
 * The engine's side of a storefront shopper's sign-in: the shopper use-cases
 * (@commerceworker/application/commerce) bound to this deployment's D1 and Email Sending, and the
 * check on who is asking. The storefront reaches it only through `StorefrontApi`. It is public, so
 * the engine believes it only for a guest actor signed under the storefront key for `shopper`, and
 * names a signed-in shopper only by the SHA-256 of the cookie's secret: it hashes what it is given,
 * so a stored hash presented as a secret finds nothing, and a leaked table holds no credential.
 */
import * as uc from '@commerceworker/application/commerce';
import {
  hashShopperSecret,
  type OrderState,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  SHOPPER_SECRET,
  type SignedActor,
  shopperCodeKey,
} from '@commerceworker/core';
import { orderAgent } from './namespaces';
import { confirmations, sender } from './order-confirmation';
import { guestActor } from './principal';
import { addressBook, orderQueries, orderRecords, shopperAuth } from './wire';

/** Whether `signed` is the storefront speaking for a shopper call (the one thing it may say). */
async function fromStorefront(env: Env, signed: SignedActor): Promise<boolean> {
  const actor = await guestActor(env, signed, SHOPPER_CALL);
  return actor?.id === SHOPPER_GUEST_ID;
}

const ports = async (env: Env) => {
  // Unreachable without it: `fromStorefront` has verified an envelope under a key derived from it.
  if (!env.PRINCIPAL_KEY) throw new Error('PRINCIPAL_KEY is not set');
  return { shoppers: shopperAuth(env), codeKey: await shopperCodeKey(env.PRINCIPAL_KEY) };
};

export async function startShopperSignIn(env: Env, email: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return { status: 'invalid' as const };
  return uc.startShopperSignIn(
    { ...(await ports(env)), email: sender(env), storefrontOrigin: env.STOREFRONT_ORIGIN },
    email,
    Date.now(),
  );
}

export async function redeemShopperCode(
  env: Env,
  email: unknown,
  code: unknown,
  signed: SignedActor,
) {
  if (!(await fromStorefront(env, signed))) return null;
  return uc.redeemShopperCode(await ports(env), email, code, Date.now());
}

export async function redeemShopperLink(env: Env, token: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return null;
  return uc.redeemShopperLink(await ports(env), token, Date.now());
}

export async function shopperLinkPreview(env: Env, token: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return null;
  return uc.shopperLinkPreview(await ports(env), token, Date.now());
}

/** The hash a cookie's secret is stored under, or null for anything the engine didn't mint. */
const hashOf = (secret: unknown) =>
  typeof secret === 'string' && SHOPPER_SECRET.test(secret) ? hashShopperSecret(secret) : null;

export async function shopperOf(env: Env, secret: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return null;
  const hash = await hashOf(secret);
  return hash ? uc.shopperSession(await ports(env), hash, Date.now()) : null;
}

export async function shopperSignOut(env: Env, secret: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return;
  const hash = await hashOf(secret);
  if (hash) await uc.shopperSignOut(await ports(env), hash);
}

/**
 * What the account calls read, bound to this deployment: the order index and address book by the
 * session's email, an order as its buyer sees it, and an order's recorded ship-to from its agent
 * (an id nothing started is not woken as an agent of its own).
 */
const accountPorts = (env: Env) => ({
  shoppers: shopperAuth(env),
  orders: orderQueries(env),
  addresses: addressBook(env),
  views: confirmations(env),
  shipTos: {
    async read(orderId: string) {
      if (!(await orderRecords(env).exists(orderId))) return null;
      return (
        ((await orderAgent(env, orderId).snapshot()) as OrderState).order?.meta?.shipTo ?? null
      );
    },
  },
});

export async function shopperOrders(
  env: Env,
  secret: unknown,
  cursor: unknown,
  signed: SignedActor,
) {
  if (!(await fromStorefront(env, signed))) return null;
  const hash = await hashOf(secret);
  return hash ? uc.shopperOrders(accountPorts(env), hash, cursor, Date.now()) : null;
}

export async function shopperOrder(env: Env, secret: unknown, id: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return null;
  const hash = await hashOf(secret);
  return hash ? uc.shopperOrder(accountPorts(env), hash, id, Date.now()) : null;
}

export async function shopperAddresses(env: Env, secret: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return null;
  const hash = await hashOf(secret);
  return hash ? uc.shopperAddresses(accountPorts(env), hash, Date.now()) : null;
}

export async function forgetAddress(env: Env, secret: unknown, id: unknown, signed: SignedActor) {
  if (!(await fromStorefront(env, signed))) return false;
  const hash = await hashOf(secret);
  return hash ? uc.forgetShopperAddress(accountPorts(env), hash, id, Date.now()) : false;
}

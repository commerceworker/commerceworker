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
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  SHOPPER_SECRET,
  type SignedActor,
  shopperCodeKey,
} from '@commerceworker/core';
import { sender } from './order-confirmation';
import { guestActor } from './principal';
import { shopperAuth } from './wire';

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

/**
 * The engine's side of UCP identity linking: the link use-cases (@commerceworker/application/commerce)
 * bound to this deployment's D1, and what the storefront and the UCP surface ask of them. The
 * storefront hosts the authorization server's pages and endpoints and reaches this only through
 * `StorefrontApi`, so it never holds a code, a token or a link: the consent is the shopper's, shown
 * with their session (the engine's own, by the SHA-256 of the cookie's secret, beside an actor the
 * storefront signed for `shopper`), and the token endpoint takes the platform's API key hash and
 * looks it up here. A linked token speaks for a shopper only at `/ucp`, beside the signed platform
 * envelope, and only for the platform it was issued to.
 */
import * as uc from '@commerceworker/application/commerce';
import {
  authorizationServerMetadata,
  LINK_ORDER_READ,
  type LinkAuthorizeView,
  type LinkDecision,
  type LinkRefusal,
  type LinkTokenResult,
  type SignedActor,
} from '@commerceworker/core';
import { shopperOf } from '../shopper';
import { emailSender, ucpLinks, ucpStore } from '../wire';
import { ucpSettings } from './config';

const ports = (env: Env): uc.LinkPorts => ({
  links: ucpLinks(env),
  platforms: ucpStore(env),
  issuer: env.STOREFRONT_ORIGIN.replace(/\/+$/, ''),
});

/**
 * Whether the authorization server answers: while agentic checkout is on, as `/ucp` is, and only
 * where a shopper can sign in (Email Sending is set up), as the business profile lists the
 * capability: a consent page that can't sign anyone in would only fail.
 */
const on = async (env: Env) => !!emailSender(env) && !!(await ucpSettings(env)).checkoutFlowId;

/** The `{ id, keyHash }` a platform presented, as strings or null; RPC arguments are never trusted for shape. */
const clientOf = (client: { id: string | null; keyHash: string | null } | null | undefined) => ({
  id: typeof client?.id === 'string' ? client.id : null,
  keyHash:
    typeof client?.keyHash === 'string' && /^[0-9a-f]{64}$/.test(client.keyHash)
      ? client.keyHash
      : null,
});

/** The parameters as strings only: anything else an RPC caller sends is dropped. */
const paramsOf = (raw: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );

const off = (): LinkTokenResult => ({
  status: 404,
  body: { error: 'invalid_request', error_description: 'Identity linking is not on here.' },
});

export async function linkMetadata(env: Env) {
  return (await on(env)) ? authorizationServerMetadata(ports(env).issuer) : null;
}

/** The shopper whose session `secret` is, when `signed` is the storefront speaking for one. */
async function emailOf(env: Env, secret: string | null, signed: SignedActor) {
  // The storefront's word is checked even with no cookie: an unsigned caller learns nothing.
  const who = await shopperOf(env, secret ?? '', signed);
  return who?.email ?? null;
}

const refusedOff: LinkRefusal = {
  status: 'refused',
  error: 'invalid_request',
  description: 'Identity linking is not on here.',
  redirect: null,
};

export async function linkAuthorize(
  env: Env,
  params: unknown,
  secret: string | null,
  signed: SignedActor,
): Promise<LinkAuthorizeView> {
  if (!(await on(env))) return refusedOff;
  // Not signed by the storefront: nothing, the same as no one signed in would show, but no consent.
  const email = await emailOf(env, secret, signed);
  return uc.describeLink(ports(env), paramsOf(params), email);
}

export async function linkDecide(
  env: Env,
  params: unknown,
  approve: boolean,
  secret: string | null,
  signed: SignedActor,
): Promise<LinkDecision> {
  if (!(await on(env))) return refusedOff;
  const email = await emailOf(env, secret, signed);
  return uc.decideLink(ports(env), paramsOf(params), approve === true, email, Date.now());
}

export async function linkToken(env: Env, form: unknown, client: unknown) {
  if (!(await on(env))) return off();
  return uc.linkToken(ports(env), paramsOf(form), clientOf(client as never), Date.now());
}

export async function linkRevoke(env: Env, form: unknown, client: unknown) {
  if (!(await on(env))) return off();
  return uc.revokeLinkToken(ports(env), paramsOf(form), clientOf(client as never), Date.now());
}

export async function linksOf(env: Env, secret: string, signed: SignedActor) {
  const email = await emailOf(env, secret, signed);
  return email ? { email, links: await uc.shopperLinks(ports(env), email, Date.now()) } : null;
}

export async function unlink(
  env: Env,
  secret: string,
  linkId: string,
  signed: SignedActor,
): Promise<boolean> {
  const email = await emailOf(env, secret, signed);
  if (!email || typeof linkId !== 'string') return false;
  return uc.unlinkShopper(ports(env), email, linkId, Date.now());
}

/**
 * The shopper a platform's access token speaks for at `/ucp`, or null: the token must be live,
 * issued to this platform and carry `order:read`.
 */
export const linkedShopperFor = (env: Env, token: unknown, platformId: string) =>
  uc.linkedShopper(ports(env), token, platformId, LINK_ORDER_READ, Date.now());

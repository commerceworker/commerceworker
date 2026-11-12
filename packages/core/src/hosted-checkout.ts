/**
 * The hosted checkout's trust model, pure: how a session is owned, what a buyer's page may change
 * and what it sees. A hosted session is created through the API (`create_checkout`), which makes a
 * one-time start link; redeeming it (on the storefront, `StorefrontRpc.redeemCheckoutStart`) trades
 * the link's token for a cookie secret the engine mints. The engine stores only SHA-256 hashes: the
 * session is owned by `hosted-start:<hash of the token>` until it is redeemed, then by
 * `hosted:<hash of the cookie secret>`, so a used link opens nothing and a cookie is never a link.
 * Every later call presents the cookie's secret (the storefront carries it, from the cookie, and
 * never stores it) with a guest actor it signed for `checkout:<id>`: the key alone mints no buyer,
 * and the cookie alone reaches no engine. The engine hashes the secret to compare it, so a stored
 * owner, which is only a hash, can't be presented as a credential.
 */

import { z } from 'zod';
import { MAX_SHIPPING_OPTION_ID, shipToSchema } from './cart';
import {
  CHECKOUT_TTL_MS,
  type CheckoutSession,
  MAX_CHECKOUT_LINES,
  MAX_LINE_QUANTITY,
} from './checkout';

export const HOSTED_OWNER_PREFIX = 'hosted:';
export const HOSTED_START_PREFIX = 'hosted-start:';

/** What a hosted session lives for: the checkout's own time. */
export const HOSTED_TTL_MS = CHECKOUT_TTL_MS;

/** SHA-256 as lowercase hex, the form every hash here takes. */
export const HOSTED_HASH = /^[0-9a-f]{64}$/;

/** A cookie secret as the engine mints one: 32 random bytes as hex. */
export const HOSTED_SECRET = /^[0-9a-f]{64}$/;

export async function hostedHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The owner of a redeemed session: the hash of its cookie's secret. */
export const hostedOwner = (cookieHash: string) => `${HOSTED_OWNER_PREFIX}${cookieHash}`;

/** The owner of a session whose start link is unused: the hash of the link's token. */
export const hostedStartOwner = (tokenHash: string) => `${HOSTED_START_PREFIX}${tokenHash}`;

/** What a guest actor of a hosted call is signed for (`signGuestActor`'s `call`). */
export const hostedCall = (checkoutId: string) => `checkout:${checkoutId}`;

/** The id of the buyer a hosted call acts as; the engine holds the actor to it. */
export const hostedGuestId = (checkoutId: string) => `guest:checkout:${checkoutId}`;

/** A session id as the engine mints it (`newId('chk')`): no separators, bounded. */
export const HOSTED_ID = /^chk_[A-Za-z0-9_-]{1,64}$/;

/** The start link's path on the storefront. */
export const hostedStartPath = (id: string, token: string) => `/checkout/start/${id}/${token}`;

/** The longest each field of a buyer's page may be, and the most codes: the page and the schemas below share them. */
export const HOSTED_LIMITS = {
  email: 254,
  name: 100,
  phone: 40,
  promoCode: 60,
  promoCodes: 10,
} as const;

/** Who is buying, as the merchant's call or the buyer's page gives it. */
export const hostedBuyerSchema = z
  .object({
    email: z.string().trim().email().max(HOSTED_LIMITS.email).optional(),
    firstName: z.string().trim().max(HOSTED_LIMITS.name).optional(),
    lastName: z.string().trim().max(HOSTED_LIMITS.name).optional(),
    phone: z.string().trim().max(HOSTED_LIMITS.phone).optional(),
  })
  .strict();

/** Everything a buyer's page may ask to change; there is no price field to set. */
const hostedPatchFields = {
  buyer: hostedBuyerSchema,
  shipTo: shipToSchema.strict().nullable(),
  shippingOption: z.string().max(MAX_SHIPPING_OPTION_ID).nullable(),
  fulfillment: z.enum(['ship', 'pickup']),
  pickupLocationId: z.string().min(1).max(100).nullable(),
  promoCodes: z
    .array(z.string().trim().min(1).max(HOSTED_LIMITS.promoCode))
    .max(HOSTED_LIMITS.promoCodes),
} as const;

/** A buyer's change of a session (`CheckoutPatch` without lines, strict: an unknown key is refused). */
export const hostedPatchSchema = z.object(hostedPatchFields).partial().strict();

/** The same, with lines (a merchant setting turns it on); a line is a SKU and a quantity, never a price. */
export const hostedPatchWithLinesSchema = z
  .object({
    ...hostedPatchFields,
    lines: z
      .array(
        z
          .object({
            id: z.string().max(40).optional(),
            sku: z.string().min(1).max(100),
            qty: z.number().int().min(1).max(MAX_LINE_QUANTITY),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CHECKOUT_LINES),
  })
  .partial()
  .strict();

export type HostedPatch = z.infer<typeof hostedPatchWithLinesSchema>;

/**
 * A session as its buyer's page sees it: what they are buying and paying, their own details and
 * what is still missing. Listed field by field, so a field added to the session later (the
 * customer it is for, a payment's ids, the owner) reaches no buyer until someone decides it should.
 */
export type HostedCheckout = Pick<
  CheckoutSession,
  | 'id'
  | 'status'
  | 'currency'
  | 'buyer'
  | 'fulfillment'
  | 'shipTo'
  | 'shippingOption'
  | 'pickupLocationId'
  | 'pickupStores'
  | 'promoCodes'
  | 'quote'
  | 'issues'
  | 'orderId'
  | 'expiresAt'
  | 'version'
> & {
  lines: Pick<
    CheckoutSession['lines'][number],
    'id' | 'sku' | 'qty' | 'title' | 'unitPrice' | 'listPrice'
  >[];
};

export const hostedView = (s: CheckoutSession): HostedCheckout =>
  structuredClone({
    id: s.id,
    status: s.status,
    currency: s.currency,
    lines: s.lines.map(({ id, sku, qty, title, unitPrice, listPrice }) => ({
      id,
      sku,
      qty,
      title,
      unitPrice,
      listPrice,
    })),
    buyer: s.buyer,
    fulfillment: s.fulfillment,
    shipTo: s.shipTo,
    shippingOption: s.shippingOption,
    pickupLocationId: s.pickupLocationId,
    pickupStores: s.pickupStores,
    promoCodes: s.promoCodes,
    quote: s.quote,
    issues: s.issues,
    orderId: s.orderId,
    expiresAt: s.expiresAt,
    version: s.version,
  });

/**
 * The answer to a buyer's change: the session as it is now, or why it wasn't made. `changed` is set
 * when the session moved under the request (the page showed an older version, or another write won
 * the race): the page says so and shows `checkout`, the session as it is.
 */
export type HostedChange =
  | { ok: true; checkout: HostedCheckout }
  | { ok: false; error: string; checkout?: HostedCheckout; changed?: true };

/**
 * The answer to a buyer's card payment: as `HostedChange`, or (`authenticate`) the bank wants the
 * buyer to confirm first: the browser runs Stripe.js's `handleNextAction` with `clientSecret`, then
 * asks the engine to confirm. The session stays claimed, with the hold recorded, until it does.
 */
export type HostedPayment =
  | HostedChange
  | { ok: true; checkout: HostedCheckout; authenticate: { clientSecret: string } };

/** What a buyer's page sends to pay by card: the Stripe confirmation token it made, and what it showed. */
export type HostedPayInput = { version: number; total: number; confirmationToken: string };

/** A Stripe confirmation token as Stripe.js makes one. */
export const HOSTED_CONFIRMATION_TOKEN = /^ctoken_[A-Za-z0-9_]{6,200}$/;

/** The most card payments one hosted session takes: a cap against card testing on a stolen link. */
export const HOSTED_PAY_ATTEMPTS = 5;

/**
 * What the storefront may know of the settings: whether hosted checkout is on, what a buyer may
 * edit, the merchant's store name, whether payments are only recorded (`testPayments`: PAYMENTS_MODE "mock"), where the page
 * offers a test order and no card, and (`publishableKey`) the Stripe publishable key the page
 * takes a card with: set only when payments are live and a key is configured, so the page offers
 * a card exactly when the engine can take one.
 */
export type HostedCheckoutSettings = {
  /** The merchant's name for buyer pages, or null when none is set. */
  storeName: string | null;
  checkout: {
    enabled: boolean;
    editLines: boolean;
    testPayments: boolean;
    publishableKey: string | null;
  };
};

/**
 * What this deployment offers over UCP: the settings an admin chose (`workspace_settings`), the
 * key it signs webhooks with (`UCP_SIGNING_KEY`), and the payment handlers it accepts. The
 * business profile at `/.well-known/ucp` is built from them.
 *
 * Payment handlers:
 *
 * - `com.commerceworker.stripe` (PAYMENTS_MODE "stripe", with `STRIPE_PUBLISHABLE_KEY`): the platform
 *   tokenizes the buyer's card with Stripe under the publishable key in `config` and sends the
 *   PaymentMethod (`{ type: "stripe_payment_method", token: "pm_…" }`). Completing the checkout
 *   authorizes it with manual capture, and the checkout flow's authorize node adopts that hold.
 * - `com.commerceworker.test` (PAYMENTS_MODE "mock" only): any token is accepted except
 *   `tok_test_decline`, and payments are recorded, not taken. For trying a platform end to end.
 */

import {
  BASE_CURRENCY,
  businessProfile,
  type EcJwk,
  importSigningKey,
  publicJwk,
  readUcpSettings,
  UCP_SETTINGS_KEY,
  UCP_VERSION,
  type UcpPaymentHandler,
  type UcpPublicKey,
  type UcpSettings,
} from '@commerceworker/core';
import { stripeMode } from '../gateway';
import { emailSender, workspaceStore } from '../wire';

export const STRIPE_HANDLER = 'com.commerceworker.stripe';
export const TEST_HANDLER = 'com.commerceworker.test';
const HANDLER_SPEC = 'https://docs.commerceworker.com/reference/ucp/#payment-handlers';

/** The currency checkouts are priced in. */
export const CHECKOUT_CURRENCY = BASE_CURRENCY;

export async function ucpSettings(env: Env): Promise<UcpSettings> {
  return readUcpSettings(await workspaceStore(env).setting(UCP_SETTINGS_KEY));
}

/** The payment handlers checkouts offer, by the id an instrument names. */
export function paymentHandlers(env: Env): UcpPaymentHandler[] {
  if (!stripeMode(env))
    return [
      {
        name: TEST_HANDLER,
        id: 'test',
        version: UCP_VERSION,
        spec: HANDLER_SPEC,
        schema: 'https://commerceworker.com/ucp/handlers/test.json',
        available_instruments: [{ type: 'card' }],
        config: { environment: 'test' },
      },
    ];
  if (!env.STRIPE_PUBLISHABLE_KEY) return [];
  return [
    {
      name: STRIPE_HANDLER,
      id: 'stripe',
      version: UCP_VERSION,
      spec: HANDLER_SPEC,
      schema: 'https://commerceworker.com/ucp/handlers/stripe.json',
      available_instruments: [{ type: 'card' }],
      config: {
        publishable_key: env.STRIPE_PUBLISHABLE_KEY,
        credential_type: 'stripe_payment_method',
      },
    },
  ];
}

type SigningKey = {
  kid: string;
  key: Awaited<ReturnType<typeof importSigningKey>>;
  public: UcpPublicKey;
};
const keys = new Map<string, Promise<SigningKey | null>>();

/**
 * The webhook signing key: `UCP_SIGNING_KEY` is a private P-256 JWK with a `kid`. Without one the
 * profile publishes no keys and order webhooks aren't sent (UCP requires them signed).
 */
export function signingKey(env: Env): Promise<SigningKey | null> {
  const raw = env.UCP_SIGNING_KEY;
  if (!raw) return Promise.resolve(null);
  let key = keys.get(raw);
  if (!key) {
    key = (async () => {
      try {
        const jwk = JSON.parse(raw) as EcJwk;
        if (!jwk.kid || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('shape');
        return { kid: jwk.kid, key: await importSigningKey(jwk), public: publicJwk(jwk) };
      } catch {
        console.error('UCP_SIGNING_KEY is not a private P-256 JWK with a kid');
        return null;
      }
    })();
    keys.set(raw, key);
  }
  return key;
}

/**
 * The business profile for `origin`, or null while agentic checkout is off. It lists identity
 * linking only where a shopper can sign in (Email Sending is set up): a platform sent to a consent
 * page that can't sign anyone in would only fail.
 */
export async function ucpProfile(env: Env, origin: string) {
  const settings = await ucpSettings(env);
  if (!settings.checkoutFlowId) return null;
  const key = await signingKey(env);
  return businessProfile(origin, paymentHandlers(env), key ? [key.public] : [], !!emailSender(env));
}

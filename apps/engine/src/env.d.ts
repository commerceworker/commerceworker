// Secrets set with `wrangler secret put`; `wrangler types` can't see them.
interface Env {
  /**
   * Cloudflare Email Sending (a `send_email` binding), added per deployment by scripts/fleet.ts
   * when the registry sets `email`; unbound, no email is sent. Mail goes from `EMAIL_FROM`.
   */
  EMAIL?: SendEmail;
  /** The mail queue's producer, added by scripts/fleet.ts with `redundancy` and an `email` sender; unbound, mail is sent inline. */
  EMAIL_QUEUE?: Queue;
  /** A second Email Sending binding, on another onboarded domain (`email.fallbackFrom`): sends from EMAIL_FALLBACK_FROM when EMAIL's sender is refused as unverified or Email Sending fails. */
  EMAIL_FALLBACK?: SendEmail;
  /** Extra senders allowed to start orders by email: addresses or @domains, comma-separated. */
  INTAKE_ALLOWLIST?: string;
  /** Live shipping carriers' credentials: JSON of carrier id → Authorization header value. */
  SHIPPING_CARRIER_AUTH?: string;
  /** Stripe secret or restricted key (sk_… / rk_…); required when PAYMENTS_MODE is "stripe". */
  STRIPE_SECRET_KEY?: string;
  /** The text Apple Pay's domain verification fetches from the storefront; a secret only for where it is kept. */
  APPLE_PAY_DOMAIN_ASSOCIATION?: string;
  /** Shared with the web Worker: signs the principal header on every forwarded request. */
  PRINCIPAL_KEY?: string;
  /** The key before a rotation, still accepted until the web Worker signs with the new one. */
  PRINCIPAL_KEY_PREVIOUS?: string;
  /** Shared with the web Worker: encrypts secrets at rest (@commerceworker/core encryptSecret). */
  DATA_KEY?: string;
  /** The key before a rotation, still read until the daily sweep has resealed everything. */
  DATA_KEY_PREVIOUS?: string;
  /** Signs UCP order webhooks: a private P-256 JWK with a `kid`, published in /.well-known/ucp. */
  UCP_SIGNING_KEY?: string;
}

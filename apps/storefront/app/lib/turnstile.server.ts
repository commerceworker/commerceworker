/**
 * Cloudflare Turnstile on the forms on the storefront worth a bot's while: Pay on a hosted
 * checkout, where each press can try a card, and a shopper's request for a sign-in code, which makes
 * the deployment send mail. The check is the admin's (`checkTurnstileForm`,
 * @commerceworker/security/turnstile) with this Worker's own site key and secret: the registry's
 * `turnstileSiteKey` renders `TURNSTILE_SITE_KEY` and the widget's secret is `TURNSTILE_SECRET_KEY`
 * (the deploy refuses a key without it). Without a site key nothing changes: local development,
 * tests and demos. A token solved on the admin's sign-in page is refused here: Siteverify must see
 * the `checkout_pay` action and this host, and one from the card form is refused on the sign-in form.
 */

import { env } from 'cloudflare:workers';
import { TURNSTILE_HEADER } from '@commerceworker/security/csp';
import { checkTurnstileForm } from '@commerceworker/security/turnstile';

const config = () => env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };

/** The site key the payment form renders its widget with, or null when this deployment has none. */
export const turnstileSiteKey = () => config().TURNSTILE_SITE_KEY || null;

/** The Pay form's check: null when it passed or there is no Turnstile, else what to tell the buyer. */
export const checkPayTurnstile = (request: Request, form: FormData, fetcher?: typeof fetch) =>
  checkTurnstileForm(
    {
      siteKey: turnstileSiteKey(),
      secret: config().TURNSTILE_SECRET_KEY,
      request,
      form,
      action: 'checkout_pay',
      unavailable: 'Card payment is unavailable right now. Contact the business to pay.',
    },
    fetcher,
  );

/** The sign-in form's check, as the Pay form's: its own action, so neither form's token opens the other. */
export const checkSignInTurnstile = (request: Request, form: FormData, fetcher?: typeof fetch) =>
  checkTurnstileForm(
    {
      siteKey: turnstileSiteKey(),
      secret: config().TURNSTILE_SECRET_KEY,
      request,
      form,
      action: 'shop_sign_in',
      unavailable: 'Signing in is unavailable right now. Try again later.',
    },
    fetcher,
  );

/**
 * A route's response headers, marked so `entry.server.tsx` lets this page load Turnstile's script
 * and frame when the deployment uses it. No other page's policy does.
 */
export function withTurnstilePolicy(headers: Headers): Headers {
  if (!turnstileSiteKey()) return headers;
  const out = new Headers(headers);
  out.set(TURNSTILE_HEADER, '1');
  return out;
}

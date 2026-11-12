/**
 * Cloudflare Turnstile on the one form on the storefront worth a bot's while: Pay on a hosted
 * checkout, where each press can try a card. The check is the admin's (`checkTurnstileForm`,
 * @commerceworker/security/turnstile) with this Worker's own site key and secret: the registry's
 * `turnstileSiteKey` renders `TURNSTILE_SITE_KEY` and the widget's secret is `TURNSTILE_SECRET_KEY`
 * (the deploy refuses a key without it). Without a site key nothing changes: local development,
 * tests and demos. A token solved on the admin's sign-in page is refused here: Siteverify must see
 * the `checkout_pay` action and this host.
 */

import { env } from 'cloudflare:workers';
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

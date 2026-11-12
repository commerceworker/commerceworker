/**
 * Cloudflare Turnstile on the two forms an anonymous caller can post a secret to: password sign-in
 * (`/login`) and the setup code (`/setup`). Bots stuffing passwords, or racing a new deployment's
 * first admin, need a fresh challenge token for every attempt; the token is checked here with
 * Siteverify before the password or code is looked at, so a refused attempt costs no hash and
 * counts toward no one's throttle.
 *
 * Optional per deployment: the registry's `turnstileSiteKey` renders `TURNSTILE_SITE_KEY`, and the
 * widget's secret is the `TURNSTILE_SECRET_KEY` secret (the deploy refuses a key without it).
 * Without a site key nothing changes: local development, tests and the demo's one-click sign-in.
 * Passkeys and single sign-on aren't gated (they can't be stuffed), nor is the two-factor step,
 * which only a password that passed this check can reach.
 */

import { env } from 'cloudflare:workers';
import { TURNSTILE_HEADER } from '@commerceworker/security/csp';
import { checkTurnstileForm } from '@commerceworker/security/turnstile';

export { siteverify, TOKEN_FIELD, type TurnstileAction } from '@commerceworker/security/turnstile';

const config = () => env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };

/** The site key the forms render their widget with, or null when this deployment has none. */
export const turnstileSiteKey = () => config().TURNSTILE_SITE_KEY || null;

/**
 * A route's response headers, marked so `entry.server.tsx` lets this page load Turnstile's script
 * and frame (`contentSecurityPolicy`) when the deployment uses it. No other page's policy does.
 */
export function withTurnstilePolicy(headers: Headers): Headers {
  if (!turnstileSiteKey()) return headers;
  const out = new Headers(headers);
  out.set(TURNSTILE_HEADER, '1');
  return out;
}

export type { SiteverifyResult, TurnstileRefusal } from '@commerceworker/security/turnstile';

/**
 * The form's Turnstile check: null when it passed or the deployment has no Turnstile, else what to
 * tell the person. A site key without its secret refuses everything (and says so in the log), so
 * a misconfigured deployment never quietly drops the check.
 */
export function checkTurnstile(
  request: Request,
  form: FormData,
  action: 'login' | 'setup',
  fetcher: typeof fetch = fetch,
) {
  return checkTurnstileForm(
    {
      siteKey: turnstileSiteKey(),
      secret: config().TURNSTILE_SECRET_KEY,
      request,
      form,
      action,
      unavailable: `${action === 'login' ? 'Signing in with a password' : 'Setting up'} is unavailable right now. Tell whoever runs this workspace.`,
    },
    fetcher,
  );
}

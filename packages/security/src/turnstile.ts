/**
 * Cloudflare Turnstile's server side, shared by the Workers that gate a form with it (the admin's
 * sign-in and setup, the storefront's card payment and its request for a shopper's sign-in code): Siteverify, and what a form's refusal says.
 * Each Worker names its own site key, secret and widget action; this checks the token the widget
 * wrote into the form, with Siteverify, before anything else the form does.
 */

/** What each form's widget says it protects; Siteverify must echo it back. */
export type TurnstileAction = 'login' | 'setup' | 'checkout_pay' | 'shop_sign_in';

/** The form field the widget fills with its token. */
export const TOKEN_FIELD = 'cf-turnstile-response';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Siteverify's own limit; anything longer isn't a token. */
const MAX_TOKEN = 2048;

export type SiteverifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Asks Siteverify about `token`, and accepts it only if it passed, for this `action`, on this
 * `hostname`: a token solved on another deployment's page (one widget's domains include their
 * subdomains) or for the other form is refused. Fails closed: no answer, an error status or a body
 * that isn't Siteverify's is a refusal.
 */
export async function siteverify(
  input: {
    secret: string;
    token: string;
    remoteip?: string;
    action: TurnstileAction;
    hostname: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<SiteverifyResult> {
  if (!input.token || input.token.length > MAX_TOKEN) return { ok: false, reason: 'no-token' };
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteip) body.set('remoteip', input.remoteip);
  let result: { success?: unknown; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
  try {
    const res = await fetcher(SITEVERIFY, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `siteverify-${res.status}` };
    result = await res.json();
  } catch {
    return { ok: false, reason: 'siteverify-unreachable' };
  }
  if (result?.success !== true) {
    const codes = Array.isArray(result?.['error-codes']) ? result['error-codes'].join(',') : '';
    return { ok: false, reason: `failed${codes ? `:${codes}` : ''}` };
  }
  if (result.hostname !== input.hostname) return { ok: false, reason: 'wrong-hostname' };
  if (result.action !== input.action) return { ok: false, reason: 'wrong-action' };
  return { ok: true };
}

/** Why a form was refused, for the page: the message, and the status it answers with. */
export type TurnstileRefusal = { error: string; status: number };

/**
 * A form's Turnstile check: null when it passed or the deployment has no Turnstile (no `siteKey`),
 * else what to tell the person. A site key without its secret refuses everything (and says so in
 * the log, with `unavailable` for the person), so a misconfigured deployment never quietly drops
 * the check.
 */
export async function checkTurnstileForm(
  input: {
    siteKey: string | null;
    secret: string | undefined;
    request: Request;
    form: FormData;
    action: TurnstileAction;
    /** Said when the deployment has a site key and no secret. */
    unavailable: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<TurnstileRefusal | null> {
  const { siteKey, secret, request, form, action } = input;
  if (!siteKey) return null;
  if (!secret) {
    console.error(
      JSON.stringify({
        type: 'turnstile_misconfigured',
        message:
          'TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not: every attempt is refused',
      }),
    );
    return { error: input.unavailable, status: 503 };
  }
  const token = form.get(TOKEN_FIELD);
  const result = await siteverify(
    {
      secret,
      token: typeof token === 'string' ? token : '',
      remoteip: request.headers.get('cf-connecting-ip') ?? undefined,
      action,
      // Each Worker answers only at its deployment's own host (a custom domain, no workers.dev),
      // so the host it was asked at is the one the widget must have run on.
      hostname: new URL(request.url).hostname,
    },
    fetcher,
  );
  if (result.ok) return null;
  console.log(JSON.stringify({ type: 'turnstile_refused', action, reason: result.reason }));
  if (result.reason === 'no-token')
    return { error: 'Complete the check above, then try again.', status: 400 };
  if (result.reason.startsWith('siteverify-'))
    return { error: 'We couldn’t confirm the check just now. Try again in a moment.', status: 503 };
  return { error: 'The check didn’t pass. Try it again.', status: 403 };
}

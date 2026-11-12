/**
 * The file Apple Pay's domain verification fetches, so a buyer on this host can use it in Safari:
 * `/.well-known/apple-developer-merchantid-domain-association`. The text is Stripe's, per account
 * (the owner downloads it from Stripe's dashboard and sets it as the engine's
 * `APPLE_PAY_DOMAIN_ASSOCIATION`); this Worker asks the engine for it and holds it a few minutes
 * per isolate, since anyone may ask here.
 */

import { engine } from './env.server';

export const APPLE_PAY_PATH = '/.well-known/apple-developer-merchantid-domain-association';

const KEEP_MS = 5 * 60_000;
let kept: { text: string | null; at: number } | null = null;

export async function applePayFile(): Promise<Response> {
  if (!kept || Date.now() - kept.at > KEEP_MS)
    kept = { text: await engine().applePayDomainAssociation(), at: Date.now() };
  if (!kept.text) return new Response('Not found', { status: 404 });
  return new Response(kept.text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

export const forgetApplePayFile = () => {
  kept = null;
};

import { env } from 'cloudflare:workers';
import {
  deriveAssistantPrincipalKey,
  isAssistantPrincipalPath,
} from '@commerceworker/security/assistant-key';
import {
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  signPrincipal,
  type WebPrincipal,
} from '@commerceworker/security/principal';
import type { Principal } from './roles';

/** A person as the gateway signs them: with the session the request came on, when there is one. */
export type SignedPrincipal = Principal & { sid?: string };

/**
 * Sets the signed principal header (`x-cw-principal`) on a request the web gateway forwards to
 * the api at `path`, replacing whatever the caller sent. The api checks it with the same
 * `PRINCIPAL_KEY` (`verifyPrincipal` in `@commerceworker/security`); it is good for 60 seconds and
 * for that exact path only. Local dev (`vite dev`) uses a fixed key when none is set.
 *
 * The assistant's paths (`/agents/*`) are signed with the key derived from it for the assistant
 * (`deriveAssistantPrincipalKey`), never with `PRINCIPAL_KEY` itself: the engine that hosts the
 * assistant holds only the derived key, and the api's REST surface verifies with the main one.
 */
export async function setPrincipalHeader(
  headers: Headers,
  p: SignedPrincipal,
  path: string,
  now = Date.now(),
) {
  const key = isAssistantPrincipalPath(path)
    ? await deriveAssistantPrincipalKey(principalKey())
    : principalKey();
  headers.set(PRINCIPAL_HEADER, await signPrincipal(key, webPrincipal(p), path, now));
}

/**
 * What the api is told about a person: who, how to name them, their deployment role, and the
 * session it came on (the assistant's socket outlives the request, and checks it is still live).
 */
export const webPrincipal = (p: SignedPrincipal): WebPrincipal => ({
  sub: p.id,
  email: p.email ?? '',
  name: p.name,
  role: p.role,
  ...(p.sid ? { sid: p.sid } : {}),
});

/**
 * The key that signs the principal header and the web app's own envelopes (the SSO flow and link
 * cookies). Throws when a deployment has none.
 */
export function principalKey() {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key) throw new Error('PRINCIPAL_KEY is not set: the api would refuse every forwarded call');
  // The dev key is public (it is in the repo): a deployed build that has it would let anyone sign
  // as anyone, so refuse rather than run.
  if (!import.meta.env.DEV && key === DEV_PRINCIPAL_KEY) {
    throw new Error('PRINCIPAL_KEY is the public development key: set a real one');
  }
  return key;
}

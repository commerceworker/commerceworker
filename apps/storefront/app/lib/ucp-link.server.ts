/**
 * UCP identity linking on the storefront: the authorization server a platform links a shopper
 * through, at this host (RFC 8414 metadata at its root; the consent page is `routes/identity-authorize.tsx`).
 * This Worker holds no code, token or link: the engine does, and answers each call
 * (`StorefrontRpc.ucpLink*`). What lives here is the HTTP: parsing a platform's token request
 * (client authentication by HTTP Basic or the form, RFC 6749 §2.3.1), its budgets (per caller
 * address before any credential is checked, per key after, never per the public `client_id`), and the headers an
 * OAuth response must carry (`no-store`, RFC 6749 §5.1). Only the SHA-256 of the platform's key
 * leaves this Worker.
 */

import { LINK_PATHS, type LinkTokenResult, UCP_PLATFORM_KEY_PREFIX } from '@commerceworker/core';
import { sha256Hex } from '@commerceworker/security/credentials';
import { engine } from './env.server';
import { overBudget } from './rate-limit';

/** The parameters of an authorization request, the only ones read from a query or a form. */
export const AUTHORIZE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;

/**
 * An authorization request's parameters from `source`, or null when any is repeated (RFC 6749 §3.1:
 * a parameter must not be). Anything else in it is dropped, so what is shown and what is posted
 * back is exactly this.
 */
export function authorizeParams(source: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of AUTHORIZE_PARAMS) {
    const all = source.getAll(name);
    if (all.length > 1) return null;
    if (all[0] !== undefined) out[name] = all[0];
  }
  return out;
}

/** What an OAuth answer is: never stored by a client or a proxy (RFC 6749 §5.1). */
const OAUTH_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache' };

const BODY_MAX = 8 * 1024;

const refuse = (status: number, error: string, description: string, headers: HeadersInit = {}) =>
  Response.json(
    { error, error_description: description },
    { status, headers: { ...OAUTH_HEADERS, ...headers } },
  );

/** A budget's 429 as an OAuth answer: its `Retry-After` kept, and never stored (RFC 6749 §5.1). */
const slowDown = (limited: Response) =>
  refuse(429, 'temporarily_unavailable', 'Too many requests. Wait and try again.', {
    'retry-after': limited.headers.get('retry-after') ?? '60',
  });

/** The request's client credentials: HTTP Basic (urlencoded id and secret) or the form's. */
function credentials(request: Request, form: URLSearchParams) {
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (basic) {
    try {
      const [id, secret] = atob(basic)
        .split(/:(.*)/s)
        .map((p) => decodeURIComponent(p.replaceAll('+', '%20')));
      return { id: id ?? null, secret: secret ?? null, basic: true };
    } catch {
      return { id: null, secret: null, basic: true };
    }
  }
  return { id: form.get('client_id'), secret: form.get('client_secret'), basic: false };
}

/**
 * The token or revocation endpoint: a form POST from a platform (not a browser, so ahead of the
 * cross-site check, as `/ucp` is). Refused here, before the engine is asked, are a wrong method
 * or content type, a body too large, repeated parameters, a client over its budget and
 * credentials that aren't a platform key's shape.
 */
export async function linkEndpoint(request: Request, kind: 'token' | 'revoke'): Promise<Response> {
  if (request.method !== 'POST')
    return refuse(405, 'invalid_request', 'Use POST.', { allow: 'POST' });
  if (
    !/^application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get('content-type') ?? '')
  )
    return refuse(415, 'invalid_request', 'Send application/x-www-form-urlencoded.');
  if (Number(request.headers.get('content-length') ?? 0) > BODY_MAX)
    return refuse(413, 'invalid_request', 'The request is too large.');
  const text = await request.text();
  if (text.length > BODY_MAX) return refuse(413, 'invalid_request', 'The request is too large.');
  const form = new URLSearchParams(text);
  const names = [...form.keys()];
  if (new Set(names).size !== names.length)
    return refuse(400, 'invalid_request', 'A parameter was repeated.');

  const client = credentials(request, form);
  // Before any credential is checked only the caller's own address is counted. A budget named by the
  // `client_id` (public: it's in every authorization link) would let anyone who knows it use up a
  // platform's budget and refuse its real redemptions and refreshes; the platform's own budget is
  // counted by its key's hash below, which only the holder of the key can name.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const early = await overBudget('AGENT_LIMIT', `identity:${ip}`);
  if (early) return slowDown(early);

  const challenge: Record<string, string> = client.basic
    ? { 'www-authenticate': 'Basic realm="identity"' }
    : {};
  if (!client.secret?.startsWith(UCP_PLATFORM_KEY_PREFIX))
    return refuse(
      401,
      'invalid_client',
      'Authenticate with the platform’s client id and API key.',
      challenge,
    );
  const keyHash = await sha256Hex(client.secret);
  const keyed = await overBudget('AGENT_LIMIT', `identity-key:${keyHash}`);
  if (keyed) return slowDown(keyed);
  const clientArg = { id: client.id, keyHash };
  const body: Record<string, string> = {};
  for (const [k, v] of form) if (k !== 'client_secret') body[k] = v;
  const answer: LinkTokenResult =
    kind === 'token'
      ? await engine().ucpLinkToken(body, clientArg)
      : await engine().ucpLinkRevoke(body, clientArg);
  return Response.json(answer.body, {
    status: answer.status,
    headers: { ...OAUTH_HEADERS, ...(answer.status === 401 ? challenge : {}) },
  });
}

/** RFC 8414 metadata: public, short-lived, 404 while agentic checkout is off. */
export async function linkMetadata(): Promise<Response> {
  const meta = await engine().ucpLinkMetadata();
  if (!meta)
    return Response.json(
      { error: 'not_found' },
      { status: 404, headers: { 'cache-control': 'public, max-age=60' } },
    );
  return Response.json(meta, { headers: { 'cache-control': 'public, max-age=300' } });
}

/** Whether `pathname` is one of the platform-facing endpoints, and which. */
export function linkEndpointOf(pathname: string): 'token' | 'revoke' | null {
  if (pathname === LINK_PATHS.token) return 'token';
  if (pathname === LINK_PATHS.revoke) return 'revoke';
  return null;
}

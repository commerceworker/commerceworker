/**
 * Who a REST request is and what answers it: an OAuth access token is checked by the OAuth role
 * (`apiOAuthFetch`); anything else is an API token or the browser session (`apiPrincipal`). The
 * two never mix: a request that carries an issued-looking bearer is never given the cookie's
 * session, whether or not the token turns out to be good.
 */

import { handleApi } from './api.server';
import { apiPrincipal, type Caller, setupDue, Throttled, TokenExpired } from './auth.server';
import { apiChallenge, apiOAuthFetch, hasIssuedToken } from './oauth.server';
import { overBudget } from './rate-limit';

export async function apiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const serve = async (caller: Caller) => {
    const due = setupDue(caller);
    if (due) return Response.json({ error: due }, { status: 403 });
    const limited = await overBudget('API_LIMIT', caller.id);
    if (limited) return limited;
    return handleApi(request, caller);
  };
  // An OAuth access token (granted for the API resource, and only that) is checked by the OAuth
  // role; `cmw_live_` tokens and sessions are resolved here, as ever.
  if (hasIssuedToken(request)) return apiOAuthFetch(request, env, ctx, serve);
  let caller: Awaited<ReturnType<typeof apiPrincipal>>;
  try {
    caller = await apiPrincipal(request);
  } catch (err) {
    if (err instanceof TokenExpired)
      return Response.json(
        { error: err.message },
        { status: 401, headers: { 'www-authenticate': apiChallenge(origin, true) } },
      );
    if (!(err instanceof Throttled)) throw err;
    return Response.json(
      { error: err.message },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!caller)
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'www-authenticate': apiChallenge(origin) } },
    );
  return serve(caller);
}

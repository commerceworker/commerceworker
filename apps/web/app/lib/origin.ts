/**
 * A REST API call carrying a bearer token, which the cross-site check lets through: with one,
 * `apiPrincipal` never reads the cookie, so there is nothing ambient to forge. Only under
 * `/api/v1/`: a page's action would still sign the caller in from the cookie.
 */
export function bearerApiCall(request: Request, url: URL): boolean {
  return (
    url.pathname.startsWith('/api/v1/') &&
    /^Bearer\s/i.test(request.headers.get('authorization') ?? '')
  );
}

/** Local development, the only place a deployment with no sign-in may run open. */
export function isLocalHost(url: URL): boolean {
  const h = url.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}
